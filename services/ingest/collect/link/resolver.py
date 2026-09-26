"""Kullanici linki cozumleme — orkestrasyon.

Kurallar (`docs/architecture.md` Katman 2, `docs/decisions/0004`):

  * YALNIZCA kullanici isteğiyle calisir. Zamanlanmis tarama yoktur.
  * YALNIZCA verilen URL getirilir. Sayfadaki linkler izlenmez; bu bir
    tarayici degil, tek adresli bir cozumleyicidir.
  * `robots.txt` dinlenir, atlatilmaz.
  * Sonuc CACHE DEGIL, kalici katalog kaydidir: `discovery_source = 'user_link'`.

Kataloğun talebe gore buyumesini saglayan mekanizma budur — butun internet
degil, insanlarin gercekten karsilastirdigi urunler indekslenir.

Guvenlik (docs/decisions/0035): adres kullanicidan gelir. Varsayilan istemci
`safe_http.guarded_client` — ic aga (localhost, RFC1918, metadata) giden her
baglanti soket acilmadan reddedilir; yonlendirmeler elle, adim adim denetlenir.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx
import psycopg

from collect.link import urls
from collect.link.extract import ExtractedProduct, extract
from collect.link.robots import USER_AGENT, RobotsCache, RobotsDisallowed
from collect.link.safe_http import (
    DEFAULT_POLICY,
    BlockedDestination,
    DestinationPolicy,
    check_url,
    guarded_client,
)
from collect.mapping import ValueFormats
from collect.records import NormalizedOffer, RecordRejected
from collect.writer import OfferWriter

logger = logging.getLogger(__name__)

#: Tek sayfa getirilir; buyuk bir dosyaya denk gelirsek erken vazgeciyoruz.
#: Govde AKIS olarak okunur, sinir asilinca kesilir — hic tam alinmaz.
MAX_BYTES = 2 * 1024 * 1024
#: Tek sayfanin toplam suresi (tum govde dahil). httpx'in okuma zaman asimi
#: parca basinadir; damla damla veren bir sunucu onu hic tetiklemez, bu tetikler.
FETCH_DEADLINE_SECONDS = 20.0
FETCH_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
#: Yonlendirmeler elle izlenir: her adimda adres ve robots yeniden denetlenir.
MAX_REDIRECTS = 5

HTML_TYPES = ("text/html", "application/xhtml+xml")

#: Kaynak kartinda gosterilecek fiyat YALNIZCA makine bicimindeyse: "2499",
#: "2499.90". "2.499,00" gibi yerel bicimli bir OpenGraph degeri belirsizdir
#: (nokta ondalik mi binlik mi?) — yanlis okunursa 2,50 TL gosterilir.
MACHINE_PRICE = re.compile(r"^\d+(?:\.\d{1,4})?$")

#: schema.org ve OpenGraph fiyatlari sartname geregi nokta ondaliklidir:
#: "1899.90". Bunlar makine icin yazilmis alanlardir.
SCHEMA_ORG_FORMATS = ValueFormats(decimal_separator=".", thousands_separator=",")

#: Son care katmani fiyati sayfanin GORUNEN metninden okur; o metin Turkce
#: bicimlidir: "1.249,50 TL". Ayni ayristiriciyi kullanmak 1249,50 TL'yi
#: 1,25 TL'ye cevirirdi.
DISPLAY_FORMATS = ValueFormats(decimal_separator=",", thousands_separator=".")


def price_formats(source_layer: str) -> ValueFormats:
    """Fiyat bicimini cikarim katmani belirler."""
    return DISPLAY_FORMATS if source_layer == "heuristic" else SCHEMA_ORG_FORMATS


class ResolutionFailed(Exception):
    """Cozumleme basarisiz.

    `code` kararli bir durum kodudur (`link_resolution_request.error_code`,
    liste `docs/schema.sql`'de); arayuz mesaji ona gore secer. Mesajin
    kendisi ayrintidir, kullaniciya dogrudan gosterilmez.
    """

    def __init__(self, message: str, code: str = "unexpected") -> None:
        super().__init__(message)
        self.code = code


@dataclass
class ResolvedLink:
    merchant_id: int | None
    merchant_created: bool
    #: Fiyatsiz referans sayfada `None`: kataloga offer yazilmaz, arama
    #: yalnizca sinyallerle yurur (docs/decisions/0035).
    offer_id: int | None
    offer_created: bool
    url: str
    external_id: str
    title: str
    price: int | None
    source_layer: str
    low_confidence: bool
    #: Arama sinyalleri — `link_resolution_request.source`. Yalnizca bulunanlar.
    signals: dict[str, Any] = field(default_factory=dict)
    #: Mutlak, http(s) kaynak gorsel adresi; yoksa `None`.
    image_url: str | None = None


def find_or_create_merchant(
    conn: psycopg.Connection, domain: str
) -> tuple[int, bool, dict[str, object]]:
    """Alan adindan merchant bulur; yoksa `user_discovered` olarak acar.

    Katalog talebe gore buyur: tanimadigimiz bir magazadan gelen link,
    o magazayi kataloga sokar. `affiliate_status` 'none' baslar — komisyon
    iliskisi ayri bir istir.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, refresh_minutes, feed_config FROM merchant WHERE domain = %s",
            (domain,),
        )
        row = cur.fetchone()
        if row is not None:
            return int(row[0]), False, {"refresh_minutes": row[1], "feed_config": row[2] or {}}

        slug = domain.replace(".", "-")
        cur.execute(
            """
            INSERT INTO merchant (slug, name, domain, source_type, affiliate_status, is_active)
            VALUES (%s, %s, %s, 'user_discovered', 'none', TRUE)
            RETURNING id, refresh_minutes
            """,
            (slug, domain, domain),
        )
        created = cur.fetchone()
    assert created is not None
    logger.info("yeni merchant acildi (user_discovered): %s", domain)
    return int(created[0]), True, {"refresh_minutes": created[1], "feed_config": {}}


