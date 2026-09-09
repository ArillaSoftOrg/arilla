"""Kullanici linki cozumleme — orkestrasyon.

Kurallar (`docs/architecture.md` Katman 2, `docs/decisions/0004`):

  * YALNIZCA kullanici isteğiyle calisir. Zamanlanmis tarama yoktur.
  * YALNIZCA verilen URL getirilir. Sayfadaki linkler izlenmez; bu bir
    tarayici degil, tek adresli bir cozumleyicidir.
  * `robots.txt` dinlenir, atlatilmaz.
  * Sonuc CACHE DEGIL, kalici katalog kaydidir: `discovery_source = 'user_link'`.

Kataloğun talebe gore buyumesini saglayan mekanizma budur — butun internet
degil, insanlarin gercekten karsilastirdigi urunler indekslenir.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
import psycopg

from collect.link import urls
from collect.link.extract import ExtractedProduct, extract
from collect.link.robots import USER_AGENT, RobotsCache, RobotsDisallowed
from collect.mapping import ValueFormats
from collect.records import NormalizedOffer, RecordRejected
from collect.writer import OfferWriter

logger = logging.getLogger(__name__)

#: Tek sayfa getirilir; buyuk bir dosyaya denk gelirsek erken vazgeciyoruz.
MAX_BYTES = 2 * 1024 * 1024
FETCH_TIMEOUT = 20.0

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
    """Cozumleme basarisiz. Mesaj kullaniciya gosterilebilir."""


@dataclass
class ResolvedLink:
    merchant_id: int
    merchant_created: bool
    offer_id: int
    offer_created: bool
    url: str
    external_id: str
    title: str
    price: int
    source_layer: str
    low_confidence: bool


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


def fetch_page(url: str, client: httpx.Client) -> str:
    response = client.get(url, headers={"User-Agent": USER_AGENT})
    response.raise_for_status()

    content_type = response.headers.get("content-type", "")
    if content_type and "html" not in content_type.lower():
        raise ResolutionFailed(f"sayfa HTML degil: {content_type}")
    if len(response.content) > MAX_BYTES:
        raise ResolutionFailed("sayfa cok buyuk")
    return response.text


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
) -> ResolvedLink:
    """Tek bir URL'yi cozumler ve kataloga kalici olarak yazar."""
    normalized = urls.normalize(raw_url)

    http = client or httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=True)
    robots_cache = robots or RobotsCache(client=client)

    # Once izin: getirmeden once soruyoruz.
    try:
        robots_cache.check(normalized.origin, normalized.url)
    except RobotsDisallowed as error:
        raise ResolutionFailed(str(error)) from error

    html = fetch_page(normalized.url, http)
    product = extract(html)
    if product is None:
        raise ResolutionFailed("sayfadan urun bilgisi cikarilamadi")

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
        price=offer.current_price or 0,
        source_layer=product.source_layer,
        low_confidence=product.low_confidence,
    )
