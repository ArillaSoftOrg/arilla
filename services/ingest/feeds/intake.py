"""Yonetici tarayicisindan toplanan kayitlari mevcut katalog modeline birlestirir (karar 0117).

TS tarafi yalnizca `catalog_intake_record` yazar; `offer`/`price_point` yazimi
BURADADIR ve mevcut `FeedSync` hattini yeniden kullanir (parmak izi ile degisiklik
tespiti, yalnizca degisen satir yazimi, `price_point` yalnizca yeni/degisen
fiyat-stok, `search_outbox`). Ayri bir yazma yolu yoktur.

Kural: kaynak tum katalogu degil taranan alt kumeyi verir. Beslemenin
`no_deactivate` ayari acik oldugundan EKSIK URUN HICBIR ZAMAN pasiflestirilmez;
guvenilir kaldirilma bilgisi yoksa urun durumu "belirsiz" kalir (son gorulme
zamani teklifte durur).
"""

from __future__ import annotations

import json
import logging
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import psycopg

from catalog_build.policy import hepsiburada_code_kind
from feeds.sync import FeedSync

logger = logging.getLogger(__name__)

NETWORK = "hbcollect"
FEED_EXTERNAL_ID = "hepsiburada"
MERCHANT_SLUG = "hepsiburada"

#: `feed_source.config`: alan adlari TOPLAYICIMIZIN yazdigi NDJSON anahtarlaridir.
FEED_CONFIG: dict[str, Any] = {
    "parser": "ndjson",
    "no_deactivate": True,
    "url_hosts": ["hepsiburada.com"],
    "mapping": {
        "id": "external_id",
        "title": "title",
        "url": "url",
        "price": "price",
        "old_price": "list_price",
        "currency": "currency",
        "category": "category",
        "images": "images",
        "available": "available",
        "brand": "brand",
        "gtin": "gtin",
        "seller": "seller",
        "mpn": "mpn_unused",
    },
    "keep_params": ["stock_state", "found_via", "variant"],
    "required_fields": ["external_id", "title", "url", "price", "currency"],
}

PENDING = """
SELECT id, external_id, title, url, price_minor, list_price_minor, currency, in_stock,
       image_url, brand, category_raw, seller_external_id, gtin, found_via, source_observed_at,
       seller_name, variant_label
  FROM catalog_intake_record
 WHERE run_id = %s AND merged_at IS NULL
 ORDER BY id
"""


#: Yanlis fiyat korumasi: mevcut teklifin fiyatindan bu kat ve ustu sapma otomatik
#: islenmez, `ingest_error` (`price_jump_held`) olarak incelemeye ayrilir. Liste fiyati ile
#: sepet/kampanya fiyatinin karismasi ya da ayristirma kaymasi boyle yakalanir.
MAX_PRICE_RATIO = 5


def price_jump(previous: int | None, new: int) -> bool:
    if not previous or previous <= 0:
        return False
    return new > previous * MAX_PRICE_RATIO or new * MAX_PRICE_RATIO < previous


#: Ayni kosunun iki birlestirmesi ayni anda calismaz (ikincisi bekletilmez, reddedilir).
MERGE_LOCK = "SELECT pg_try_advisory_lock(hashtextextended('hb_merge:' || %s::text, 0))"
MERGE_UNLOCK = "SELECT pg_advisory_unlock(hashtextextended('hb_merge:' || %s::text, 0))"

#: Kesif defteri (sitemap, 0073) ile BIREBIR kimlik: ayni kod VE ayni adres turu (`p`/`pm`).
#: Esleseni "liste fiyati goruldu" (`listing_price`) isaretler; fiyat degeri defterde
#: tutulmaz (teklifte durur). Tur farkli ise baglanmaz, yalnizca sayilir (karar 0130).
#: Sayfa ile dogrulanmis (`page_verified`) durum geri dusurulmez; eski gozlem yenisini ezmez.
MARK_DISCOVERY = """
WITH merged AS (
    SELECT t.ext, t.kind FROM unnest(%(exts)s::text[], %(kinds)s::text[]) AS t(ext, kind)
), hit AS (
    SELECT d.external_id, d.code_kind, m.kind
      FROM catalog_discovery d JOIN merged m ON m.ext = d.external_id
     WHERE d.source = %(source)s
), marked AS (
    UPDATE catalog_discovery d
       SET price_state = 'listing_price', price_checked_at = %(observed_at)s
      FROM hit h
     WHERE d.source = %(source)s AND d.external_id = h.external_id AND h.code_kind = h.kind
       AND d.price_state IN ('unpriced', 'listing_price', 'stale', 'unavailable')
       AND (d.price_checked_at IS NULL OR d.price_checked_at < %(observed_at)s)
    RETURNING 1
)
SELECT (SELECT count(*) FROM marked), (SELECT count(*) FROM hit WHERE code_kind <> kind)
"""