@dataclass(frozen=True)
class FetchedPage:
    #: Yonlendirmelerden sonra varilan adres. Goreli gorsel adresleri buna gore cozulur.
    final_url: str
    html: str


def _status_failure(status: int) -> ResolutionFailed:
    if status in (404, 410):
        return ResolutionFailed(f"HTTP {status}", "not_found")
    if status in (401, 403):
        return ResolutionFailed(f"HTTP {status}", "access_denied")
    if status == 429:
        return ResolutionFailed("HTTP 429", "rate_limited")
    if status >= 500:
        return ResolutionFailed(f"HTTP {status}", "upstream_error")
    return ResolutionFailed(f"HTTP {status}", "http_error")


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc.rsplit('@', 1)[-1]}"


def _read_body(response: httpx.Response, deadline: float) -> bytes:
    declared = response.headers.get("content-length") or ""
    if declared.isdigit() and int(declared) > MAX_BYTES:
        raise ResolutionFailed(f"sayfa cok buyuk: {declared} bayt", "too_large")
    buffer = bytearray()
    for chunk in response.iter_bytes():
        buffer.extend(chunk)
        if len(buffer) > MAX_BYTES:
            raise ResolutionFailed(f"sayfa cok buyuk: {MAX_BYTES} bayti asti", "too_large")
        if time.monotonic() > deadline:
            raise ResolutionFailed("sayfa suresinde gelmedi", "timeout")
    return bytes(buffer)


