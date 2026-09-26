"""Kesin urun kimligi zenginlestirmesi: varyant duzeyinde barkod (0030, 0032).

    python -m collect.identifiers --merchant korendy [--max-requests 200] [--force]

Shopify `/products.json` barkod tasimaz; ayni urunun herkese acik
`/products/<handle>.js` karsiligi her varyant icin `barcode` tasir.

**Nereye yazilir (0032).** Barkod ticari varyantin kimligidir:

- `offer_variant.gtin` (+ `gtin_source`): her boyut satirina kendi barkodu.
  Eslesme anahtari guclu olandan zayifa: varyant kimligi (`external_id` =
  Shopify varyant id), SKU, beden secenegi degeri. Dizi sirasi ASLA kullanilmaz.
- `offer.attributes_raw.gtin`: YALNIZCA offer tek ticari varyantsa (gruptaki
  tum varyantlar ayni gecerli barkodu tasiyorsa). Iki farkli boyut tek offer'da
  ise offer duzeyinde barkod YOKTUR — 0030'daki kural "gruptaki tek gecerli
  barkod" diyordu ve barkodu olmayan boyut yuzunden 100 ml'nin barkodunu 60 ml'yi
  de iceren offer'a yaziyordu. Bu yol eski yanlis degeri de temizler.
- `product.gtin`: urunun offer'larindaki TEK tutarli offer barkodu; celiskide NULL.

**Kapsam ve sinirlar (0023/0027 kaynak kurallari aynen gecerli):**

- Yalnizca bootstrap merchant'lari ve yalnizca BIRDEN FAZLA magazada gorulen
  markalarin offer'lari: karsi taraf yoksa barkod aranmaz. Toplu tarama degil.
- `robots.txt` dinlenir, sirali (eszamanlilik 1), <= 0.5 istek/sn (ya da
  sitenin Crawl-delay'i), yeniden deneme yok. 401/403/429 ya da robots yasagi:
  o magaza icin hemen durulur. Arka arkaya 3 sunucu/baglanti hatasi: durulur.
- Tazelik: `attributes_raw.identifiers_checked_at` TTL icindeyse (7 gun) urun
  yeniden istenmez. `--force` bunu yok sayar.
- Barkod yalnizca GS1 kontrol basamagi dogruysa yazilir; gecersiz deger hic
  saklanmaz, eslestirmeye giremez.

Ag kullanmadan: kontrol basamagi dogru SKU barkod sayilir (Vionine EAN'i
SKU'ya yaziyor) — varyant satirinin SKU'su o varyantin; offer SKU'su yalnizca
offer en fazla bir varyant satiri tasiyorsa offer'in barkodudur.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

import httpx
import psycopg

from collect.link.robots import USER_AGENT, RobotsCache, RobotsDisallowed
from db.connection import connect, database_url

logger = logging.getLogger(__name__)

MIN_INTERVAL_SECONDS = 2.0
FRESH_FOR = timedelta(days=7)
MAX_CONSECUTIVE_SERVER_ERRORS = 3

#: Birden fazla magazada gorulen markalarin offer'lari (tazelik Python'da).
CANDIDATES = """
WITH b AS (
    SELECT o.id, o.url, o.attributes_raw, m.slug,
           lower(regexp_replace(COALESCE(o.brand_raw, ''), '[^[:alnum:]]', '', 'g')) AS bn
      FROM offer o JOIN merchant m ON m.id = o.merchant_id
     WHERE o.is_active AND m.feed_config->>'bootstrap_source' = 'bootstrap_shopify'
)
SELECT b.id, b.url, b.attributes_raw
  FROM b
 WHERE b.slug = %(slug)s AND b.bn <> ''
   AND b.bn IN (SELECT bn FROM b WHERE bn <> '' GROUP BY bn HAVING count(DISTINCT slug) > 1)
 ORDER BY b.id
"""

VARIANT_ROWS = "SELECT id, external_id, sku, size_label FROM offer_variant WHERE offer_id = %s"

SET_VARIANT_GTIN = """
UPDATE offer_variant SET gtin = %(gtin)s, gtin_source = %(source)s
 WHERE id = %(id)s AND gtin IS DISTINCT FROM %(gtin)s
