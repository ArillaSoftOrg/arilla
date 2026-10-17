"""Kesif defterinden (sitemap, fiyatsiz) taslak urun aktarimi (karar 0129).

`catalog_discovery` (0073) satiri `offer` DEGILDIR ve fiyati yoktur. Buradan yalnizca
`draft` urun uretilir; `source_offer_id` NULL kalir, hicbir `offer`/`price_point` satiri
acilmaz ve fiyat uydurulmaz. Kalite kapisi (`gate.py`) bu urunleri teklif olmadigi icin
`held(source_offer_missing)` tutar: YAYINA CIKAMAZ. Ayni magaza + ayni kod + ayni adres
turunde fiyatli teklif gelince `build.py` bagi kurar, kapi `ready` yapar, yayin yine acik
komut ister.

Kimlik: `product (source_merchant_id, source_external_id)` (0074, benzersiz). Teklif hattiyla
AYNI anahtar; iki hat ayni urunu iki kez acamaz. `-p-` ve `-pm-` kodlari birbirine
baglanmaz; ad benzerligiyle birlestirme yoktur.

Parti + kontrol noktasi (`catalog_discovery_build_state`) tek islemde; kaldigi yerden surer.
Defter yuz milyon satira buyuyebilir: tarama birincil anahtar sirasiyla, her kosu acik bir
ust sinir (`limit`) ister.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

import psycopg
from psycopg.types.json import Jsonb

from catalog_build.build import BuildCounts, _insert_drafts, merchant_id_for
from catalog_build.policy import (
    POLICIES,
    ProductDraft,
    SourcePolicy,
    clean_title,
    image_problem,
    source_slug,
    title_problem,
)

DEFAULT_BATCH = 5_000
MAX_BATCH = 20_000

SELECT_BATCH = """
SELECT d.external_id, d.code_kind, d.url, d.title, d.image_url
  FROM catalog_discovery d
 WHERE d.source = %(source)s AND d.external_id > %(after)s
 ORDER BY d.external_id
 LIMIT %(limit)s
"""

#: Teklif hattindan dogmus urunun kaynak teklif adresi baska turdeyse (`-p-` / `-pm-`)
#: ayni kod ayni urun SAYILMAZ: cakisma sayilir, taslak acilmaz.
KIND_CONFLICTS = """
SELECT t.ext
  FROM unnest(%(exts)s::text[], %(kinds)s::text[]) AS t(ext, kind)
  JOIN product p ON p.source_external_id = t.ext AND p.source_merchant_id = %(merchant_id)s
  JOIN offer o ON o.id = p.source_offer_id
 WHERE right(o.url, char_length(t.kind) + char_length(t.ext) + 2) <> '-' || t.kind || '-' || t.ext
"""

LOAD_STATE = """
SELECT last_external_id FROM catalog_discovery_build_state WHERE source = %(source)s
"""

SAVE_STATE = """
INSERT INTO catalog_discovery_build_state AS s
    (source, last_external_id, scanned, created, existing, skipped, completed_at)
VALUES (%(source)s, %(last)s, %(scanned)s, %(created)s, %(existing)s, %(skipped)s,
        CASE WHEN %(done)s THEN now() END)
ON CONFLICT (source) DO UPDATE SET
    last_external_id = EXCLUDED.last_external_id,
    scanned          = s.scanned + EXCLUDED.scanned,
    created          = s.created + EXCLUDED.created,
    existing         = s.existing + EXCLUDED.existing,
    skipped          = (
        SELECT COALESCE(jsonb_object_agg(k, COALESCE((s.skipped->>k)::bigint, 0)
                                            + COALESCE((EXCLUDED.skipped->>k)::bigint, 0)),
                        '{}'::jsonb)
          FROM (SELECT jsonb_object_keys(s.skipped) AS k
                UNION SELECT jsonb_object_keys(EXCLUDED.skipped)) keys),
    updated_at       = now(),
    completed_at     = EXCLUDED.completed_at
"""

RESET_STATE = """
INSERT INTO catalog_discovery_build_state AS s (source) VALUES (%(source)s)
ON CONFLICT (source) DO UPDATE SET
    last_external_id = '', scanned = 0, created = 0, existing = 0, skipped = '{}'::jsonb,
    started_at = now(), updated_at = now(), completed_at = NULL
