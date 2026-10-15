"""Yonetici tarayicisindan toplanan kayitlari katalog modeline birlestirir (karar 0117, 0118).

Kaynak basina ayar `SOURCES`: Hepsiburada (0117) ve Trendyol (0118). Kosunun kaynagi
`collection_run.source`tan okunur; ayni birlestirme hatti kullanilir.

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

#: Trendyol (karar 0118). Parmak izine giren `param` alanlari KOSUDAN KOSUYA SABITTIR
#: (degismeyen urun yeniden yazilmaz, gereksiz WAL yok): `found_via` gibi kesif izi YOK.
#: `basket_price` sepette uygulanan kosullu fiyattir; satis fiyati (`price`) DEGILDIR.
TRENDYOL_FEED_CONFIG: dict[str, Any] = {
    "parser": "ndjson",
    "no_deactivate": True,
    "url_hosts": ["trendyol.com"],
    "mapping": {**FEED_CONFIG["mapping"]},
    "keep_params": [
        "stock_state",
        "variant",
        "variant_id",
        "group_id",
        "basket_price",
    ],
    "required_fields": ["external_id", "title", "url", "price", "currency"],
    # Trendyol'dan stok TOPLANMAZ. Bilinmeyen stok "stokta yok" (false) yazilip urun aramada
    # cezalandirilmaz/"stokta yok" denmez: katalogun kullanilabilirlik bilgisi olmayan
    # beslemelerle ayni kurali (normalize: available yoksa in_stock=true) + stock_state=unknown.
    # Arayuz ve "stokta olanlar" filtresi stock_state=unknown'u "bilinmiyor" sayar.
    "unknown_stock_available": True,
    # Fiyat bedene aittir: onceki fiyat baska bedene aitse yeni fiyat yazilmaz, incelemeye ayrilir.
    "hold_variant_change": True,
}


@dataclass(frozen=True)
class IntakeSource:
    network: str
    feed_external_id: str
    merchant_slug: str
    feed_name: str
    config: dict[str, Any]


SOURCES: dict[str, IntakeSource] = {
    "hepsiburada": IntakeSource(
        NETWORK, FEED_EXTERNAL_ID, MERCHANT_SLUG, "Hepsiburada yonetici toplamasi", FEED_CONFIG
    ),
    "trendyol": IntakeSource(
        "tycollect", "trendyol", "trendyol", "Trendyol yonetici toplamasi", TRENDYOL_FEED_CONFIG
    ),
}

# Ilk 17 sutun 0070 ile ayni sirada; 0072 (Trendyol) alanlari SONA eklenir.
PENDING = """
SELECT id, external_id, title, url, price_minor, list_price_minor, currency, in_stock,
       image_url, brand, category_raw, seller_external_id, gtin, found_via, source_observed_at,
       seller_name, variant_label,
       image_urls, group_external_id, variant_external_id, basket_price_minor
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


def seller_slug(name: str) -> str:
    """Kimliksiz satici adindan `name:<ascii-slug>`; ad kimlik degildir, etiketle ayrilir."""
    folded = name.casefold().translate(str.maketrans("ıçğöşü", "icgosu"))
    slug = re.sub(r"[^a-z0-9]+", "-", folded).strip("-")[:80]
    return f"name:{slug or 'unknown'}"


def _money(minor: int) -> str:
    return f"{minor // 100}.{minor % 100:02d}"


def to_feed_row(row: tuple[Any, ...], *, unknown_stock_available: bool = False) -> dict[str, Any]:
    """Ara depo satiri -> NDJSON kaydi. Bilinmeyen alan eklenmez (uydurma yok).

    `unknown_stock_available` (Trendyol, 0118): stok bilinmiyorsa `available` true yazilir
    (katalogun stok bilgisi olmayan beslemelerdeki kurali) ve `stock_state=unknown` korunur.
    Varsayilan (Hepsiburada, 0117): false + `stock_state=unknown`.
    """
    # Ilk 17 sutun 0070 (Hepsiburada) sirasi; 0072 (Trendyol) alanlari SONDA.
    extended = row[17:]
    row = (*row[:17], *([None] * max(0, 17 - len(row))))
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
    param: dict[str, str] = {}
    # Stok bilinmiyorsa "satista" DEMEYIZ: mevcut modelde in_stock NOT NULL oldugundan
    # temkinli olarak false yazilir ve belirsizlik `stock_state` ile isaretlenir.
    if in_stock is None:
        record["available"] = "true" if unknown_stock_available else "false"
        param["stock_state"] = "unknown"
    else:
        record["available"] = "true" if in_stock else "false"
    if found_via:
        param["found_via"] = found_via[:100]
    if variant_label:
        param["variant"] = variant_label[:100]
    if extended:
        image_urls, group_id, variant_id, basket = (list(extended) + [None] * 4)[:4]
        if isinstance(image_urls, list) and image_urls:
            record["images"] = [u for u in image_urls if isinstance(u, str)][:6]
        if group_id:
            param["group_id"] = str(group_id)
        if variant_id:
            param["variant_id"] = str(variant_id)
        # Kosullu sepet fiyati satis fiyatindan AYRI tasinir; price/price_point'a girmez.
        if basket is not None and int(basket) < int(price):
            param["basket_price"] = _money(int(basket))
    if param:
        record["param"] = param
    return record


