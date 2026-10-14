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
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import psycopg

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
    "keep_params": ["stock_state", "found_via"],
    "required_fields": ["external_id", "title", "url", "price", "currency"],
}

PENDING = """
SELECT id, external_id, title, url, price_minor, list_price_minor, currency, in_stock,
       image_url, brand, category_raw, seller_external_id, gtin, found_via, source_observed_at
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


@dataclass
class MergeReport:
    run_id: int
    records: int = 0
    held: int = 0
    status: str = "nothing_to_merge"
    detail: dict[str, Any] | None = None


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
    if seller:
        record["seller"] = seller
    if gtin:
        record["gtin"] = gtin
    param: dict[str, str] = {}
    # Stok bilinmiyorsa "satista" DEMEYIZ: mevcut modelde in_stock NOT NULL oldugundan
    # temkinli olarak false yazilir ve belirsizlik `stock_state` ile isaretlenir.
    if in_stock is None:
        record["available"] = "false"
        param["stock_state"] = "unknown"
    else:
        record["available"] = "true" if in_stock else "false"
    if found_via:
        param["found_via"] = found_via[:100]
    if param:
        record["param"] = param
    return record


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


def merge_run(conn: psycopg.Connection, run_id: int, *, require_closed: bool = True) -> MergeReport:
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
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE catalog_intake_record SET merged_at = now()"
                " WHERE run_id = %s AND merged_at IS NULL AND id = ANY(%s)",
                (run_id, [int(r[0]) for r in rows]),
            )
        conn.commit()
    return report