"""

#: Offer duzeyi barkod + kontrol zamani. `gtin` NULL ise anahtar SILINIR
#: (cok boyutlu offer'dan eski, yanlis barkod kalkar).
SET_OFFER_IDENTITY = """
UPDATE offer SET attributes_raw =
    CASE WHEN %(gtin)s::text IS NULL
         THEN (attributes_raw - 'gtin' - 'gtin_source')
         ELSE attributes_raw || jsonb_build_object('gtin', %(gtin)s::text,
                                                   'gtin_source', %(source)s::text)
    END || jsonb_build_object('identifiers_checked_at', %(checked_at)s::text)
 WHERE id = %(offer_id)s
"""

#: Urun barkodu = offer'larindaki TEK tutarli offer barkodu; yoksa ya da
#: celiskiliyse NULL. Yalnizca degisen satir yazilir.
SYNC_PRODUCT_GTIN = """
UPDATE product p SET gtin = agg.gtin, updated_at = now()
  FROM (
    SELECT p2.id AS product_id,
           CASE WHEN count(DISTINCT o.attributes_raw->>'gtin') = 1
                THEN min(o.attributes_raw->>'gtin') END AS gtin
      FROM product p2
      JOIN offer o ON o.product_id = p2.id AND o.is_active
     GROUP BY p2.id
  ) agg
 WHERE p.id = agg.product_id AND p.gtin IS DISTINCT FROM agg.gtin
"""


def gtin_valid(code: str | None) -> bool:
    """GS1 kontrol basamagi (GTIN-8/12/13/14)."""
    if not code or not code.isdigit() or len(code) not in {8, 12, 13, 14}:
        return False
    digits = [int(ch) for ch in code]
    body, check = digits[:-1], digits[-1]
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return (10 - total % 10) % 10 == check


def _clean(code: Any) -> str | None:
    value = str(code or "").strip()
    return value if gtin_valid(value) else None


def _option_index(options: Iterable[Any], names: Iterable[str]) -> int | None:
    wanted = {name.strip().lower() for name in names}
    for index, option in enumerate(options, start=1):
        name = option.get("name") if isinstance(option, dict) else option
        if str(name or "").strip().lower() in wanted:
            return index
    return None


def group_variants(
    product: dict[str, Any], color: str | None, color_option_names: Iterable[str]
) -> list[dict[str, Any]]:
    """Offer'in (renk grubu) Shopify varyantlari."""
    variants = [v for v in product.get("variants") or [] if isinstance(v, dict)]
    if color:
        index = _option_index(product.get("options") or [], color_option_names)
        if index is not None:
            variants = [v for v in variants if str(v.get(f"option{index}") or "") == color]
    return variants


def offer_barcode(variants: list[dict[str, Any]]) -> str | None:
    """Offer duzeyi barkod: gruptaki HER varyant ayni gecerli barkodu tasiyorsa.

    Bir varyant barkodsuz ya da barkodlar farkliysa offer birden fazla ticari
    varyanttir ya da kimligi belirsizdir: None. (0030'daki "tek gecerli
    barkod" kurali barkodsuz boyutu yok sayiyordu — 0032 duzeltmesi.)
    """
    codes = [_clean(v.get("barcode")) for v in variants]
    if not codes or any(code is None for code in codes):
        return None
    distinct = set(codes)
    return distinct.pop() if len(distinct) == 1 else None


def map_variant_barcodes(
    rows: list[tuple[int, str, str | None, str | None]],
    variants: list[dict[str, Any]],
    size_option_index: int | None,
) -> dict[int, str]:
    """`offer_variant` satiri -> barkod. Anahtar sirasi: varyant id, SKU,
    beden secenegi degeri. Birden fazla varyanta uyan zayif anahtar
    kullanilmaz; dizi sirasi hic kullanilmaz."""
    by_id = {str(v.get("id")): v for v in variants if v.get("id") is not None}

    def unique(matches: list[dict[str, Any]]) -> dict[str, Any] | None:
        return matches[0] if len(matches) == 1 else None

    result: dict[int, str] = {}
    for row_id, external_id, sku, size_label in rows:
        variant = by_id.get(str(external_id))
        if variant is None and sku:
            variant = unique([v for v in variants if str(v.get("sku") or "") == sku])
        if variant is None and size_label and size_option_index is not None:
            key = f"option{size_option_index}"
            variant = unique([v for v in variants if str(v.get(key) or "") == size_label])
        code = _clean(variant.get("barcode")) if variant else None
        if code:
            result[int(row_id)] = code
    return result