@dataclass
class MergeReport:
    run_id: int
    records: int = 0
    held: int = 0
    status: str = "nothing_to_merge"
    detail: dict[str, Any] | None = None
    #: Kesif defterinde birebir kimlikle `listing_price` isaretlenen satir.
    discovery_marked: int = 0
    #: Ayni kod defterde baska adres turuyle var: baglanmadi (dogrulanmamis iliski).
    discovery_kind_mismatch: int = 0


def seller_slug(name: str) -> str:
    """Kimliksiz satici adindan `name:<ascii-slug>`; ad kimlik degildir, etiketle ayrilir."""
    folded = name.casefold().translate(str.maketrans("ıçğöşü", "icgosu"))
    slug = re.sub(r"[^a-z0-9]+", "-", folded).strip("-")[:80]
    return f"name:{slug or 'unknown'}"


def _money(minor: int) -> str:
    return f"{minor // 100}.{minor % 100:02d}"


def to_feed_row(row: tuple[Any, ...]) -> dict[str, Any]:
    """Ara depo satiri -> NDJSON kaydi. Bilinmeyen alan eklenmez (uydurma yok)."""
    (
        _id,
        ext,
        title,
        url,
        price,
        list_price,
        currency,
        in_stock,
        image,
        brand,
        category,
        seller,
        gtin,
        found_via,
        _observed,
        seller_name,
        variant_label,
    ) = row
    record: dict[str, Any] = {
        "external_id": ext,
        "title": title,
        "url": url,
        "price": _money(int(price)),
        "currency": currency,
    }
    if list_price is not None:
        record["list_price"] = _money(int(list_price))
    if image:
        record["images"] = [image]
    if brand:
        record["brand"] = brand
    if category:
        record["category"] = category
    # Ana satici. Kaynak kimlik vermiyorsa ad, kararli bir ada-dayali anahtara cevrilir.
    seller_key = seller or (seller_slug(seller_name) if seller_name else None)
    if seller_key:
        record["seller"] = seller_key
    if gtin:
        record["gtin"] = gtin
    # Stok UC durumludur (karar 0130): available / unavailable / unknown. Stok bilinmiyorsa
    # "satista" DEMEYIZ: `offer.in_stock` NOT NULL oldugundan temkinli olarak false yazilir;
    # ayrim `attributes_raw.stock_state` ile tasinir ve arayuz "stokta yok" DEMEZ.
    # Anahtar HER kayitta yazilir: FeedSync `attributes_raw`'i birlestirir (`||`), eksik
    # anahtar onceki kosunun "unknown" degerini birakirdi.
    state = stock_state(in_stock)
    record["available"] = "true" if state == "available" else "false"
    param: dict[str, str] = {"stock_state": state}
    if found_via:
        param["found_via"] = found_via[:100]
    if variant_label:
        param["variant"] = variant_label[:100]
    record["param"] = param
    return record


def stock_state(in_stock: bool | None) -> str:
    """Ara depo stok alani -> `available` / `unavailable` / `unknown` (uydurma yok)."""
    if in_stock is None:
        return "unknown"
    return "available" if in_stock else "unavailable"


def ensure_feed(conn: psycopg.Connection) -> int:
    """Toplama beslemesi (yoksa 'paused' olusur; etkinlestirme yoneticinin kararidir)."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM merchant WHERE slug = %s", (MERCHANT_SLUG,))
        merchant = cur.fetchone()
        if merchant is None:
            raise RuntimeError("merchant_missing")
        cur.execute(
            """INSERT INTO feed_source (network, external_id, merchant_id, name, format, status,
                                        currency, market, config)
               VALUES (%s, %s, %s, 'Hepsiburada yonetici toplamasi', 'ndjson', 'active',
                       'TRY', 'TR', %s::jsonb)
               ON CONFLICT (network, external_id) DO UPDATE SET updated_at = feed_source.updated_at
               RETURNING id""",
            (NETWORK, FEED_EXTERNAL_ID, merchant[0], json.dumps(FEED_CONFIG)),
        )
        row = cur.fetchone()
    conn.commit()
    assert row is not None
    return int(row[0])


def _hold_price_jumps(
    conn: psycopg.Connection, feed_id: int, rows: list[tuple[Any, ...]]
) -> list[tuple[Any, ...]]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT o.external_id, o.current_price FROM offer o
                 JOIN feed_source f ON f.merchant_id = o.merchant_id
                WHERE f.id = %s AND o.external_id = ANY(%s)""",
            (feed_id, [r[1] for r in rows]),
        )
        previous = {ext: int(price) for ext, price in cur.fetchall() if price is not None}
    conn.rollback()
    held = [r for r in rows if price_jump(previous.get(r[1]), int(r[4]))]
    if held:
        with conn.cursor() as cur:
            for r in held:
                cur.execute(
                    """INSERT INTO ingest_error (feed_source_id, external_id, error_code, detail,
                                                 payload)
                       VALUES (%s, %s, 'price_jump_held', %s, %s::jsonb)""",
                    (
                        feed_id,
                        r[1],
                        f"onceki={previous[r[1]]} yeni={int(r[4])}",
                        json.dumps({"previous_minor": previous[r[1]], "new_minor": int(r[4])}),
                    ),
                )
        conn.commit()
    return held


