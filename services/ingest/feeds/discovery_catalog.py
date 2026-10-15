"""Sitemap kesif defteri toplu isleri (karar 0120).

TS tarafi yalnizca `catalog_discovery` defterine yazar (kimlik, ad, gorsel, adres; FIYAT YOK).
Buradaki isler defteri mevcut katalog modeline baglar; ayri bir yazma yolu acmaz:

* ``link_prices``: `hb-merge` ile offer'a islenmis DOGRULANMIS kaynak kayitlarini (fiyatli) ayni
  urun koduyla defterdeki satira baglar. Kod birebir esit degilse baglanmaz (ad benzerligiyle
  eslestirme YOK). Fiyat degeri defterde tutulmaz; offer/price_point'tedir.
* ``publish``: kalite kosullarini saglayan kayitlari FIYATSIZ teklif (`current_price` NULL) olarak
  kataloga acar. Fiyat uydurulmaz; fiyat karsilastirmasi ve urun sayilari fiyatsiz teklifi zaten
  saymaz. Urun eslestirmesi cozumleyicinin isidir (karar 0119: yalnizca guclu kimlikle birlesme).
* ``finalize``: TAMAMLANMIS ve EKSIKSIZ haftalik taramadan sonra gorulmeyen urunleri isaretler.
  Bir urun ancak `removal_missed_scans` ardisik tam taramada gorulmezse `removed` olur; yarim
  tarama hicbir urunu etkilemez. Fiyat tazeligini yitiren kayitlar `stale` olur.

Her is parca parca (birincil anahtar araligi) ilerler; milyonlarca satir tek islemde
guncellenmez.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import psycopg

logger = logging.getLogger(__name__)

#: Dogrulanmis fiyat bu kadar gunden eskiyse `stale` (guncelmis gibi gosterilmez).
PRICE_FRESH_DAYS = 14
#: Yayinlama icin en kisa baslik: kisa/bos baslikli kayit kullaniciya deger sunmaz.
MIN_PUBLISH_TITLE = 10
#: Tek calistirmada yayinlanabilecek en fazla kayit (cozumleyici ve gomme maliyeti sinirli).
MAX_PUBLISH_LIMIT = 50_000
#: Birincil anahtar araligi parca boyutu.
CHUNK = 5_000
#: Tam tarama sayilmasi icin planlanan dosya sayisinin onceki tam taramaya orani alt siniri
#: (indeks beklenmedik sekilde kucuk geldiyse kaldirma degerlendirilmez).
MIN_PLAN_RATIO = 0.95

UNPRICED_ATTRIBUTES = {"price_state": "unpriced", "stock_state": "unknown", "found_via": "sitemap"}


# ---------------------------------------------------------------------------
# Fiyat baglama
# ---------------------------------------------------------------------------

LINK_PRICES = """
UPDATE catalog_discovery d
   SET price_state = 'verified', price_offer_id = o.id, price_source = %(price_source)s,
       price_checked_at = r.source_observed_at
  FROM catalog_intake_record r
  JOIN collection_run cr ON cr.id = r.run_id
  JOIN collection_source cs ON cs.source = cr.source
  JOIN merchant m ON m.slug = cs.merchant_slug
  JOIN offer o ON o.merchant_id = m.id AND o.external_id = r.external_id
 WHERE r.run_id = %(run_id)s
   AND r.merged_at IS NOT NULL
   AND o.current_price IS NOT NULL
   AND d.source = cr.source
   AND d.external_id = r.external_id
   AND (d.price_checked_at IS NULL OR d.price_checked_at < r.source_observed_at)
