"""Kaynak ust esleme ile ust kategori yazimi (karar 0161): parti parti, kontrol noktali.

Yalnizca `data/source_parent_map.tsv` icindeki `yuksek` satirlar yazilir; `inceleme` ve
`eslesmedi` yollari, haritada olmayan yollar ve kaynak yolu olmayan urunler kategorisiz kalir
(sayilir, yazilmaz). ALT KATEGORI YAZILMAZ (karar 0157: hibrit alt kategori olcumde %56 yanlis).

Urune dokunus SINIRLIDIR: yalnizca `category_id` (ve `updated_at`); YALNIZCA `category_id IS NULL`
olan urunlerde, eski degerle kosullu (arada baska yazar doldurduysa dokunulmaz). Mevcut deger
(insan, besleme, V5) asla ezilmez. Her yazim `product_classification`a `PARENT_RULE_VERSION`
surumu ve `detail = 'source_parent'` ile islenir; `undo` yalnizca bunlari geri alir.

Kontrol noktasi urun kimligiyle (`product_classification_state`, `scope = merchant:<slug>`):
sonradan gelen urunlerin kimligi daha buyuk oldugundan ayni komut onlari da kapsar. Inceleme
yolundaki urun imlecin gerisinde kalir; `--rescan` ile yeniden taranir.
"""

from __future__ import annotations

import logging
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import psycopg

from classify.run import (
    BUSY_CATALOG_BUILD,
    LOCK_KEY,
    LOCK_RETRIES,
    LOCK_RETRY_SLEEP_SECONDS,
    MAX_BATCH,
    OUTBOX,
    PARENT_DETAIL,
    PARENT_RULE_VERSION,
    RESET_STATE,
    SAVE_STATE,
    ClassifyAborted,
    Counts,
)
from classify.suggest.finalize import MAP_FILE, SourceParent, load_source_map
from classify.text import path_norm

logger = logging.getLogger(__name__)

DEFAULT_BATCH = 2_000
#: Kaynak ust kategorisi bir yapay zeka onerisidir (karar 0157): guven bilincli olarak dusuk.
CONFIDENCE = 70

_SOURCE_OF = """
  LEFT JOIN offer so ON so.id = p.source_offer_id
  LEFT JOIN LATERAL (
        SELECT o.category_raw
          FROM offer o
         WHERE p.source_offer_id IS NULL AND o.product_id = p.id
         ORDER BY o.id
         LIMIT 1) lo ON TRUE
"""

SELECT_BATCH = (
    """
SELECT p.id, COALESCE(so.category_raw, lo.category_raw)
  FROM product p
"""
    + _SOURCE_OF
    + """
 WHERE p.id > %(after)s
   AND p.source_merchant_id = %(merchant_id)s
   AND p.category_id IS NULL
 ORDER BY p.id
 LIMIT %(limit)s
"""
)

UPDATE_PRODUCTS = """
UPDATE product p SET category_id = t.cid, updated_at = now()
  FROM unnest(%(pids)s::bigint[], %(cids)s::bigint[]) AS t(pid, cid)
 WHERE p.id = t.pid AND p.category_id IS NULL
RETURNING p.id, p.publication_state
"""

#: Marka alanlari ve markaya ait yazim izi KORUNUR; yalniz kategori yarisi bu isin olur.
UPSERT_CLASSIFICATION = """
INSERT INTO product_classification AS pc
    (product_id, rule_version, state, brand_basis, category_id, category_basis, confidence,
     wrote_brand, wrote_category, detail)
SELECT t.pid, %(version)s::smallint, 'applied', 'none', t.cid, 'source',
       %(confidence)s::smallint, FALSE, TRUE, %(detail)s::text
  FROM unnest(%(pids)s::bigint[], %(cids)s::bigint[]) AS t(pid, cid)
ON CONFLICT (product_id) DO UPDATE SET
    rule_version = EXCLUDED.rule_version, state = 'applied',
    category_id = EXCLUDED.category_id, category_basis = 'source',
    confidence = EXCLUDED.confidence, wrote_category = TRUE, detail = EXCLUDED.detail,
    classified_at = now()
"""

#: Geri alma: bu isin yazdigi satirlar (kimlik imleciyle, parti parti).
SELECT_UNDO = """
SELECT pc.product_id, pc.category_id
  FROM product_classification pc
 WHERE pc.rule_version = %(version)s AND pc.wrote_category AND pc.detail = %(detail)s
   AND pc.product_id > %(after)s
 ORDER BY pc.product_id
 LIMIT %(limit)s
"""