def fetch_page(
    url: str,
    client: httpx.Client,
    *,
    robots: RobotsCache | None = None,
    max_redirects: int = MAX_REDIRECTS,
    deadline_seconds: float = FETCH_DEADLINE_SECONDS,
    policy: DestinationPolicy = DEFAULT_POLICY,
) -> FetchedPage:
    """Tek sayfayi sinirli bicimde getirir.

    Yonlendirmeler elle izlenir: HER adimda `check_url` (sema, kimlik
    bilgisi, ic ad, ozel IP literali) ve robots.txt yeniden denetlenir. IP
    duzeyindeki denetim istemcinin arka ucundadir (`safe_http.GuardedBackend`);
    test istemcileri onu atlar, bu dongu atlamaz.
    """
    deadline = time.monotonic() + deadline_seconds
    current = url
    try:
        for _ in range(max_redirects + 1):
            check_url(current, policy)
            if robots is not None and current != url:
                robots.check(_origin(current), current)

            with client.stream(
                "GET",
                current,
                headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"},
                follow_redirects=False,
            ) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise ResolutionFailed("yonlendirme adresi yok", "fetch_failed")
                    current = urljoin(current, location.strip())
                    continue
                if response.status_code != 200:
                    raise _status_failure(response.status_code)

                header = response.headers.get("content-type", "")
                media_type = header.split(";")[0].strip().lower()
                # Basliksiz yanit HTML olarak denenir (eski davranis); acikca
                # baska bir tur (PDF, gorsel, JSON...) reddedilir.
                if media_type and media_type not in HTML_TYPES:
                    raise ResolutionFailed(f"sayfa HTML degil: {media_type}", "unsupported_content")

                body = _read_body(response, deadline)
                encoding = response.charset_encoding or "utf-8"
                try:
                    html = body.decode(encoding, errors="replace")
                except LookupError:
                    html = body.decode("utf-8", errors="replace")
                return FetchedPage(final_url=current, html=html)
    except BlockedDestination as error:
        raise ResolutionFailed(str(error), "blocked_destination") from error
    except RobotsDisallowed as error:
        raise ResolutionFailed(str(error), "robots_disallowed") from error
    except httpx.TimeoutException as error:
        raise ResolutionFailed(f"zaman asimi: {type(error).__name__}", "timeout") from error
    except httpx.HTTPError as error:
        raise ResolutionFailed(f"getirilemedi: {type(error).__name__}", "fetch_failed") from error

    raise ResolutionFailed(f"{max_redirects} yonlendirmeden fazla", "too_many_redirects")


def absolute_image_url(image_url: str | None, page_url: str) -> str | None:
    """Goreli / sema-goreli gorsel adresini sayfaya gore cozer; yalnizca http(s)."""
    if not image_url:
        return None
    resolved = urljoin(page_url, image_url.strip())
    if urlsplit(resolved).scheme not in {"http", "https"}:
        return None
    return resolved


def search_signals(
    product: ExtractedProduct, *, domain: str, image_url: str | None
) -> dict[str, Any]:
    """`link_resolution_request.source`: YALNIZCA sayfada bulunan alanlar.

    Fiyat yalnizca yapilandirilmis katmandan (JSON-LD / OpenGraph) VE para
    birimiyle birlikte yazilir. Sezgisel katmanin fiyati kataloga
    `low_confidence` ile girer ama kaynak kartinda gosterilmez: gorunen
    metindeki bir sayi fiyat kaniti degildir.
    """
    signals: dict[str, Any] = {"site": domain, "extraction_layer": product.source_layer}
    for key in ("title", "brand", "category", "gtin", "mpn", "sku"):
        value = getattr(product, key)
        if value:
            signals[key] = str(value)[:500]
    if image_url:
        signals["image_url"] = image_url
    if product.in_stock is not None:
        signals["in_stock"] = product.in_stock

    price_text = (product.price_text or "").strip()
    if product.source_layer != "heuristic" and product.currency and MACHINE_PRICE.match(price_text):
        price = SCHEMA_ORG_FORMATS.parse_price(price_text)
        currency = product.currency.strip().upper()
        if price is not None and price > 0 and len(currency) == 3 and currency.isalpha():
            signals["price"] = price
            signals["currency"] = currency
    return signals