"""


def link_prices(
    conn: psycopg.Connection, run_id: int, *, price_source: str = "hb_collection"
) -> int:
    """Kosunun birlestirilmis kayitlarini defterdeki ayni kodlu urune baglar; baglanan sayisi."""
    with conn.cursor() as cur:
        cur.execute(LINK_PRICES, {"run_id": run_id, "price_source": price_source})
        linked = cur.rowcount
        cur.execute("SELECT source FROM collection_run WHERE id = %s", (run_id,))
        row = cur.fetchone()
    conn.commit()
    if linked and row:
        recount(conn, str(row[0]))
    return max(linked, 0)


# ---------------------------------------------------------------------------
# Sayaclar
# ---------------------------------------------------------------------------


def recount(conn: psycopg.Connection, source: str) -> dict[str, int]:
    """Panel sayaclarini defterden yeniden hesaplar (toplu is; istek yolunda calismaz)."""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT count(*),
                      count(*) FILTER (WHERE price_state = 'verified'),
                      count(*) FILTER (WHERE publish_state = 'published'),
                      count(*) FILTER (WHERE presence = 'removed')
                 FROM catalog_discovery WHERE source = %s""",
            (source,),
        )
        total, priced, published, removed = cur.fetchone() or (0, 0, 0, 0)
        cur.execute(
            """UPDATE catalog_discovery_tally
                  SET items_total = %s, items_priced = %s, items_published = %s,
                      items_removed = %s, recounted_at = now(), updated_at = now()
                WHERE source = %s""",
            (total, priced, published, removed, source),
        )
    conn.commit()
    return {"total": total, "priced": priced, "published": published, "removed": removed}


# ---------------------------------------------------------------------------
# Yayinlama
# ---------------------------------------------------------------------------


@dataclass
class PublishReport:
    source: str
    considered: int = 0
    created: int = 0
    linked_existing: int = 0
    dry_run: bool = False
    sample: list[str] = field(default_factory=list)


def _source_context(conn: psycopg.Connection, source: str) -> tuple[int, str]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT m.id, p.index_url
                 FROM discovery_source_policy p
                 JOIN collection_source cs ON cs.source = p.source
                 JOIN merchant m ON m.slug = cs.merchant_slug
                WHERE p.source = %s""",
            (source,),
        )
        row = cur.fetchone()
    conn.rollback()
    if row is None:
        raise RuntimeError("merchant_missing")
    parts = urlsplit(str(row[1]))
    return int(row[0]), f"{parts.scheme}://{parts.netloc}"


CANDIDATES = """
SELECT external_id, url_path, title, image_url
  FROM catalog_discovery
 WHERE source = %(source)s AND external_id > %(after)s
   AND publish_state = 'hidden' AND presence = 'present' AND missed_scans = 0
   AND title IS NOT NULL AND char_length(title) >= %(min_title)s
   AND image_url IS NOT NULL
 ORDER BY source, external_id
 LIMIT %(limit)s
"""

INSERT_OFFERS = """
WITH input AS (
    SELECT * FROM jsonb_to_recordset(%(rows)s::jsonb)
        AS t(external_id text, url text, title text, image_url text)
), ins AS (
    INSERT INTO offer (merchant_id, external_id, url, title_raw, image_url, current_price,
                       currency, in_stock, discovery_source, attributes_raw, is_active)
    SELECT %(merchant_id)s, external_id, url, title, image_url, NULL, 'TRY', FALSE, 'feed',
           %(attributes)s::jsonb, TRUE
      FROM input
    ON CONFLICT (merchant_id, external_id) DO NOTHING
    RETURNING id, external_id
), ob AS (
    INSERT INTO search_outbox (entity, entity_id, op, reason)
    SELECT 'offer', id, 'upsert', 'discovery_publish' FROM ins
    RETURNING 1
)
SELECT external_id, id, TRUE FROM ins
UNION ALL
SELECT o.external_id, o.id, FALSE
  FROM offer o JOIN input i ON i.external_id = o.external_id
 WHERE o.merchant_id = %(merchant_id)s
   AND NOT EXISTS (SELECT 1 FROM ins WHERE ins.external_id = o.external_id)