UNDO_PRODUCTS = """
UPDATE product p SET category_id = NULL, updated_at = now()
  FROM unnest(%(pids)s::bigint[], %(cids)s::bigint[]) AS t(pid, cid)
 WHERE p.id = t.pid AND p.category_id = t.cid
RETURNING p.id, p.publication_state
"""

UNDO_CLASSIFICATION = """
UPDATE product_classification
   SET wrote_category = FALSE, category_id = NULL, category_basis = 'none', state = 'review',
       detail = 'source_parent_undone', classified_at = now()
 WHERE product_id = ANY(%(pids)s::bigint[]) AND rule_version = %(version)s
"""

REPORT_GROUPS = """
SELECT p.publication_state, so.category_raw, count(*)
  FROM product p
  JOIN offer so ON so.id = p.source_offer_id
 WHERE p.source_merchant_id = %(merchant_id)s AND p.category_id IS NULL
 GROUP BY 1, 2
"""

REPORT_GROUPS_NO_SOURCE_OFFER = """
SELECT p.publication_state, lo.category_raw, count(*)
  FROM product p
  LEFT JOIN LATERAL (
        SELECT o.category_raw FROM offer o WHERE o.product_id = p.id ORDER BY o.id LIMIT 1) lo
       ON TRUE
 WHERE p.source_merchant_id = %(merchant_id)s AND p.category_id IS NULL
   AND p.source_offer_id IS NULL
 GROUP BY 1, 2
"""


@dataclass
class ParentCounts(Counts):
    """`Counts` + kaynak durumuna gore ayrim (kategori kaniti sayaclari ayni alanlarda)."""

    reasons: Counter[str] = field(default_factory=Counter)


def load_parent_targets(path: Path = MAP_FILE) -> tuple[dict[str, str], dict[str, SourceParent]]:
    """(path_norm -> hedef kategori yolu [yalniz `yuksek`], tum harita)."""
    full = load_source_map(path)
    return {k: v.path for k, v in full.items() if v.state == "yuksek" and v.path}, full


def resolve_category_ids(conn: psycopg.Connection, targets: dict[str, str]) -> dict[str, int]:
    """Hedef yol -> kategori kimligi. Agacta olmayan yol varsa HICBIR sey yazilmaz."""
    with conn.cursor() as cur:
        cur.execute("SELECT id, path FROM category ORDER BY id")
        by_path: dict[str, int] = {}
        for i, p in cur.fetchall():
            by_path.setdefault(str(p), int(i))
    missing = sorted({p for p in targets.values() if p not in by_path})
    if missing:
        raise ClassifyAborted("category_missing", ", ".join(missing[:10]))
    return {p: by_path[p] for p in set(targets.values())}


def classify_source(
    category_raw: str | None,
    targets: dict[str, str],
    full: dict[str, SourceParent],
) -> tuple[str | None, str]:
    """(hedef yol | None, neden). Neden: parent | review | unmatched | unknown | no_source."""
    if not category_raw:
        return None, "no_source"
    key = path_norm(category_raw)
    if key in targets:
        return targets[key], "parent"
    entry = full.get(key)
    if entry is None:
        return None, "unknown"
    return None, "review" if entry.state == "inceleme" else "unmatched"


def _scope(conn: psycopg.Connection, merchant_slug: str) -> tuple[int, str]:
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM merchant WHERE slug = %s", (merchant_slug,))
        found = cur.fetchone()
    if found is None:
        raise ClassifyAborted("merchant_missing", merchant_slug)
    return int(found[0]), f"merchant:{merchant_slug}"


def _guard_and_lock(conn: psycopg.Connection, *, allow_concurrent_catalog_build: bool) -> None:
    with conn.cursor() as cur:
        cur.execute(BUSY_CATALOG_BUILD)
        busy = int(cur.fetchone()[0])  # type: ignore[index]
        if busy and not allow_concurrent_catalog_build:
            conn.rollback()
            raise ClassifyAborted("catalog_build_running", f"{busy} oturum")
        cur.execute("SELECT pg_try_advisory_lock(%s)", (LOCK_KEY,))
        if not bool(cur.fetchone()[0]):  # type: ignore[index]
            conn.rollback()
            raise ClassifyAborted("already_running")
    conn.commit()


def _unlock(conn: psycopg.Connection) -> None:
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(%s)", (LOCK_KEY,))
        conn.commit()
    except psycopg.Error:  # pragma: no cover
        pass