def to_offer(product: ExtractedProduct, normalized: urls.NormalizedUrl) -> NormalizedOffer:
    formats = price_formats(product.source_layer)
    price = formats.parse_price(product.price_text)
    if price is None:
        raise RecordRejected(f"fiyat cozumlenemedi: {product.price_text!r}")

    list_price = formats.parse_price(product.list_price_text)
    if list_price is not None and list_price < price:
        list_price = None

    attributes: dict[str, str] = {"extraction_layer": product.source_layer}
    if product.low_confidence:
        # Son care katmani. B4 ve arayuz bu farki gorebilmeli; yanlis fiyat
        # gostermek, fiyat gostermemekten kotudur.
        attributes["low_confidence"] = "true"
    if product.mpn:
        attributes["mpn"] = product.mpn
    if product.sku:
        attributes["sku"] = product.sku

    return NormalizedOffer(
        external_id=normalized.external_id,
        url=normalized.url,
        title_raw=product.title or normalized.external_id,
        current_price=price,
        list_price=list_price,
        in_stock=True if product.in_stock is None else product.in_stock,
        brand_raw=product.brand,
        category_raw=product.category,
        image_url=product.image_url,
        gtin=product.gtin,
        currency=(product.currency or "TRY").upper()[:3],
        attributes_raw=attributes,
        # Beden varyantlari JSON-LD'de guvenilir bicimde bulunmuyor;
        # user_link teklifleri varyantsiz yazilir.
        variants=(),
    )


def resolve_url(
    conn: psycopg.Connection,
    raw_url: str,
    *,
    client: httpx.Client | None = None,
    robots: RobotsCache | None = None,
    allow_reference: bool = False,
) -> ResolvedLink:
    """Tek bir URL'yi cozumler ve kataloga kalici olarak yazar.

    `allow_reference=True` (link aramasi worker'i): sayfa acikca bir urun ama
    fiyati yoksa kataloga hicbir sey yazilmaz, sinyaller yine de doner.
    Yenileme (`refresh.py`) varsayilanla cagirir: fiyat kaybolduysa bu bir
    hatadir, sessizce "cozuldu" sayilmaz.
    """
    normalized = urls.normalize(raw_url)

    http = client or guarded_client(user_agent=USER_AGENT, timeout=FETCH_TIMEOUT)
    robots_cache = robots or RobotsCache(client=client)

    try:
        check_url(normalized.url)
        # Once izin: getirmeden once soruyoruz.
        robots_cache.check(normalized.origin, normalized.url)
    except BlockedDestination as error:
        raise ResolutionFailed(str(error), "blocked_destination") from error
    except RobotsDisallowed as error:
        raise ResolutionFailed(str(error), "robots_disallowed") from error

    page = fetch_page(normalized.url, http, robots=robots_cache)
    product = extract(page.html, allow_reference=allow_reference)
    if product is None:
        raise ResolutionFailed("sayfadan urun bilgisi cikarilamadi", "no_product")

    # Kisaltici / baska alan adina yonlendirme: katalog kimligi VARILAN
    # sayfanin magazasina ait olmali, kisaltma servisinin degil.
    if page.final_url != normalized.url:
        landed = urls.normalize(page.final_url)
        if landed.domain != normalized.domain:
            normalized = landed

    image_url = absolute_image_url(product.image_url, page.final_url)
    product.image_url = image_url
    signals = search_signals(product, domain=normalized.domain, image_url=image_url)

    if not product.has_price:
        # Referans: kataloga yazilacak bir fiyat yok, uydurulmaz.
        return ResolvedLink(
            merchant_id=None,
            merchant_created=False,
            offer_id=None,
            offer_created=False,
            url=normalized.url,
            external_id=normalized.external_id,
            title=product.title or normalized.external_id,
            price=None,
            source_layer=product.source_layer,
            low_confidence=product.low_confidence,
            signals=signals,
            image_url=image_url,
        )

    merchant_id, merchant_created, _ = find_or_create_merchant(conn, normalized.domain)
    offer = to_offer(product, normalized)

    observed_at = datetime.now(UTC)
    writer = OfferWriter(
        conn,
        merchant_id=merchant_id,
        observed_at=observed_at,
        discovery_source="user_link",
    )
    offer_id = writer.write(offer)

    return ResolvedLink(
        merchant_id=merchant_id,
        merchant_created=merchant_created,
        offer_id=offer_id,
        offer_created=writer.counts.offers_created == 1,
        url=normalized.url,
        external_id=normalized.external_id,
        title=offer.title_raw,
        price=offer.current_price,
        source_layer=product.source_layer,
        low_confidence=product.low_confidence,
        signals=signals,
        image_url=image_url,
    )