def ensure_feed(conn: psycopg.Connection, source: IntakeSource | None = None) -> int:
    """Toplama beslemesi (kaynak basina tek). Merchant onceden `ensure-merchant` ile olusur."""
    src = source or SOURCES["hepsiburada"]
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM merchant WHERE slug = %s", (src.merchant_slug,))
        merchant = cur.fetchone()
        if merchant is None:
            raise RuntimeError("merchant_missing")
        cur.execute(
            """INSERT INTO feed_source (network, external_id, merchant_id, name, format, status,
                                        currency, market, config)
               VALUES (%s, %s, %s, %s, 'ndjson', 'active', 'TRY', 'TR', %s::jsonb)
               ON CONFLICT (network, external_id) DO UPDATE SET updated_at = feed_source.updated_at
               RETURNING id""",
            (
                src.network,
                src.feed_external_id,
                merchant[0],
                src.feed_name,
                json.dumps(src.config),
            ),
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


VARIANT_INDEX = 19  # PENDING: 17 sutun (0070) + image_urls, group_external_id, variant_external_id


def _hold_variant_changes(
    conn: psycopg.Connection, feed_id: int, rows: list[tuple[Any, ...]]
) -> list[tuple[Any, ...]]:
    """Onceki fiyati BASKA bedene/varyanta ait urunun yeni fiyati yazilmaz (karar 0118).

    Fiyat gecmisi teklif duzeyindedir; beden degisince fiyat farki gercek bir fiyat degisimi
    degildir. Bu kayitlar `ingest_error` (`variant_changed_held`) ile incelemeye ayrilir.
    """
    with conn.cursor() as cur:
        cur.execute(
            """SELECT o.external_id, o.attributes_raw->>'variant_id' FROM offer o
                 JOIN feed_source f ON f.merchant_id = o.merchant_id
                WHERE f.id = %s AND o.external_id = ANY(%s)""",
            (feed_id, [r[1] for r in rows]),
        )
        previous = {ext: variant for ext, variant in cur.fetchall()}
    conn.rollback()

    def variant_of(r: tuple[Any, ...]) -> str | None:
        return str(r[VARIANT_INDEX]) if len(r) > VARIANT_INDEX and r[VARIANT_INDEX] else None

    held = [r for r in rows if r[1] in previous and previous[r[1]] != variant_of(r)]
    if held:
        with conn.cursor() as cur:
            for r in held:
                cur.execute(
                    """INSERT INTO ingest_error (feed_source_id, external_id, error_code, detail,
                                                 payload)
                       VALUES (%s, %s, 'variant_changed_held', %s, %s::jsonb)""",
                    (
                        feed_id,
                        r[1],
                        f"onceki_varyant={previous[r[1]]} yeni={variant_of(r)}",
                        json.dumps(
                            {"previous_variant": previous[r[1]], "new_variant": variant_of(r)}
                        ),
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
    source = SOURCES.get(str(run[1]))
    if source is None:
        raise RuntimeError("unknown_source")
    feed_id = ensure_feed(conn, source)
    observed_at: datetime = max(r[14] for r in rows)
    held_rows: list[tuple[Any, ...]] = []
    if source.config.get("hold_variant_change"):
        held_rows = _hold_variant_changes(conn, feed_id, rows)
        rows = [r for r in rows if r[0] not in {h[0] for h in held_rows}]
    held_rows += _hold_price_jumps(conn, feed_id, rows) if rows else []
    report.held = len(held_rows)
    held_ids = {r[0] for r in held_rows}
    rows = [r for r in rows if r[0] not in held_ids]
    unknown_stock_available = bool(source.config.get("unknown_stock_available"))
    status = "held"
    if rows:
        with tempfile.TemporaryDirectory(prefix=f"{source.network}-") as tmp:
            path = Path(tmp) / "intake.ndjson"
            with path.open("w", encoding="utf-8", newline="\n") as handle:
                for row in rows:
                    record = to_feed_row(row, unknown_stock_available=unknown_stock_available)
                    handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            sync = FeedSync(conn, feed_id, source_path=path, observed_at=observed_at)
            result = sync.run(force=True)
        status = result.status
        report.detail = result.detail()
    rows = rows + held_rows  # held satirlar da "islendi" (incelemeye ayrildi) sayilir
    report.records = len(rows)
    report.status = status
    if status in ("success", "duplicate"):
        _name_sellers(conn, feed_id, rows)
    # Tum kayitlar incelemeye ayrildiysa besleme calismaz; ayni satirlar tekrar tutulmasin.
    if status in ("success", "duplicate", "held"):
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE catalog_intake_record SET merged_at = now()"
                " WHERE run_id = %s AND merged_at IS NULL AND id = ANY(%s)",
                (run_id, [int(r[0]) for r in rows]),
            )
        conn.commit()
    return report
