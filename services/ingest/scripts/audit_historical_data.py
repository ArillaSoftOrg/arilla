"""Gecmisten kalan veri sorunlarinin SALT OKUNUR taramasi (AI denetimi, PR #86).

    python scripts/audit_historical_data.py [--limit 25]

Hicbir sey yazmaz: baglanti `READ ONLY` islemde acilir, veritabani yazmayi reddeder.
Yalnizca SELECT calistirilir; her sorgu `statement_timeout` altindadir. Cikti yalnizca
sayilar ve teklif/urun kimlikleri + basliklaridir (kisisel veri yok).

Taramalar:

1. **Yanlis birlesmis urunler.** Ayni `product_id`'ye bagli, farkli teklif ciftleri YENI
   esleme kurallariyla (`resolve.score.combine`) puanlanir; veto edilenler (hacim 100/10 ml,
   model numarasi, kapasite, paket adedi, renk...) tarihsel yanlis birlesme adayidir. Sebep
   turune gore dagitilir. Duzeltme bu betigin isi DEGILDIR: `price_point` degismez,
   insan karari gerekir.
2. **Para birimi:** TRY disi ya da 3 buyuk harf bicimine uymayan.
3. **Dusuk guvenli link teklifleri** (`attributes_raw.low_confidence`): sezgisel katman fiyati.
4. **Supheli fiyat:** NULL/sifir/negatif/makul sinirin (10.000.000 TL) ustu guncel fiyat,
   liste fiyati guncelin 10 katindan fazla olan teklifler; `price_point` icin sifir/
   negatif/sinir ustu gozlem sayisi.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter, defaultdict

import psycopg

from db.connection import database_url
from resolve.normalize import ProductKey
from resolve.score import combine

#: Makul fiyat ust siniri, kurus (`collect.mapping.MAX_PRICE_KURUS` ile ayni deger).
MAX_PRICE_KURUS = 1_000_000_000
STATEMENT_TIMEOUT_MS = 120_000

SAME_PRODUCT_PAIRS = """
SELECT a.product_id, a.id, a.title_raw, a.brand_raw, a.attributes_raw->>'color',
       b.id, b.title_raw, b.brand_raw, b.attributes_raw->>'color'
  FROM offer a
  JOIN offer b ON b.product_id = a.product_id AND b.id > a.id
 WHERE a.product_id IS NOT NULL AND a.is_active AND b.is_active
"""

OFFER_TOTALS = """
SELECT count(*), count(*) FILTER (WHERE is_active),
       count(*) FILTER (WHERE product_id IS NOT NULL) FROM offer
"""

CURRENCY = """
SELECT currency, count(*), count(*) FILTER (WHERE is_active) FROM offer
 WHERE currency IS DISTINCT FROM 'TRY' GROUP BY currency ORDER BY 2 DESC
"""

BAD_CURRENCY_FORMAT = """
SELECT count(*) FROM offer WHERE currency !~ '^[A-Z]{3}$'
"""

LOW_CONFIDENCE = """
SELECT m.source_type, count(*), count(*) FILTER (WHERE o.is_active),
       count(*) FILTER (WHERE o.product_id IS NOT NULL)
  FROM offer o JOIN merchant m ON m.id = o.merchant_id
 WHERE o.attributes_raw->>'low_confidence' = 'true'
 GROUP BY m.source_type ORDER BY 2 DESC
"""

SUSPICIOUS_OFFER_PRICES = """
SELECT
  count(*) FILTER (WHERE current_price IS NULL),
  count(*) FILTER (WHERE current_price <= 0),
  count(*) FILTER (WHERE current_price > %(cap)s),
  count(*) FILTER (WHERE list_price IS NOT NULL AND current_price > 0
                     AND list_price > current_price * 10)
  FROM offer
"""

SUSPICIOUS_OFFER_EXAMPLES = """
SELECT id, title_raw, current_price, list_price FROM offer
 WHERE current_price <= 0 OR current_price > %(cap)s
    OR (list_price IS NOT NULL AND current_price > 0 AND list_price > current_price * 10)
 ORDER BY id LIMIT %(limit)s
"""

SUSPICIOUS_PRICE_POINTS = """
SELECT count(*), count(*) FILTER (WHERE price <= 0), count(*) FILTER (WHERE price > %(cap)s)
  FROM price_point