def _process_batch(
    conn: psycopg.Connection,
    rows: list[tuple[int, str | None]],
    targets: dict[str, str],
    full: dict[str, SourceParent],
    ids: dict[str, int],
) -> ParentCounts:
    counts = ParentCounts(scanned=len(rows))
    pids: list[int] = []
    cids: list[int] = []
    for pid, raw in rows:
        path, reason = classify_source(raw, targets, full)
        counts.reasons[reason] += 1
        counts.category_basis[reason] += 1
        if path is None:
            counts.review += 1
            if raw:
                counts.review_sources[path_norm(raw)] += 1
            continue
        pids.append(pid)
        cids.append(ids[path])
    if not pids:
        return counts
    with conn.cursor() as cur:
        cur.execute(UPDATE_PRODUCTS, {"pids": pids, "cids": cids})
        updated = {int(i): str(s) for i, s in cur.fetchall()}
    # Arada baska yazar kategori yazdiysa urun atlanir (ezilmez); izi yalniz yazilanlar alir.
    counts.errors += len(pids) - len(updated)
    won = [(p, c) for p, c in zip(pids, cids, strict=True) if p in updated]
    if won:
        with conn.cursor() as cur:
            cur.execute(
                UPSERT_CLASSIFICATION,
                {
                    "version": PARENT_RULE_VERSION,
                    "confidence": CONFIDENCE,
                    "detail": PARENT_DETAIL,
                    "pids": [p for p, _ in won],
                    "cids": [c for _, c in won],
                },
            )
        published = [p for p, _ in won if updated[p] == "published"]
        if published:
            with conn.cursor() as cur:
                cur.execute(OUTBOX, {"ids": published})
    counts.category_set = len(won)
    return counts