def _name_sellers(conn: psycopg.Connection, feed_id: int, rows: list[tuple[Any, ...]]) -> None:
    """Satici adini yalniz BOS olan seller satirina yazar (kaynagin adi mevcut adi ezmez)."""
    names: dict[str, str] = {}
    for r in rows:
        name = r[15]
        key = r[11] or (seller_slug(name) if name else None)
        if key and name:
            names[key] = name[:300]
    if not names:
        return
    with conn.cursor() as cur:
        cur.executemany(
            """UPDATE seller s SET name = %s
                 FROM feed_source f
                WHERE f.id = %s AND s.merchant_id = f.merchant_id
                  AND s.external_id = %s AND s.name IS NULL""",
            [(name, feed_id, key) for key, name in names.items()],
        )
    conn.commit()


def mark_discovery(
    conn: psycopg.Connection,
    source: str,
    rows: list[tuple[Any, ...]],
    observed_at: datetime,
) -> tuple[int, int]:
    """(isaretlenen, tur_uyusmayan). Kimlik: kod + adres turu; ad benzerligi KULLANILMAZ."""
    pairs = [(str(r[1]), hepsiburada_code_kind(str(r[3]))) for r in rows]
    pairs = [(ext, kind) for ext, kind in pairs if kind is not None]
    if not pairs:
        return 0, 0
    with conn.cursor() as cur:
        cur.execute(
            MARK_DISCOVERY,
            {
                "source": source,
                "exts": [ext for ext, _ in pairs],
                "kinds": [kind for _, kind in pairs],
                "observed_at": observed_at,
            },
        )
        row = cur.fetchone()
    conn.commit()
    assert row is not None
    return int(row[0]), int(row[1])


def merge_run(conn: psycopg.Connection, run_id: int, *, require_closed: bool = True) -> MergeReport:
    """Kosuyu birlestirir. Idempotent: islenen kayit `merged_at` alir ve tekrar secilmez;
    `offer` `(merchant_id, external_id)` ile tekildir ve FeedSync degismeyen satiri yazmaz."""
    with conn.cursor() as cur:
        cur.execute(MERGE_LOCK, (run_id,))
        locked = cur.fetchone()
    conn.commit()
    if not locked or not locked[0]:
        raise RuntimeError("run_merge_in_progress")
    try:
        return _merge_run(conn, run_id, require_closed=require_closed)
    finally:
        conn.rollback()
        with conn.cursor() as cur:
            cur.execute(MERGE_UNLOCK, (run_id,))
        conn.commit()


def _merge_run(conn: psycopg.Connection, run_id: int, *, require_closed: bool) -> MergeReport:
    report = MergeReport(run_id)
    with conn.cursor() as cur:
        cur.execute("SELECT status, source FROM collection_run WHERE id = %s", (run_id,))
        run = cur.fetchone()
    conn.rollback()
    if run is None:
        raise RuntimeError("run_not_found")
    if require_closed and run[0] == "open":
        raise RuntimeError("run_still_open")
    with conn.cursor() as cur:
        cur.execute(PENDING, (run_id,))
        rows = cur.fetchall()
    conn.rollback()
    if not rows:
        return report
    feed_id = ensure_feed(conn)
    observed_at: datetime = max(r[14] for r in rows)
    held_rows = _hold_price_jumps(conn, feed_id, rows)
    report.held = len(held_rows)
    held_ids = {r[0] for r in held_rows}
    rows = [r for r in rows if r[0] not in held_ids]
    with tempfile.TemporaryDirectory(prefix="hbcollect-") as tmp:
        path = Path(tmp) / "intake.ndjson"
        with path.open("w", encoding="utf-8", newline="\n") as handle:
            for row in rows:
                handle.write(json.dumps(to_feed_row(row), ensure_ascii=False) + "\n")
        sync = FeedSync(conn, feed_id, source_path=path, observed_at=observed_at)
        result = sync.run(force=True)
    rows = rows + held_rows  # held satirlar da "islendi" (incelemeye ayrildi) sayilir
    report.records = len(rows)
    report.status = result.status
    report.detail = result.detail()
    if result.status in ("success", "duplicate"):
        _name_sellers(conn, feed_id, rows)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE catalog_intake_record SET merged_at = now()"
                " WHERE run_id = %s AND merged_at IS NULL AND id = ANY(%s)",
                (run_id, [int(r[0]) for r in rows]),
            )
        conn.commit()
        # Fiyat sicramasi yuzunden incelemeye ayrilanlar teklife yazilmadi: isaretlenmez.
        report.discovery_marked, report.discovery_kind_mismatch = mark_discovery(
            conn, str(run[1]), [r for r in rows if r[0] not in held_ids], observed_at
        )
    return report