"""


def veto_category(reason: str) -> str:
    """'hacim: 100ml != 10ml' -> 'hacim'; 'sayisal kimlik: ...' -> 'sayisal kimlik'."""
    return reason.split(":", 1)[0].strip() or "diger"


def scan_merged_products(conn: psycopg.Connection, limit: int) -> int:
    with conn.cursor() as cur:
        cur.execute(SAME_PRODUCT_PAIRS)
        rows = cur.fetchall()
    suspects: dict[int, list[tuple[str, int, str, int, str]]] = defaultdict(list)
    by_category: Counter[str] = Counter()
    for product_id, a_id, a_title, a_brand, a_color, b_id, b_title, b_brand, b_color in rows:
        left = ProductKey.build(a_title, a_brand, a_color)
        right = ProductKey.build(b_title, b_brand, b_color)
        result = combine(left, right)
        if result.vetoed:
            reason = result.veto or ""
            by_category[veto_category(reason)] += 1
            suspects[int(product_id)].append((reason, int(a_id), a_title, int(b_id), b_title))
    print(f"[1] ayni urune bagli teklif cifti: {len(rows)}; veto edilen urun: {len(suspects)}")
    for category, count in by_category.most_common():
        print(f"    sebep '{category}': {count} cift")
    shown: Counter[str] = Counter()
    for product_id, items in sorted(suspects.items()):
        reason, a_id, a_title, b_id, b_title = items[0]
        category = veto_category(reason)
        if shown[category] >= max(1, limit // max(1, len(by_category))):
            continue
        shown[category] += 1
        print(f"    urun {product_id} ({len(items)} cift): {reason}")
        print(f"        offer {a_id}: {a_title[:80]}")
        print(f"        offer {b_id}: {b_title[:80]}")
    return len(suspects)


def scan_currency(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(OFFER_TOTALS)
        totals = cur.fetchone()
        cur.execute(CURRENCY)
        rows = cur.fetchall()
        cur.execute(BAD_CURRENCY_FORMAT)
        bad_format = cur.fetchone()
    if totals:
        print(f"[0] toplam teklif: {totals[0]} (aktif {totals[1]}, urune bagli {totals[2]})")
    total = sum(int(row[1]) for row in rows)
    print(f"[2] TRY disi (ya da NULL) para birimi: {total}")
    for currency, count, active in rows:
        print(f"    {currency}: {count} (aktif {active})")
    print(f"    3 buyuk harf bicimine uymayan: {int(bad_format[0]) if bad_format else 0}")
    return total


def scan_low_confidence(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(LOW_CONFIDENCE)
        rows = cur.fetchall()
    total = sum(int(row[1]) for row in rows)
    print(f"[3] dusuk guvenli (sezgisel katman) link teklifi: {total}")
    for source_type, count, active, linked in rows:
        print(f"    {source_type}: {count} (aktif {active}, urune bagli {linked})")
    return total


def scan_prices(conn: psycopg.Connection, limit: int) -> int:
    params = {"cap": MAX_PRICE_KURUS, "limit": limit}
    with conn.cursor() as cur:
        cur.execute(SUSPICIOUS_OFFER_PRICES, params)
        row = cur.fetchone()
        null_price, non_positive, over_cap, list_outlier = (int(v) for v in row or (0, 0, 0, 0))
        cur.execute(SUSPICIOUS_OFFER_EXAMPLES, params)
        examples = cur.fetchall()
    print("[4] supheli teklif fiyati:")
    print(f"    guncel fiyat NULL: {null_price}")
    print(f"    guncel fiyat <= 0: {non_positive}")
    print(f"    guncel fiyat > 10.000.000 TL: {over_cap}")
    print(f"    liste fiyati guncelin 10 katindan fazla: {list_outlier}")
    for offer_id, title, current, listed in examples:
        print(f"        offer {offer_id}: {str(title)[:60]} | fiyat {current} liste {listed}")
    suspicious_points = 0
    try:
        with conn.cursor() as cur:
            cur.execute(SUSPICIOUS_PRICE_POINTS, params)
            point_row = cur.fetchone()
        points, non_positive_points, over_cap_points = (int(v) for v in point_row or (0, 0, 0))
        suspicious_points = non_positive_points + over_cap_points
        print(
            f"    price_point: {points} gozlem; <= 0: {non_positive_points}; "
            f"> sinir: {over_cap_points}"
        )
    except psycopg.errors.QueryCanceled:
        # Zaman asimi veriyi etkilemez; islem iptal edildi, bu tarama atlandi.
        conn.rollback()
        enter_read_only(conn)
        print("    price_point taramasi zaman asimina ugradi (atlandi)")
    return null_price + non_positive + over_cap + list_outlier + suspicious_points


class NotReadOnlyError(RuntimeError):
    """Baglanti salt okunur olarak dogrulanamadi: hicbir tarama calistirilmaz."""


def enter_read_only(conn: psycopg.Connection) -> None:
    """Islemi salt okunur yapar ve DOGRULAR; dogrulanamazsa durur.

    Havuzlayicilar (pgbouncer/Supavisor) baslangic parametrelerini (`options`) yok
    sayabilir; bu yuzden asil koruma islem duzeyindeki `SET TRANSACTION READ ONLY`dir.
    """
    conn.execute("SET TRANSACTION READ ONLY")
    row = conn.execute("SHOW transaction_read_only").fetchone()
    if not row or row[0] != "on":
        raise NotReadOnlyError("transaction_read_only dogrulanamadi; tarama calistirilmadi")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--limit", type=int, default=25, help="listelenecek en fazla ornek")
    args = parser.parse_args(argv)
    # Veritabani yazmayi reddeder: oturum varsayilani ve islem ayri ayri salt okunur.
    url = database_url("DATABASE_URL")
    options = f"-c default_transaction_read_only=on -c statement_timeout={STATEMENT_TIMEOUT_MS}"
    with psycopg.connect(url, options=options) as conn:
        enter_read_only(conn)
        scan_merged_products(conn, args.limit)
        scan_currency(conn)
        scan_low_confidence(conn)
        scan_prices(conn, args.limit)
        conn.rollback()
    return 0


if __name__ == "__main__":
    sys.exit(main())
