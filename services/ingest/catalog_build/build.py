"""Offer'lardan taslak urun uretimi (karar 0121): toplu, idempotent, kaldigi yerden.

Her parti TEK islemde: urun ekleme + kontrol noktasi. Cokme/durdurma sonrasi parti ya
tamamen vardir ya hic; kontrol noktasi (`catalog_build_state.last_offer_id`) partiyle
birlikte ilerler. Ikinci kosu ayni offer'lar icin yeni urun uretmez:
`(source_merchant_id, source_external_id)` benzersizdir ve `ON CONFLICT DO NOTHING`.

`offer` satirina YAZILMAZ. Taslak urun offer'a `offer.product_id` ile baglanmaz; bag
yayin aninda kurulur (`publish.py`). Fiyat, para birimi ve offer verisi oldugu gibi kalir.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import psycopg
from psycopg.types.json import Jsonb

from catalog_build.policy import (
    POLICIES,
    ProductDraft,
    SourceOffer,
    SourcePolicy,
    evaluate,
)

logger = logging.getLogger(__name__)

DEFAULT_BATCH = 5_000
MAX_BATCH = 20_000

SELECT_BATCH = """
SELECT o.id, o.external_id, o.url, o.title_raw, o.image_url, o.current_price, o.currency,
       o.is_active
  FROM offer o
 WHERE o.merchant_id = %(merchant_id)s AND o.id > %(after)s
 ORDER BY o.id
 LIMIT %(limit)s
"""

#: unnest ile tek ifade; benzersiz kaynak anahtarinda cakisan satir sessizce atlanir
#: (zaten urunu var). Baska bir benzersiz kisit (slug) cakisirsa ifade HATA verir ve
#: parti satir satir yeniden denenir (`_insert_rowwise`).
INSERT_DRAFTS = """
INSERT INTO product (slug, title, primary_image_url, source_merchant_id, source_external_id,
                     source_offer_id, publication_state)
SELECT t.slug, t.title, t.image, %(merchant_id)s, t.ext, t.oid, 'draft'
  FROM unnest(%(slugs)s::text[], %(titles)s::text[], %(images)s::text[],
              %(exts)s::text[], %(oids)s::bigint[]) AS t(slug, title, image, ext, oid)
ON CONFLICT (source_merchant_id, source_external_id) WHERE source_merchant_id IS NOT NULL
DO NOTHING
RETURNING source_external_id
"""

INSERT_ONE = """
INSERT INTO product (slug, title, primary_image_url, source_merchant_id, source_external_id,
                     source_offer_id, publication_state)
VALUES (%(slug)s, %(title)s, %(image)s, %(merchant_id)s, %(ext)s, %(oid)s, 'draft')
ON CONFLICT (source_merchant_id, source_external_id) WHERE source_merchant_id IS NOT NULL
DO NOTHING
RETURNING source_external_id
"""

LOAD_STATE = """
SELECT last_offer_id, completed_at FROM catalog_build_state WHERE merchant_id = %(merchant_id)s
"""

#: Sayaclar birikir; `skipped` neden bazinda toplanir.
SAVE_STATE = """
INSERT INTO catalog_build_state AS s
    (merchant_id, last_offer_id, scanned, created, existing, skipped, completed_at)
VALUES (%(merchant_id)s, %(last)s, %(scanned)s, %(created)s, %(existing)s, %(skipped)s,
        %(completed_at)s)
ON CONFLICT (merchant_id) DO UPDATE SET
    last_offer_id = EXCLUDED.last_offer_id,
    scanned       = s.scanned + EXCLUDED.scanned,
    created       = s.created + EXCLUDED.created,
    existing      = s.existing + EXCLUDED.existing,
    skipped       = (
        SELECT COALESCE(jsonb_object_agg(k, COALESCE((s.skipped->>k)::bigint, 0)
                                            + COALESCE((EXCLUDED.skipped->>k)::bigint, 0)),
                        '{}'::jsonb)
          FROM (SELECT jsonb_object_keys(s.skipped) AS k
                UNION SELECT jsonb_object_keys(EXCLUDED.skipped)) keys),
    updated_at    = now(),
    completed_at  = EXCLUDED.completed_at
"""

RESET_STATE = """
INSERT INTO catalog_build_state AS s (merchant_id) VALUES (%(merchant_id)s)
ON CONFLICT (merchant_id) DO UPDATE SET
    last_offer_id = 0, scanned = 0, created = 0, existing = 0, skipped = '{}'::jsonb,
    started_at = now(), updated_at = now(), completed_at = NULL