@dataclass
class IdentifierReport:
    slug: str
    candidates: int = 0
    skipped_fresh: int = 0
    requests: int = 0
    offer_gtins: int = 0
    variant_gtins: int = 0
    offers_without_single_identity: int = 0
    gtin_from_sku: int = 0
    stopped: str | None = None
    duration_seconds: float = 0.0


def enrich_from_sku(conn: psycopg.Connection, slug: str) -> int:
    """Ag yok: kontrol basamagi dogru SKU barkoddur.

    Varyant satirinin SKU'su o satirin barkodu; offer'in (temsilci varyant)
    SKU'su YALNIZCA offer'in en fazla bir varyant satiri varsa offer'in barkodu.
    """
    count = 0
    with conn.cursor() as cur:
        cur.execute(
            """SELECT ov.id, ov.sku FROM offer_variant ov
                 JOIN offer o ON o.id = ov.offer_id JOIN merchant m ON m.id = o.merchant_id
                WHERE m.slug = %s AND o.is_active AND ov.gtin IS NULL AND ov.sku IS NOT NULL""",
            (slug,),
        )
        for row_id, sku in cur.fetchall():
            code = _clean(sku)
            if code:
                cur.execute(SET_VARIANT_GTIN, {"gtin": code, "source": "sku", "id": row_id})
                count += cur.rowcount
        cur.execute(
            """SELECT o.id, o.attributes_raw->>'sku'
                 FROM offer o JOIN merchant m ON m.id = o.merchant_id
                WHERE m.slug = %s AND o.is_active AND NOT (o.attributes_raw ? 'gtin')
                  AND (SELECT count(*) FROM offer_variant ov WHERE ov.offer_id = o.id) <= 1""",
            (slug,),
        )
        for offer_id, sku in cur.fetchall():
            code = _clean(sku)
            if code:
                cur.execute(
                    """UPDATE offer SET attributes_raw = attributes_raw
                         || jsonb_build_object('gtin', %(gtin)s::text, 'gtin_source', 'sku')
                        WHERE id = %(offer_id)s""",
                    {"gtin": code, "offer_id": offer_id},
                )
                count += 1
    return count


def _is_fresh(attributes: dict[str, Any], now: datetime) -> bool:
    raw = attributes.get("identifiers_checked_at")
    if not raw:
        return False
    try:
        checked = datetime.fromisoformat(str(raw))
    except ValueError:
        return False
    return now - checked < FRESH_FOR