def apply_parents(
    conn: psycopg.Connection,
    *,
    merchant_slug: str = "aliexpress",
    batch_size: int = DEFAULT_BATCH,
    max_batches: int | None = None,
    max_seconds: float | None = None,
    sleep_seconds: float = 0.0,
    rescan: bool = False,
    after_id: int | None = None,
    allow_concurrent_catalog_build: bool = False,
    lock_timeout_ms: int = 3_000,
    map_path: Path = MAP_FILE,
    throttle: Callable[[], bool] | None = None,
    should_stop: Callable[[], bool] = lambda: False,
    on_batch: Callable[[Counts], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> ParentCounts:
    """Kontrol noktasindan devam eder. Salt okunur olcum icin `report` kullanilir."""
    batch_size = max(1, min(batch_size, MAX_BATCH))
    targets, full = load_parent_targets(map_path)
    merchant_id, scope = _scope(conn, merchant_slug)
    ids = resolve_category_ids(conn, targets)
    conn.commit()
    _guard_and_lock(conn, allow_concurrent_catalog_build=allow_concurrent_catalog_build)
    totals = ParentCounts()
    started = time.monotonic()
    try:
        with conn.cursor() as cur:
            if rescan:
                cur.execute(RESET_STATE, {"version": PARENT_RULE_VERSION, "scope": scope})
            cur.execute(
                """SELECT last_product_id FROM product_classification_state
                    WHERE rule_version = %s AND scope = %s""",
                (PARENT_RULE_VERSION, scope),
            )
            state = cur.fetchone()
        conn.commit()
        after = int(state[0]) if state else 0
        if after_id is not None:
            after = after_id
        totals.last_product_id = after
        lock_failures = 0
        while not should_stop():
            if max_batches is not None and totals.batches >= max_batches:
                break
            if max_seconds is not None and time.monotonic() - started >= max_seconds:
                break
            if throttle is not None and not throttle():
                totals.stopped_reason = "wal"
                break
            try:
                with conn.cursor() as cur:
                    cur.execute(f"SET LOCAL lock_timeout = '{int(lock_timeout_ms)}ms'")
                    cur.execute("SET LOCAL statement_timeout = '120s'")
                    cur.execute(
                        SELECT_BATCH,
                        {"after": after, "limit": batch_size, "merchant_id": merchant_id},
                    )
                    rows = [(int(r[0]), r[1]) for r in cur.fetchall()]
                done = len(rows) < batch_size
                last = rows[-1][0] if rows else after
                batch = _process_batch(conn, rows, targets, full, ids)
            except psycopg.errors.LockNotAvailable:
                conn.rollback()
                lock_failures += 1
                if lock_failures > LOCK_RETRIES:
                    raise ClassifyAborted(
                        "lock_timeout", "parti geri alindi; ayni komutla devam edin"
                    ) from None
                logger.warning("kilit zaman asimi, parti yeniden denenecek (%d)", lock_failures)
                sleep(LOCK_RETRY_SLEEP_SECONDS * lock_failures)
                continue
            lock_failures = 0
            with conn.cursor() as cur:
                cur.execute(
                    SAVE_STATE,
                    {
                        "version": PARENT_RULE_VERSION,
                        "scope": scope,
                        "last": last,
                        "scanned": batch.scanned,
                        "brand_set": 0,
                        "category_set": batch.category_set,
                        "review": batch.review,
                        "errors": batch.errors,
                        "completed_at": None,
                    },
                )
                if done:
                    cur.execute(
                        """UPDATE product_classification_state SET completed_at = now()
                            WHERE rule_version = %s AND scope = %s""",
                        (PARENT_RULE_VERSION, scope),
                    )
            conn.commit()
            after = last
            totals.add(batch)
            totals.reasons.update(batch.reasons)
            totals.batches += 1
            totals.last_product_id = after
            if on_batch:
                on_batch(totals)
            if done:
                totals.completed = True
                break
            if sleep_seconds:
                sleep(sleep_seconds)
    finally:
        _unlock(conn)
    return totals


def undo_parents(
    conn: psycopg.Connection,
    *,
    batch_size: int = DEFAULT_BATCH,
    max_batches: int | None = None,
    sleep_seconds: float = 0.0,
    allow_concurrent_catalog_build: bool = False,
    throttle: Callable[[], bool] | None = None,
    should_stop: Callable[[], bool] = lambda: False,
    sleep: Callable[[float], None] = time.sleep,
) -> Counts:
    """Yalnizca bu isin yazdigi kategorileri geri alir (urunde hala AYNI deger varsa).

    Baska yazarin sonradan degistirdigi kategoriye dokunmaz. `scanned` = izli satir,
    `category_set` = geri alinan urun sayisi.
    """
    batch_size = max(1, min(batch_size, MAX_BATCH))
    _guard_and_lock(conn, allow_concurrent_catalog_build=allow_concurrent_catalog_build)
    totals = Counts()
    after = 0
    try:
        while not should_stop():
            if max_batches is not None and totals.batches >= max_batches:
                break
            if throttle is not None and not throttle():
                totals.stopped_reason = "wal"
                break
            with conn.cursor() as cur:
                cur.execute("SET LOCAL lock_timeout = '3000ms'")
                cur.execute(
                    SELECT_UNDO,
                    {
                        "version": PARENT_RULE_VERSION,
                        "detail": PARENT_DETAIL,
                        "after": after,
                        "limit": batch_size,
                    },
                )
                picked = [(int(r[0]), int(r[1])) for r in cur.fetchall()]
            if picked:
                with conn.cursor() as cur:
                    cur.execute(
                        UNDO_PRODUCTS,
                        {"pids": [p for p, _ in picked], "cids": [c for _, c in picked]},
                    )
                    reverted = {int(i): str(s) for i, s in cur.fetchall()}
                    cur.execute(
                        UNDO_CLASSIFICATION,
                        {"pids": [p for p, _ in picked], "version": PARENT_RULE_VERSION},
                    )
                published = [p for p, state in reverted.items() if state == "published"]
                if published:
                    with conn.cursor() as cur:
                        cur.execute(OUTBOX, {"ids": published})
                totals.category_set += len(reverted)
            conn.commit()
            totals.scanned += len(picked)
            totals.batches += 1
            if len(picked) < batch_size:
                totals.completed = True
                break
            after = picked[-1][0]
            totals.last_product_id = after
            if sleep_seconds:
                sleep(sleep_seconds)
    finally:
        _unlock(conn)
    return totals


@dataclass
class ReportRow:
    state: str
    reason: str
    target: str | None
    source: str
    products: int


def report(
    conn: psycopg.Connection, *, merchant_slug: str = "aliexpress", map_path: Path = MAP_FILE
) -> list[ReportRow]:
    """YALNIZCA OKUR: kategorisiz urunlerin kaynak yoluna gore beklenen kapsami.

    Iki gruplama sorgusu (kaynak teklifli / kaynak teklifsiz); yazilirsa hangi hedef yola
    kac urunun gidecegi ve kac urunun neden kategorisiz kalacagi.
    """
    targets, full = load_parent_targets(map_path)
    merchant_id, _scope_name = _scope(conn, merchant_slug)
    resolve_category_ids(conn, targets)
    grouped: Counter[tuple[str, str | None]] = Counter()
    with conn.cursor() as cur:
        for sql in (REPORT_GROUPS, REPORT_GROUPS_NO_SOURCE_OFFER):
            cur.execute(sql, {"merchant_id": merchant_id})
            for state, raw, n in cur.fetchall():
                grouped[(str(state), None if raw is None else str(raw))] += int(n)
    conn.rollback()
    out: list[ReportRow] = []
    for (state, raw), n in grouped.items():
        path, reason = classify_source(raw, targets, full)
        out.append(ReportRow(state, reason, path, raw or "", n))
    return sorted(out, key=lambda r: (-r.products, r.source))