"""


def publish(
    conn: psycopg.Connection, source: str, *, limit: int, dry_run: bool = False
) -> PublishReport:
    """Kosullari saglayan kayitlari fiyatsiz teklif olarak acar; ayni kodlu teklife baglar."""
    if not 1 <= limit <= MAX_PUBLISH_LIMIT:
        raise ValueError(f"limit 1..{MAX_PUBLISH_LIMIT} olmali")
    report = PublishReport(source=source, dry_run=dry_run)
    merchant_id, origin = _source_context(conn, source)
    after = ""
    remaining = limit
    while remaining > 0:
        with conn.cursor() as cur:
            cur.execute(
                CANDIDATES,
                {
                    "source": source,
                    "after": after,
                    "min_title": MIN_PUBLISH_TITLE,
                    "limit": min(CHUNK, remaining),
                },
            )
            rows = cur.fetchall()
        if not rows:
            conn.rollback()
            break
        after = rows[-1][0]
        remaining -= len(rows)
        report.considered += len(rows)
        if dry_run:
            report.sample.extend(r[0] for r in rows[: max(0, 5 - len(report.sample))])
            conn.rollback()
            continue
        payload = [
            {"external_id": ext, "url": f"{origin}{path}", "title": title, "image_url": image}
            for ext, path, title, image in rows
        ]
        with conn.cursor() as cur:
            cur.execute(
                INSERT_OFFERS,
                {
                    "rows": json.dumps(payload, ensure_ascii=False),
                    "merchant_id": merchant_id,
                    "attributes": json.dumps(UNPRICED_ATTRIBUTES),
                },
            )
            linked = cur.fetchall()
            cur.executemany(
                """UPDATE catalog_discovery SET publish_state = 'published', offer_id = %s
                    WHERE source = %s AND external_id = %s AND publish_state = 'hidden'""",
                [(offer_id, source, ext) for ext, offer_id, _ in linked],
            )
        conn.commit()
        report.created += sum(1 for _, _, created in linked if created)
        report.linked_existing += sum(1 for _, _, created in linked if not created)
    if not dry_run and report.considered:
        recount(conn, source)
    return report


# ---------------------------------------------------------------------------
# Kaldirilma degerlendirmesi
# ---------------------------------------------------------------------------


@dataclass
class FinalizeReport:
    operation_id: int
    status: str = "skipped"
    reason: str = ""
    missing: int = 0
    removed: int = 0
    withdrawn: int = 0
    stale: int = 0
    detail: dict[str, Any] = field(default_factory=dict)


MARK_MISSING = """
WITH chunk AS (
    SELECT external_id FROM catalog_discovery
     WHERE source = %(source)s AND external_id > %(after)s
     ORDER BY source, external_id
     LIMIT %(chunk)s
), upd AS (
    UPDATE catalog_discovery d
       SET missed_scans = LEAST(d.missed_scans + 1, 32767),
           presence = CASE WHEN d.missed_scans + 1 >= %(threshold)s
                           THEN 'removed' ELSE 'missing' END
      FROM chunk
     WHERE d.source = %(source)s AND d.external_id = chunk.external_id
       AND d.last_seen_operation_id < %(op)s
       AND d.first_seen_operation_id < %(op)s
       AND d.presence <> 'removed'
    RETURNING d.presence
)
SELECT (SELECT max(external_id) FROM chunk),
       count(*) FILTER (WHERE presence = 'missing'),
       count(*) FILTER (WHERE presence = 'removed')
  FROM upd
"""

WITHDRAW = """
WITH w AS (
    UPDATE catalog_discovery d SET publish_state = 'withdrawn'
     WHERE d.source = %(source)s AND d.presence = 'removed' AND d.publish_state = 'published'
     RETURNING d.offer_id
), off AS (
    -- Yalnizca bizim actigimiz FIYATSIZ teklif pasiflesir; fiyatli teklifin yasam dongusu
    -- dogrulanmis kaynak hattindadir (hb-merge).
    UPDATE offer o SET is_active = FALSE, deactivated_at = now(),
                       deactivation_reason = 'source_removed'
      FROM w
     WHERE o.id = w.offer_id AND o.is_active AND o.current_price IS NULL
    RETURNING o.id
), ob AS (
    INSERT INTO search_outbox (entity, entity_id, op, reason)
    SELECT 'offer', id, 'delete', 'discovery_removed' FROM off
    RETURNING 1
)
SELECT (SELECT count(*) FROM w), (SELECT count(*) FROM off)
"""

MARK_STALE = """
UPDATE catalog_discovery SET price_state = 'stale'
 WHERE source = %(source)s AND price_state = 'verified'
   AND price_checked_at < now() - make_interval(days => %(days)s)