"""

MERCHANT_BY_SLUG = "SELECT id FROM merchant WHERE slug = %(slug)s"


@dataclass
class BuildCounts:
    scanned: int = 0
    created: int = 0
    existing: int = 0
    skipped: dict[str, int] = field(default_factory=dict)
    batches: int = 0
    last_offer_id: int = 0
    completed: bool = False

    def skip(self, reason: str, n: int = 1) -> None:
        self.skipped[reason] = self.skipped.get(reason, 0) + n


def merchant_id_for(conn: psycopg.Connection, slug: str) -> int:
    with conn.cursor() as cur:
        cur.execute(MERCHANT_BY_SLUG, {"slug": slug})
        row = cur.fetchone()
    if row is None:
        raise LookupError(f"merchant yok: {slug}")
    return int(row[0])


def _read_batch(
    conn: psycopg.Connection, merchant_id: int, after: int, limit: int
) -> list[SourceOffer]:
    with conn.cursor() as cur:
        cur.execute(SELECT_BATCH, {"merchant_id": merchant_id, "after": after, "limit": limit})
        rows = cur.fetchall()
    return [
        SourceOffer(
            offer_id=int(r[0]),
            external_id=str(r[1]),
            url=str(r[2]),
            title_raw=str(r[3]),
            image_url=r[4],
            current_price=None if r[5] is None else int(r[5]),
            currency=str(r[6]),
            is_active=bool(r[7]),
        )
        for r in rows
    ]


def _insert_rowwise(
    conn: psycopg.Connection, merchant_id: int, drafts: list[ProductDraft], counts: BuildCounts
) -> tuple[int, int]:
    """Toplu ekleme baska bir benzersiz kisitla (slug) dustuyse: satir basina SAVEPOINT.

    (eklenen, zaten var olan) doner; slug cakisanlar `slug_conflict` olarak sayilir.
    """
    created = 0
    existing = 0
    for draft in drafts:
        try:
            with conn.transaction(), conn.cursor() as cur:
                cur.execute(
                    INSERT_ONE,
                    {
                        "slug": draft.slug,
                        "title": draft.title,
                        "image": draft.image_url,
                        "merchant_id": merchant_id,
                        "ext": draft.external_id,
                        "oid": draft.offer_id,
                    },
                )
                if cur.fetchone() is not None:
                    created += 1
                else:
                    existing += 1
        except psycopg.errors.UniqueViolation:
            counts.skip("slug_conflict")
    return created, existing


def _insert_drafts(
    conn: psycopg.Connection, merchant_id: int, drafts: list[ProductDraft], counts: BuildCounts
) -> int:
    """Eklenen urun sayisi. Var olan kaynak anahtari (idempotent tekrar) `existing` sayilir."""
    if not drafts:
        return 0
    params = {
        "merchant_id": merchant_id,
        "slugs": [d.slug for d in drafts],
        "titles": [d.title for d in drafts],
        "images": [d.image_url for d in drafts],
        "exts": [d.external_id for d in drafts],
        "oids": [d.offer_id for d in drafts],
    }
    try:
        with conn.transaction(), conn.cursor() as cur:
            cur.execute(INSERT_DRAFTS, params)
            created = len(cur.fetchall())
        counts.existing += len(drafts) - created
        return created
    except psycopg.errors.UniqueViolation:
        created, existing = _insert_rowwise(conn, merchant_id, drafts, counts)
        counts.existing += existing
        return created


def _now(conn: psycopg.Connection):
    with conn.cursor() as cur:
        cur.execute("SELECT now()")
        row = cur.fetchone()
    assert row is not None
    return row[0]


def build_source_products(
    conn: psycopg.Connection,
    *,
    merchant_slug: str,
    batch_size: int = DEFAULT_BATCH,
    max_batches: int | None = None,
    max_seconds: float | None = None,
    rescan: bool = False,
    sleep_seconds: float = 0.0,
    should_stop: Callable[[], bool] = lambda: False,
    on_batch: Callable[[BuildCounts], None] | None = None,
    policy: SourcePolicy | None = None,
    dry_run: bool = False,
) -> BuildCounts:
    """Kontrol noktasindan devam eder; `rescan` basa alir (urunler yine tekrarlanmaz).

    `dry_run`: YALNIZCA OKUR (`SELECT`). Kontrol noktasina bakmaz, hicbir sey yazmaz;
    `created` urun olmaya UYGUN offer sayisidir ("olusturulurdu"). Uretimde guvenle
    calistirilabilir: dar `offer` taramasi, yazi yok.
    """
    batch_size = max(1, min(batch_size, MAX_BATCH))
    policy = policy or POLICIES.get(merchant_slug)
    merchant_id = merchant_id_for(conn, merchant_slug)
    started = time.monotonic()
    totals = BuildCounts()

    after = 0
    if not dry_run:
        with conn.cursor() as cur:
            if rescan:
                cur.execute(RESET_STATE, {"merchant_id": merchant_id})
            cur.execute(LOAD_STATE, {"merchant_id": merchant_id})
            state = cur.fetchone()
        conn.commit()
        after = int(state[0]) if state else 0
    totals.last_offer_id = after

    while True:
        if should_stop():
            break
        if max_batches is not None and totals.batches >= max_batches:
            break
        if max_seconds is not None and time.monotonic() - started >= max_seconds:
            break

        offers = _read_batch(conn, merchant_id, after, batch_size)
        batch = BuildCounts(scanned=len(offers))
        drafts: list[ProductDraft] = []
        for offer in offers:
            verdict = evaluate(offer, policy)
            if verdict.draft is not None:
                drafts.append(verdict.draft)
            else:
                assert verdict.skip is not None
                batch.skip(verdict.skip)

        last = offers[-1].offer_id if offers else after
        done = len(offers) < batch_size
        if dry_run:
            batch.created = len(drafts)
            conn.rollback()
        else:
            batch.created = _insert_drafts(conn, merchant_id, drafts, batch)
            with conn.cursor() as cur:
                cur.execute(
                    SAVE_STATE,
                    {
                        "merchant_id": merchant_id,
                        "last": last,
                        "scanned": batch.scanned,
                        "created": batch.created,
                        "existing": batch.existing,
                        "skipped": Jsonb(batch.skipped),
                        "completed_at": _now(conn) if done else None,
                    },
                )
            conn.commit()

        after = last
        totals.batches += 1
        totals.scanned += batch.scanned
        totals.created += batch.created
        totals.existing += batch.existing
        for reason, n in batch.skipped.items():
            totals.skip(reason, n)
        totals.last_offer_id = after
        if on_batch:
            on_batch(totals)
        if done:
            totals.completed = True
            break
        if sleep_seconds:
            time.sleep(sleep_seconds)
    return totals