def enrich_from_products_js(
    conn: psycopg.Connection,
    slug: str,
    *,
    max_requests: int,
    client: httpx.Client,
    robots: RobotsCache,
    force: bool = False,
    sleep: Callable[[float], None] = time.sleep,
    now: datetime | None = None,
) -> IdentifierReport:
    report = IdentifierReport(slug=slug)
    started = time.monotonic()
    current = now or datetime.now(UTC)
    row = conn.execute("SELECT feed_config FROM merchant WHERE slug = %s", (slug,)).fetchone()
    shopify = (((row[0] if row else None) or {}).get("transport") or {}).get("shopify") or {}
    color_names = shopify.get("color_option_names") or ["Renk", "Color", "Colour"]
    size_names = shopify.get("size_option_names") or ["Beden", "Size", "Boyut", "Numara"]

    by_handle: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    for offer_id, url, attributes in conn.execute(CANDIDATES, {"slug": slug}).fetchall():
        attrs = attributes if isinstance(attributes, dict) else json.loads(attributes)
        report.candidates += 1
        if not force and _is_fresh(attrs, current):
            report.skipped_fresh += 1
            continue
        parts = urlsplit(url)
        by_handle.setdefault(f"{parts.scheme}://{parts.netloc}{parts.path}", []).append(
            (int(offer_id), attrs)
        )

    last = 0.0
    server_errors = 0
    for product_url, offers in by_handle.items():
        if report.requests >= max_requests:
            report.stopped = "istek tavani"
            break
        origin = "{0.scheme}://{0.netloc}".format(urlsplit(product_url))
        js_url = f"{product_url}.js"
        try:
            robots.check(origin, js_url)
        except RobotsDisallowed:
            report.stopped = "robots.txt yasakliyor"
            break
        interval = max(MIN_INTERVAL_SECONDS, robots.crawl_delay(origin) or 0.0)
        wait = interval - (time.monotonic() - last)
        if wait > 0:
            sleep(wait)
        last = time.monotonic()
        report.requests += 1
        try:
            response = client.get(js_url)
        except httpx.HTTPError as error:
            logger.warning("istek basarisiz %s: %s", js_url, type(error).__name__)
            server_errors += 1
            if server_errors >= MAX_CONSECUTIVE_SERVER_ERRORS:
                report.stopped = "arka arkaya baglanti/sunucu hatasi"
                break
            continue
        if response.status_code in {401, 403, 429}:
            report.stopped = f"magaza {response.status_code} dondu, duruldu"
            break
        if response.status_code >= 500:
            server_errors += 1
            if server_errors >= MAX_CONSECUTIVE_SERVER_ERRORS:
                report.stopped = "arka arkaya sunucu hatasi"
                break
            continue
        server_errors = 0
        if response.status_code != 200:
            continue
        try:
            product = response.json()
        except ValueError:
            continue
        size_index = _option_index(product.get("options") or [], size_names)
        for offer_id, attrs in offers:
            variants = group_variants(product, attrs.get("color"), color_names)
            rows = conn.execute(VARIANT_ROWS, (offer_id,)).fetchall()
            for row_id, code in map_variant_barcodes(rows, variants, size_index).items():
                with conn.cursor() as cur:
                    cur.execute(
                        SET_VARIANT_GTIN, {"gtin": code, "source": "products_js", "id": row_id}
                    )
                    report.variant_gtins += cur.rowcount
            code = offer_barcode(variants)
            if code:
                report.offer_gtins += 1
            else:
                report.offers_without_single_identity += 1
            conn.execute(
                SET_OFFER_IDENTITY,
                {
                    "gtin": code,
                    "source": "products_js",
                    "checked_at": current.isoformat(),
                    "offer_id": offer_id,
                },
            )
        conn.commit()
    report.duration_seconds = round(time.monotonic() - started, 1)
    return report


def sync_product_gtin(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(SYNC_PRODUCT_GTIN)
        return cur.rowcount


def enrich_merchant(
    conn: psycopg.Connection,
    slug: str,
    *,
    client: httpx.Client,
    robots: RobotsCache,
    max_requests: int = 300,
    network: bool = True,
    force: bool = False,
) -> IdentifierReport:
    """Tek magaza: SKU (agsiz) + products.js (agli) + urun barkodu esitlemesi.

    Istisna firlatabilir; cagiran (bootstrap) raporlayip bir sonraki magazaya
    gecer — zenginlestirme hatasi toplamayi dusurmez.
    """
    from_sku = enrich_from_sku(conn, slug)
    conn.commit()
    report = IdentifierReport(slug=slug)
    if network:
        report = enrich_from_products_js(
            conn, slug, max_requests=max_requests, client=client, robots=robots, force=force
        )
    report.gtin_from_sku = from_sku
    sync_product_gtin(conn)
    conn.commit()
    return report


def http_client() -> httpx.Client:
    return httpx.Client(timeout=20.0, follow_redirects=True, headers={"User-Agent": USER_AGENT})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="collect.identifiers")
    parser.add_argument("--merchant", action="append", required=True, help="merchant.slug")
    parser.add_argument("--max-requests", type=int, default=300, help="magaza basina tavan")
    parser.add_argument("--no-network", action="store_true", help="yalnizca SKU'dan barkod")
    parser.add_argument("--force", action="store_true", help="tazelik onbellegini yok say")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO)

    host = urlsplit(database_url()).hostname or ""
    if host not in {"localhost", "127.0.0.1", "::1"}:
        print("DATABASE_URL yerel degil; bootstrap zenginlestirmesi yalnizca yerelde calisir.")
        return 2

    client = http_client()
    robots = RobotsCache(client=client)
    with connect() as conn:
        for slug in args.merchant:
            report = enrich_merchant(
                conn,
                slug,
                client=client,
                robots=robots,
                max_requests=args.max_requests,
                network=not args.no_network,
                force=args.force,
            )
            print(json.dumps(asdict(report), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