"""


def _previous_complete_plan(conn: psycopg.Connection, source: str, op_id: int) -> int | None:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT files_planned FROM catalog_sync_operation
                WHERE source = %s AND id < %s AND status = 'completed'
                  AND (summary->>'complete')::boolean IS TRUE
                ORDER BY id DESC LIMIT 1""",
            (source, op_id),
        )
        row = cur.fetchone()
    return int(row[0]) if row else None


def mark_stale(conn: psycopg.Connection, source: str, *, days: int = PRICE_FRESH_DAYS) -> int:
    with conn.cursor() as cur:
        cur.execute(MARK_STALE, {"source": source, "days": days})
        count = cur.rowcount
    conn.commit()
    return max(count, 0)


def finalize(conn: psycopg.Connection, operation_id: int) -> FinalizeReport:
    """Tamamlanmis TAM haftalik taramadan sonra kaldirilma degerlendirmesi (bir kez)."""
    report = FinalizeReport(operation_id)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT o.source, o.kind, o.status, o.removal_state, o.files_planned, o.summary,
                      p.removal_missed_scans
                 FROM catalog_sync_operation o
                 JOIN discovery_source_policy p ON p.source = o.source
                WHERE o.id = %s FOR UPDATE OF o""",
            (operation_id,),
        )
        row = cur.fetchone()
    if row is None:
        conn.rollback()
        raise RuntimeError("operation_not_found")
    source, kind, status, removal_state, files_planned, summary, threshold = row
    summary = summary or {}

    def close(state: str, reason: str) -> FinalizeReport:
        report.status = state
        report.reason = reason
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE catalog_sync_operation
                      SET removal_state = %s,
                          summary = COALESCE(summary, '{}'::jsonb) || %s::jsonb
                    WHERE id = %s""",
                (
                    state,
                    json.dumps(
                        {
                            "removal": {
                                "reason": reason,
                                "missing": report.missing,
                                "removed": report.removed,
                                "withdrawn": report.withdrawn,
                            }
                        }
                    ),
                    operation_id,
                ),
            )
        conn.commit()
        return report

    if kind != "weekly_refresh" or status != "completed" or removal_state != "pending":
        conn.rollback()
        report.reason = "not_pending"
        return report
    if summary.get("complete") is not True or summary.get("filesFailed"):
        return close("skipped_partial", "incomplete_scan")
    previous = _previous_complete_plan(conn, str(source), operation_id)
    if previous and files_planned < previous * MIN_PLAN_RATIO:
        return close("skipped_partial", "index_shrank")
    conn.commit()  # FOR UPDATE kilidini birak; parca parca ilerlenir.

    after = ""
    while True:
        with conn.cursor() as cur:
            cur.execute(
                MARK_MISSING,
                {
                    "source": source,
                    "after": after,
                    "chunk": CHUNK,
                    "threshold": int(threshold),
                    "op": operation_id,
                },
            )
            last, missing, removed = cur.fetchone() or (None, 0, 0)
        conn.commit()
        report.missing += int(missing or 0)
        report.removed += int(removed or 0)
        if last is None:
            break
        after = str(last)
    with conn.cursor() as cur:
        cur.execute(WITHDRAW, {"source": source})
        withdrawn, deactivated = cur.fetchone() or (0, 0)
    conn.commit()
    report.withdrawn = int(withdrawn or 0)
    report.detail["offers_deactivated"] = int(deactivated or 0)
    report.stale = mark_stale(conn, str(source))
    recount(conn, str(source))
    return close("done", "complete_scan")