"""


@dataclass(frozen=True)
class DiscoveryRow:
    external_id: str
    code_kind: str
    url: str
    title: str | None
    image_url: str | None


@dataclass(frozen=True)
class DiscoveryVerdict:
    draft: ProductDraft | None
    skip: str | None


@dataclass
class DiscoveryBuildCounts(BuildCounts):
    last_external_id: str = ""


def evaluate_discovery(row: DiscoveryRow, policy: SourcePolicy) -> DiscoveryVerdict:
    """Fiyat aranmaz (yoktur); kimlik, baslik ve gorsel teklif hattiyla ayni kurallardan."""
    if not policy.id_pattern.match(row.external_id):
        return DiscoveryVerdict(None, "source_id_invalid")
    match = policy.url_pattern.match(row.url)
    kind = policy.url_kind(row.url) if policy.url_kind else None
    if match is None or match.group(1) != row.external_id or kind != row.code_kind:
        return DiscoveryVerdict(None, "source_id_url_mismatch")
    # Sitemap'te ad olmayabilir; ad uydurulmaz, urun acilmaz.
    title = clean_title(row.title or "")
    problem = title_problem(title) if title else "no_title"
    if problem:
        return DiscoveryVerdict(None, problem)
    image_issue = image_problem(row.image_url)
    if image_issue:
        return DiscoveryVerdict(None, image_issue)
    assert row.image_url is not None
    return DiscoveryVerdict(
        ProductDraft(
            offer_id=None,
            external_id=row.external_id,
            slug=source_slug(title, row.external_id),
            title=title,
            image_url=row.image_url.strip(),
        ),
        None,
    )


def _read_batch(
    conn: psycopg.Connection, source: str, after: str, limit: int
) -> list[DiscoveryRow]:
    with conn.cursor() as cur:
        cur.execute(SELECT_BATCH, {"source": source, "after": after, "limit": limit})
        rows = cur.fetchall()
    return [
        DiscoveryRow(
            external_id=str(r[0]), code_kind=str(r[1]), url=str(r[2]), title=r[3], image_url=r[4]
        )
        for r in rows
    ]


def _kind_conflicts(
    conn: psycopg.Connection, merchant_id: int, pairs: list[tuple[str, str]]
) -> set[str]:
    if not pairs:
        return set()
    with conn.cursor() as cur:
        cur.execute(
            KIND_CONFLICTS,
            {
                "merchant_id": merchant_id,
                "exts": [ext for ext, _ in pairs],
                "kinds": [kind for _, kind in pairs],
            },
        )
        return {str(r[0]) for r in cur.fetchall()}


def build_discovery_products(
    conn: psycopg.Connection,
    *,
    merchant_slug: str,
    limit: int,
    batch_size: int = DEFAULT_BATCH,
    max_seconds: float | None = None,
    rescan: bool = False,
    sleep_seconds: float = 0.0,
    should_stop: Callable[[], bool] = lambda: False,
    on_batch: Callable[[DiscoveryBuildCounts], None] | None = None,
    policy: SourcePolicy | None = None,
    dry_run: bool = False,
) -> DiscoveryBuildCounts:
    """En fazla `limit` defter satiri tarar. `dry_run` YALNIZCA OKUR (kontrol noktasina bakmaz,
    hicbir sey yazmaz; `created` taslak olmaya UYGUN satir sayisidir)."""
    policy = policy or POLICIES.get(merchant_slug)
    if policy is None or policy.discovery_source is None:
        raise LookupError(f"kesif defteri politikasi yok: {merchant_slug}")
    source = policy.discovery_source
    batch_size = max(1, min(batch_size, MAX_BATCH))
    merchant_id = merchant_id_for(conn, merchant_slug)
    started = time.monotonic()
    totals = DiscoveryBuildCounts()

    after = ""
    if not dry_run:
        with conn.cursor() as cur:
            if rescan:
                cur.execute(RESET_STATE, {"source": source})
            cur.execute(LOAD_STATE, {"source": source})
            state = cur.fetchone()
        conn.commit()
        after = str(state[0]) if state else ""
    totals.last_external_id = after
    remaining = max(0, limit)

    while remaining > 0:
        if should_stop():
            break
        if max_seconds is not None and time.monotonic() - started >= max_seconds:
            break
        take = min(batch_size, remaining)
        rows = _read_batch(conn, source, after, take)
        batch = DiscoveryBuildCounts(scanned=len(rows))
        drafts: list[ProductDraft] = []
        kinds: dict[str, str] = {}
        for row in rows:
            verdict = evaluate_discovery(row, policy)
            if verdict.draft is not None:
                drafts.append(verdict.draft)
                kinds[row.external_id] = row.code_kind
            else:
                assert verdict.skip is not None
                batch.skip(verdict.skip)

        conflicts = _kind_conflicts(
            conn, merchant_id, [(d.external_id, kinds[d.external_id]) for d in drafts]
        )
        if conflicts:
            drafts = [d for d in drafts if d.external_id not in conflicts]
            batch.skip("discovery_kind_conflict", len(conflicts))
        last = rows[-1].external_id if rows else after
        done = len(rows) < take
        if dry_run:
            batch.created = len(drafts)
            conn.rollback()
        else:
            batch.created = _insert_drafts(conn, merchant_id, drafts, batch)
            with conn.cursor() as cur:
                cur.execute(
                    SAVE_STATE,
                    {
                        "source": source,
                        "last": last,
                        "scanned": batch.scanned,
                        "created": batch.created,
                        "existing": batch.existing,
                        "skipped": Jsonb(batch.skipped),
                        "done": done,
                    },
                )
            conn.commit()

        after = last
        remaining -= len(rows)
        totals.batches += 1
        totals.scanned += batch.scanned
        totals.created += batch.created
        totals.existing += batch.existing
        for reason, n in batch.skipped.items():
            totals.skip(reason, n)
        totals.last_external_id = after
        if on_batch:
            on_batch(totals)
        if done:
            totals.completed = True
            break
        if sleep_seconds:
            time.sleep(sleep_seconds)
    return totals
