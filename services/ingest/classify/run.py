"""Toplu urun siniflandirmasi (karar 0133): parti parti, kontrol noktali, yeniden calistirilabilir.

Her parti TEK kisa islemde: marka satirlari (yoksa) + kaynak esleme onerileri + urun
alanlari + `product_classification` + `search_outbox` + kontrol noktasi. Cokme sonrasi parti
ya tamamen vardir ya hic; ayni komut kaldigi yerden surer. Milyonlarca satir tek islemde
guncellenmez.

Urune dokunus SINIRLIDIR:
- Yalnizca `brand_id` / `category_id` (ve `updated_at`). Yeni urun, slug, gorsel, fiyat,
  teklif bagi ya da `publication_state` YAZILMAZ; yayindaki urun yayindan kalkmaz.
- Insanin ya da beslemenin yazdigi deger korunur. Bu isin daha once yazdigi deger
  (`product_classification.wrote_*` ve urunde hala ayni deger) yeni kural surumuyle
  degisebilir; belirsizlesirse geri alinir (yanlis kategori yerine kategorisiz).
- Guncelleme eski degerle kosulludur: arada baska bir yazar degistirdiyse urun atlanir
  ('error', `concurrent_change`), sonraki tarama yeniden dener.

Uretimde `catalog_build` (aktarim/kapi/yayin) calisirken BASLAMAZ: yayin `SKIP LOCKED`
kullanir, bu isin tuttugu satiri atlardi.

`owned_only` (karar 0138): yalnizca bu isin yazdigi degeri hala tasiyan urunler yeni kural
surumuyle yeniden karar alir (uretim pilotundaki 618 urun gibi). Kontrol noktasi YAZILMAZ ve
tum katalog taramasi baslamaz; insan/yonetici degeri zaten bu kumede degildir.
"""

from __future__ import annotations

import logging
import random
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field

import psycopg

from classify.brands import brand_key, name_norm
from classify.categories import guess_source, source_gender
from classify.decide import Decision, ProductFacts, SourceVerdict, decide
from classify.taxonomy import RULE_VERSION
from classify.text import path_norm
from resolve.products import slugify

logger = logging.getLogger(__name__)

DEFAULT_BATCH = 2_000
MAX_BATCH = 10_000
LOCK_KEY = 4_133_001
#: Kilit zaman asiminda parti geri alinir ve bu kadar kez (artan beklemeyle) yeniden denenir;
#: ard arda asilirsa is durur (kontrol noktasi korunur, ayni komut surer).
LOCK_RETRIES = 3
LOCK_RETRY_SLEEP_SECONDS = 5.0

_SELECT_ROWS = """
SELECT p.id, p.title, p.brand_id, p.category_id,
       COALESCE(so.merchant_id, lo.merchant_id), COALESCE(so.brand_raw, lo.brand_raw),
       COALESCE(so.category_raw, lo.category_raw),
       pc.brand_id, pc.category_id, pc.wrote_brand, pc.wrote_category
  FROM product p
  LEFT JOIN offer so ON so.id = p.source_offer_id
  LEFT JOIN LATERAL (
        SELECT o.merchant_id, o.brand_raw, o.category_raw
          FROM offer o
         WHERE p.source_offer_id IS NULL AND o.product_id = p.id
         ORDER BY o.id
         LIMIT 1) lo ON TRUE
  LEFT JOIN product_classification pc ON pc.product_id = p.id
"""

SELECT_BATCH = (
    _SELECT_ROWS
    + """
 WHERE p.id > %(after)s
   AND (%(merchant_id)s::bigint IS NULL OR p.source_merchant_id = %(merchant_id)s)
 ORDER BY p.id
 LIMIT %(limit)s
"""
)

#: Yalnizca bu isin yazdigi (sahip oldugu) marka/kategori: yeni kural surumuyle duzeltme.
SELECT_OWNED = (
    _SELECT_ROWS
    + """
 WHERE p.id > %(after)s
   AND (pc.wrote_category OR pc.wrote_brand)
   AND (%(merchant_id)s::bigint IS NULL OR p.source_merchant_id = %(merchant_id)s)
 ORDER BY p.id
 LIMIT %(limit)s
"""
)

#: Orneklem: rastgele kimlikler birincil anahtarla okunur (tam tarama yok).
SELECT_SAMPLE = (
    _SELECT_ROWS
    + """
 WHERE p.id = ANY(%(ids)s::bigint[])
   AND (%(merchant_id)s::bigint IS NULL OR p.source_merchant_id = %(merchant_id)s)
 ORDER BY p.id
"""
)

UPDATE_PRODUCTS = """
UPDATE product p SET brand_id = t.nb, category_id = t.nc, updated_at = now()
  FROM unnest(%(pids)s::bigint[], %(ob)s::bigint[], %(oc)s::bigint[],
              %(nb)s::bigint[], %(nc)s::bigint[]) AS t(pid, ob, oc, nb, nc)
 WHERE p.id = t.pid
   AND p.brand_id IS NOT DISTINCT FROM t.ob
   AND p.category_id IS NOT DISTINCT FROM t.oc
RETURNING p.id, p.publication_state
"""

UPSERT_CLASSIFICATION = """
INSERT INTO product_classification AS pc
    (product_id, rule_version, state, brand_id, brand_basis, category_id, category_basis,
     confidence, compatible_brands, wrote_brand, wrote_category, detail)
SELECT t.pid, %(version)s, t.state, t.bid, t.bb, t.cid, t.cb, t.conf,
       string_to_array(t.compat, '|'), t.wb, t.wc, t.detail
  FROM unnest(%(pids)s::bigint[], %(states)s::text[], %(bids)s::bigint[], %(bbs)s::text[],
              %(cids)s::bigint[], %(cbs)s::text[], %(confs)s::smallint[], %(compats)s::text[],
              %(wbs)s::boolean[], %(wcs)s::boolean[], %(details)s::text[])
       AS t(pid, state, bid, bb, cid, cb, conf, compat, wb, wc, detail)
ON CONFLICT (product_id) DO UPDATE SET
    rule_version = EXCLUDED.rule_version, state = EXCLUDED.state,
    brand_id = EXCLUDED.brand_id, brand_basis = EXCLUDED.brand_basis,
    category_id = EXCLUDED.category_id, category_basis = EXCLUDED.category_basis,
    confidence = EXCLUDED.confidence, compatible_brands = EXCLUDED.compatible_brands,
    wrote_brand = EXCLUDED.wrote_brand, wrote_category = EXCLUDED.wrote_category,
    detail = EXCLUDED.detail, classified_at = now()
 WHERE (pc.rule_version, pc.state, pc.brand_id, pc.brand_basis, pc.category_id,
        pc.category_basis, pc.confidence, pc.compatible_brands, pc.wrote_brand,
        pc.wrote_category, pc.detail)
       IS DISTINCT FROM
       (EXCLUDED.rule_version, EXCLUDED.state, EXCLUDED.brand_id, EXCLUDED.brand_basis,
        EXCLUDED.category_id, EXCLUDED.category_basis, EXCLUDED.confidence,
        EXCLUDED.compatible_brands, EXCLUDED.wrote_brand, EXCLUDED.wrote_category,
        EXCLUDED.detail)
"""

OUTBOX = """
INSERT INTO search_outbox (entity, entity_id, op, reason)
SELECT 'product', unnest(%(ids)s::bigint[]), 'upsert', 'classified'
"""

#: Kural onerisi yazar; yonetici karari ('confirmed'/'rejected') DEGISMEZ.
UPSERT_SOURCE_MAP = """
INSERT INTO category_source_map AS m
    (merchant_id, source_path, path_norm, category_id, status, confidence, rule_version)
SELECT t.mid, t.src, t.norm, t.cid, t.status, t.conf, %(version)s
  FROM unnest(%(mids)s::bigint[], %(srcs)s::text[], %(norms)s::text[], %(cids)s::bigint[],
              %(statuses)s::text[], %(confs)s::smallint[]) AS t(mid, src, norm, cid, status, conf)
ON CONFLICT (merchant_id, path_norm) DO UPDATE SET
    category_id = EXCLUDED.category_id, status = EXCLUDED.status,
    confidence = EXCLUDED.confidence, rule_version = EXCLUDED.rule_version, updated_at = now()
 WHERE m.status IN ('unmapped', 'suggested')
   AND (m.category_id, m.status, m.confidence, m.rule_version)
       IS DISTINCT FROM (EXCLUDED.category_id, EXCLUDED.status, EXCLUDED.confidence,
                         EXCLUDED.rule_version)
"""

SAVE_STATE = """
INSERT INTO product_classification_state AS s
    (rule_version, scope, last_product_id, scanned, brand_set, category_set, review, errors,
     completed_at)
VALUES (%(version)s, %(scope)s, %(last)s, %(scanned)s, %(brand_set)s, %(category_set)s,
        %(review)s, %(errors)s, %(completed_at)s)
ON CONFLICT (rule_version, scope) DO UPDATE SET
    last_product_id = EXCLUDED.last_product_id,
    scanned = s.scanned + EXCLUDED.scanned,
    brand_set = s.brand_set + EXCLUDED.brand_set,
    category_set = s.category_set + EXCLUDED.category_set,
    review = s.review + EXCLUDED.review,
    errors = s.errors + EXCLUDED.errors,
    updated_at = now(),
    completed_at = EXCLUDED.completed_at
"""

RESET_STATE = """
INSERT INTO product_classification_state AS s (rule_version, scope)
VALUES (%(version)s, %(scope)s)
ON CONFLICT (rule_version, scope) DO UPDATE SET
    last_product_id = 0, scanned = 0, brand_set = 0, category_set = 0, review = 0, errors = 0,
    started_at = now(), updated_at = now(), completed_at = NULL
"""

BUSY_CATALOG_BUILD = """
SELECT count(*) FROM pg_stat_activity
 WHERE pid <> pg_backend_pid() AND datname = current_database()
   AND application_name LIKE 'arilla-ingest:catalog_build%'
"""


class ClassifyAborted(RuntimeError):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


@dataclass
class Counts:
    scanned: int = 0
    unchanged: int = 0
    brand_set: int = 0
    category_set: int = 0
    review: int = 0
    errors: int = 0
    batches: int = 0
    last_product_id: int = 0
    completed: bool = False
    #: Is neden erken durdu: 'wal' (geri basinc). None = tamamlandi ya da sinir/istek.
    stopped_reason: str | None = None
    brand_basis: Counter[str] = field(default_factory=Counter)
    category_basis: Counter[str] = field(default_factory=Counter)
    #: Inceleme bekleyen kaynak yollari (rapor; en cok urunlu once).
    review_sources: Counter[str] = field(default_factory=Counter)

    def add(self, other: Counts) -> None:
        self.scanned += other.scanned
        self.unchanged += other.unchanged
        self.brand_set += other.brand_set
        self.category_set += other.category_set
        self.review += other.review
        self.errors += other.errors
        self.brand_basis.update(other.brand_basis)
        self.category_basis.update(other.category_basis)
        self.review_sources.update(other.review_sources)


@dataclass(frozen=True)
class _Row:
    product_id: int
    title: str
    brand_id: int | None
    category_id: int | None
    merchant_id: int | None
    brand_raw: str | None
    category_raw: str | None
    prev_brand: int | None
    prev_category: int | None
    prev_wrote_brand: bool
    prev_wrote_category: bool

    @property
    def owns_brand(self) -> bool:
        return (
            self.prev_wrote_brand and self.brand_id is not None and self.brand_id == self.prev_brand
        )

    @property
    def owns_category(self) -> bool:
        return (
            self.prev_wrote_category
            and self.category_id is not None
            and self.category_id == self.prev_category
        )


class Catalog:
    """Kosu basina bir kez okunan kucuk tablolar: kategori, marka, magaza, kaynak esleme."""

    def __init__(self, conn: psycopg.Connection) -> None:
        with conn.cursor() as cur:
            cur.execute("SELECT id, path FROM category")
            rows = cur.fetchall()
            self.path_by_id: dict[int, str] = {int(i): str(p) for i, p in rows}
            self.id_by_path: dict[str, int] = {}
            for i, p in sorted(rows):
                self.id_by_path.setdefault(str(p), int(i))
            cur.execute("SELECT id, name FROM merchant")
            self.merchant_name: dict[int, str] = {int(i): str(n) for i, n in cur.fetchall()}
            cur.execute("SELECT id, name, name_norm FROM brand ORDER BY id")
            self.brand_by_key: dict[str, int] = {}
            for i, name, norm in cur.fetchall():
                for key in (brand_key(str(name)), brand_key(str(norm))):
                    if key:
                        self.brand_by_key.setdefault(key, int(i))
            cur.execute(
                """SELECT merchant_id, path_norm, category_id, status, confidence, rule_version
                     FROM category_source_map"""
            )
            self.source_rows: dict[
                tuple[int, str], tuple[int | None, str, int | None, int | None]
            ] = {
                (int(m), str(n)): (None if c is None else int(c), str(s), conf, ver)
                for m, n, c, s, conf, ver in cur.fetchall()
            }
        self._guess_cache: dict[str, SourceVerdict] = {}
        #: Bu kosuda yazilacak/guncellenecek kaynak esleme satirlari.
        self.pending_sources: dict[tuple[int, str], tuple[str, int | None, str, int]] = {}

    def source_verdict(self, merchant_id: int, raw: str) -> SourceVerdict | None:
        norm = path_norm(raw)
        if not norm:
            return None
        key = (merchant_id, norm)
        row = self.source_rows.get(key)
        if row is not None and row[1] in ("confirmed", "rejected"):
            cid, status, conf, _ = row
            path = self.path_by_id.get(cid) if cid is not None else None
            return SourceVerdict(
                path, 100 if status == "confirmed" else int(conf or 0), status, source_gender(raw)
            )
        verdict = self._guess_cache.get(norm)
        if verdict is None:
            guess = guess_source(raw)
            path = guess.path if guess.path in self.id_by_path else None
            verdict = SourceVerdict(
                path,
                guess.confidence if path else 0,
                "suggested" if path else "unmapped",
                source_gender(raw),
            )
            self._guess_cache[norm] = verdict
        cid = self.id_by_path.get(verdict.path) if verdict.path else None
        wanted = (cid, verdict.status, verdict.confidence, RULE_VERSION)
        if row != wanted and key not in self.pending_sources:
            self.pending_sources[key] = (raw[:500], cid, verdict.status, verdict.confidence)
            self.source_rows[key] = wanted
        return verdict


def _read(
    conn: psycopg.Connection,
    after: int,
    limit: int,
    merchant_id: int | None,
    *,
    owned_only: bool = False,
) -> list[_Row]:
    with conn.cursor() as cur:
        cur.execute(
            SELECT_OWNED if owned_only else SELECT_BATCH,
            {"after": after, "limit": limit, "merchant_id": merchant_id},
        )
        return _rows(cur.fetchall())


def _rows(rows: list[tuple]) -> list[_Row]:
    return [
        _Row(
            product_id=int(r[0]),
            title=str(r[1]),
            brand_id=None if r[2] is None else int(r[2]),
            category_id=None if r[3] is None else int(r[3]),
            merchant_id=None if r[4] is None else int(r[4]),
            brand_raw=r[5],
            category_raw=r[6],
            prev_brand=None if r[7] is None else int(r[7]),
            prev_category=None if r[8] is None else int(r[8]),
            prev_wrote_brand=bool(r[9]),
            prev_wrote_category=bool(r[10]),
        )
        for r in rows
    ]


def facts_for(row: _Row, catalog: Catalog) -> ProductFacts:
    kept_category = row.category_id is not None and not row.owns_category
    source = None
    if row.merchant_id is not None and row.category_raw:
        source = catalog.source_verdict(row.merchant_id, row.category_raw)
    return ProductFacts(
        title=row.title,
        kept_brand=row.brand_id is not None and not row.owns_brand,
        kept_category_path=(
            catalog.path_by_id.get(row.category_id, "")
            if kept_category and row.category_id
            else None
        ),
        brand_raw=row.brand_raw,
        merchant_name=catalog.merchant_name.get(row.merchant_id) if row.merchant_id else None,
        source=source,
    )


def _ensure_brands(conn: psycopg.Connection, catalog: Catalog, names: set[str]) -> None:
    """Eksik markalari acar. Ayni anahtarli marka varsa onu kullanir (cift satir acilmaz)."""
    missing = sorted({n for n in names if brand_key(n) not in catalog.brand_by_key})
    if not missing:
        return
    slugs = [slugify(n) for n in missing]
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO brand (slug, name, name_norm)
               SELECT * FROM unnest(%s::text[], %s::text[], %s::text[])
               ON CONFLICT (slug) DO NOTHING""",
            (slugs, missing, [name_norm(n) for n in missing]),
        )
        cur.execute("SELECT id, slug FROM brand WHERE slug = ANY(%s)", (slugs,))
        by_slug = {str(s): int(i) for i, s in cur.fetchall()}
    for name, slug in zip(missing, slugs, strict=True):
        if slug in by_slug:
            catalog.brand_by_key.setdefault(brand_key(name), by_slug[slug])


def _flush_sources(conn: psycopg.Connection, catalog: Catalog) -> None:
    if not catalog.pending_sources:
        return
    items = sorted(catalog.pending_sources.items())
    with conn.cursor() as cur:
        cur.execute(
            UPSERT_SOURCE_MAP,
            {
                "version": RULE_VERSION,
                "mids": [k[0] for k, _ in items],
                "norms": [k[1] for k, _ in items],
                "srcs": [v[0] for _, v in items],
                "cids": [v[1] for _, v in items],
                "statuses": [v[2] for _, v in items],
                "confs": [v[3] for _, v in items],
            },
        )
    catalog.pending_sources.clear()


def _target(row: _Row, decision: Decision, catalog: Catalog) -> tuple[int | None, int | None]:
    """Urunun yazilacak (marka, kategori) degerleri."""
    if decision.brand_basis == "existing":
        brand = row.brand_id
    elif decision.brand_name is not None:
        brand = catalog.brand_by_key.get(brand_key(decision.brand_name))
    else:
        brand = None
    if decision.category_basis == "existing":
        category = row.category_id
    elif decision.category_path is not None:
        category = catalog.id_by_path.get(decision.category_path)
    else:
        category = None
    # Korunmayan ve bu isin yazmadigi dolu deger (or. sonradan eklenmis) silinmez.
    if brand is None and row.brand_id is not None and not row.owns_brand:
        brand = row.brand_id
    if category is None and row.category_id is not None and not row.owns_category:
        category = row.category_id
    return brand, category


def _process_batch(
    conn: psycopg.Connection, catalog: Catalog, rows: list[_Row], *, dry_run: bool
) -> Counts:
    counts = Counts(scanned=len(rows))
    work: list[tuple[_Row, Decision]] = []
    for row in rows:
        if (
            row.brand_id is not None
            and row.category_id is not None
            and not (row.owns_brand or row.owns_category)
        ):
            counts.unchanged += 1
            continue
        try:
            decision = decide(facts_for(row, catalog))
        except Exception:  # pragma: no cover - kayit duzeyi hata kosuyu durdurmaz
            logger.exception("siniflandirma hatasi: urun %s", row.product_id)
            counts.errors += 1
            continue
        counts.brand_basis[decision.brand_basis] += 1
        counts.category_basis[decision.category_basis] += 1
        if decision.state == "review":
            counts.review += 1
            if row.category_raw:
                counts.review_sources[path_norm(row.category_raw)] += 1
        work.append((row, decision))
    if dry_run:
        for row, decision in work:
            brand, category = _target(row, decision, catalog)
            # Olcumde eksik marka acilmaz: henuz olmayan marka da "yazilirdi" sayilir.
            if (
                decision.brand_name is not None
                and (brand is None or brand != row.brand_id)
                and decision.brand_basis != "existing"
            ):
                counts.brand_set += 1
            if category != row.category_id and category is not None:
                counts.category_set += 1
        catalog.pending_sources.clear()
        return counts

    _ensure_brands(conn, catalog, {d.brand_name for _, d in work if d.brand_name is not None})
    _flush_sources(conn, catalog)

    changes = [(row, decision, *_target(row, decision, catalog)) for row, decision in work]
    to_update = [c for c in changes if (c[2], c[3]) != (c[0].brand_id, c[0].category_id)]
    updated: dict[int, str] = {}
    if to_update:
        with conn.cursor() as cur:
            cur.execute(
                UPDATE_PRODUCTS,
                {
                    "pids": [c[0].product_id for c in to_update],
                    "ob": [c[0].brand_id for c in to_update],
                    "oc": [c[0].category_id for c in to_update],
                    "nb": [c[2] for c in to_update],
                    "nc": [c[3] for c in to_update],
                },
            )
            updated = {int(i): str(s) for i, s in cur.fetchall()}
        published = [pid for pid, state in updated.items() if state == "published"]
        if published:
            with conn.cursor() as cur:
                cur.execute(OUTBOX, {"ids": published})

    pc: dict[str, list] = {
        k: []
        for k in (
            "pids",
            "states",
            "bids",
            "bbs",
            "cids",
            "cbs",
            "confs",
            "compats",
            "wbs",
            "wcs",
            "details",
        )
    }
    for row, decision, brand, category in changes:
        needs_update = (brand, category) != (row.brand_id, row.category_id)
        if needs_update and row.product_id not in updated:
            # Arada baska yazar degistirdi: urun bu turda atlanir, sonraki tarama dener.
            state, detail = "error", "concurrent_change"
            counts.errors += 1
            wrote_brand = wrote_category = False
        else:
            state, detail = decision.state, decision.detail
            wrote_brand = (
                decision.brand_basis in ("source", "title")
                and brand is not None
                and brand == catalog.brand_by_key.get(brand_key(decision.brand_name or ""))
            )
            wrote_category = (
                decision.category_basis in ("source", "source_title", "title")
                and category is not None
                and category == catalog.id_by_path.get(decision.category_path or "")
            )
            if needs_update:
                if brand != row.brand_id and wrote_brand:
                    counts.brand_set += 1
                if category != row.category_id and wrote_category:
                    counts.category_set += 1
        pc["pids"].append(row.product_id)
        pc["states"].append(state)
        pc["bids"].append(
            catalog.brand_by_key.get(brand_key(decision.brand_name))
            if decision.brand_name
            else None
        )
        pc["bbs"].append(decision.brand_basis)
        pc["cids"].append(
            catalog.id_by_path.get(decision.category_path) if decision.category_path else None
        )
        pc["cbs"].append(decision.category_basis)
        pc["confs"].append(decision.confidence)
        pc["compats"].append("|".join(decision.compatible) if decision.compatible else None)
        pc["wbs"].append(wrote_brand)
        pc["wcs"].append(wrote_category)
        pc["details"].append(detail)
    if pc["pids"]:
        with conn.cursor() as cur:
            cur.execute(UPSERT_CLASSIFICATION, {"version": RULE_VERSION, **pc})
    return counts


def classify_products(
    conn: psycopg.Connection,
    *,
    batch_size: int = DEFAULT_BATCH,
    max_batches: int | None = None,
    max_seconds: float | None = None,
    sleep_seconds: float = 0.0,
    rescan: bool = False,
    dry_run: bool = False,
    after_id: int | None = None,
    merchant_slug: str | None = None,
    owned_only: bool = False,
    allow_concurrent_catalog_build: bool = False,
    lock_timeout_ms: int = 3_000,
    throttle: Callable[[], bool] | None = None,
    should_stop: Callable[[], bool] = lambda: False,
    on_batch: Callable[[Counts], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> Counts:
    """Kontrol noktasindan devam eder. `dry_run` YALNIZCA OKUR (uretimde guvenle olcer).

    `merchant_slug`: yalnizca o kaynagin urunleri (`product.source_merchant_id`); kendi
    kontrol noktasi (`scope = 'merchant:<slug>'`) vardir, tum katalog noktasini ilerletmez.

    `throttle`: WAL geri basinci (karar 0134, `db.wal_pressure.WalGovernor.before_batch`).
    Her yazan partiden ONCE, acik islem yokken cagrilir; False donerse is durur
    (`stopped_reason = "wal"`), tamamlanan partiler ve kontrol noktasi kalir.

    `owned_only`: yalnizca bu isin yazdigi degerleri tasiyan urunler; kontrol noktasi okunmaz
    ve yazilmaz (`rescan` ile birlikte verilemez), `after_id` ile surdurulur.
    """
    if owned_only and rescan:
        raise ClassifyAborted("owned_only_rescan", "--owned-only ve --rescan birlikte verilemez")
    batch_size = max(1, min(batch_size, MAX_BATCH))
    merchant_id: int | None = None
    scope = "all"
    if merchant_slug is not None:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM merchant WHERE slug = %s", (merchant_slug,))
            found = cur.fetchone()
        if found is None:
            raise ClassifyAborted("merchant_missing", merchant_slug)
        merchant_id, scope = int(found[0]), f"merchant:{merchant_slug}"
    totals = Counts()
    started = time.monotonic()
    locked = False
    if not dry_run:
        with conn.cursor() as cur:
            cur.execute(BUSY_CATALOG_BUILD)
            busy = int(cur.fetchone()[0])  # type: ignore[index]
            if busy and not allow_concurrent_catalog_build:
                conn.rollback()
                raise ClassifyAborted("catalog_build_running", f"{busy} oturum")
            cur.execute("SELECT pg_try_advisory_lock(%s)", (LOCK_KEY,))
            locked = bool(cur.fetchone()[0])  # type: ignore[index]
            if not locked:
                conn.rollback()
                raise ClassifyAborted("already_running")
            if rescan:
                cur.execute(RESET_STATE, {"version": RULE_VERSION, "scope": scope})
            state = None
            if not owned_only:
                cur.execute(
                    """SELECT last_product_id FROM product_classification_state
                        WHERE rule_version = %s AND scope = %s""",
                    (RULE_VERSION, scope),
                )
                state = cur.fetchone()
        conn.commit()
        after = int(state[0]) if state else 0
    else:
        after = 0
    if after_id is not None:
        after = after_id
    totals.last_product_id = after
    catalog = Catalog(conn)
    conn.commit()
    lock_failures = 0
    try:
        while not should_stop():
            if max_batches is not None and totals.batches >= max_batches:
                break
            if max_seconds is not None and time.monotonic() - started >= max_seconds:
                break
            if not dry_run and throttle is not None and not throttle():
                totals.stopped_reason = "wal"
                break
            if not dry_run:
                with conn.cursor() as cur:
                    cur.execute(f"SET LOCAL lock_timeout = '{int(lock_timeout_ms)}ms'")
                    cur.execute("SET LOCAL statement_timeout = '120s'")
            rows = _read(conn, after, batch_size, merchant_id, owned_only=owned_only)
            done = len(rows) < batch_size
            last = rows[-1].product_id if rows else after
            try:
                batch = _process_batch(conn, catalog, rows, dry_run=dry_run)
            except psycopg.errors.LockNotAvailable:
                # Baska yazar (or. fiyat ozeti yenileme) ayni urunu tutuyor: parti tamamen geri
                # alinir, kontrol noktasi ilerlemez; ayni parti biraz sonra yeniden denenir.
                conn.rollback()
                # Geri alinan partide acilan marka/esleme satirlari artik yok: onbellek yeniden.
                catalog = Catalog(conn)
                conn.commit()
                lock_failures += 1
                if lock_failures > LOCK_RETRIES:
                    raise
                logger.warning("kilit zaman asimi, parti yeniden denenecek (%d)", lock_failures)
                sleep(LOCK_RETRY_SLEEP_SECONDS * lock_failures)
                continue
            lock_failures = 0
            if dry_run:
                conn.rollback()
            elif owned_only:
                conn.commit()
            else:
                with conn.cursor() as cur:
                    cur.execute(
                        SAVE_STATE,
                        {
                            "version": RULE_VERSION,
                            "scope": scope,
                            "last": last,
                            "scanned": batch.scanned,
                            "brand_set": batch.brand_set,
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
                            (RULE_VERSION, scope),
                        )
                conn.commit()
            after = last
            totals.add(batch)
            totals.batches += 1
            totals.last_product_id = after
            if on_batch:
                on_batch(totals)
            if done:
                totals.completed = True
                break
            if sleep_seconds:
                sleep(sleep_seconds)
    except psycopg.errors.LockNotAvailable as error:
        conn.rollback()
        raise ClassifyAborted(
            "lock_timeout", "parti geri alindi; ayni komutla devam edin"
        ) from error
    finally:
        if locked:
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT pg_advisory_unlock(%s)", (LOCK_KEY,))
                conn.commit()
            except psycopg.Error:  # pragma: no cover
                pass
    return totals


def sample_decisions(
    conn: psycopg.Connection,
    *,
    n: int,
    merchant_slug: str | None = None,
    seed: int | None = None,
    max_rounds: int = 20,
) -> list[tuple[_Row, Decision]]:
    """YALNIZCA OKUR: rastgele `n` urun ve siniflandiricinin karari (insan etiketlemesi icin).

    Kimlikler [min, max] araligindan secilir ve birincil anahtarla okunur; magaza filtresi
    sonradan uygulanir (eksik kalirsa yeni tur). Hicbir sey yazilmaz; islem geri alinir.
    """
    rng = random.Random(seed)
    merchant_id: int | None = None
    if merchant_slug is not None:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM merchant WHERE slug = %s", (merchant_slug,))
            found = cur.fetchone()
        if found is None:
            raise ClassifyAborted("merchant_missing", merchant_slug)
        merchant_id = int(found[0])
    with conn.cursor() as cur:
        cur.execute("SELECT min(id), max(id) FROM product")
        lo, hi = cur.fetchone()  # type: ignore[misc]
    if lo is None:
        conn.rollback()
        return []
    catalog = Catalog(conn)
    picked: dict[int, _Row] = {}
    for _ in range(max_rounds):
        if len(picked) >= n:
            break
        ids = list({rng.randint(int(lo), int(hi)) for _ in range(max(n * 4, 50))})
        with conn.cursor() as cur:
            cur.execute(SELECT_SAMPLE, {"ids": ids, "merchant_id": merchant_id})
            for row in _rows(cur.fetchall()):
                if len(picked) < n:
                    picked.setdefault(row.product_id, row)
    out = [(row, decide(facts_for(row, catalog))) for row in picked.values()]
    catalog.pending_sources.clear()
    conn.rollback()
    return sorted(out, key=lambda item: item[0].product_id)


@dataclass(frozen=True)
class Recheck:
    """Sahip olunan urunun eski ve yeni degeri (YALNIZCA OKUR; pilot ve geri alma kaydi)."""

    row: _Row
    decision: Decision
    old_category: str | None
    new_category: str | None
    new_category_id: int | None
    new_brand_id: int | None

    @property
    def action(self) -> str:
        if self.row.category_id == self.new_category_id:
            return "keep"
        return "clear" if self.new_category_id is None else "change"


def recheck_owned(
    conn: psycopg.Connection, *, merchant_slug: str | None = None, limit: int | None = None
) -> list[Recheck]:
    """YALNIZCA OKUR: bu isin yazdigi degerleri tasiyan urunler yeni kurallarla ne olur.

    `products --owned-only` ile ayni secim ve ayni `_target`; hicbir sey yazilmaz. Cikti uretim
    pilotunun onizlemesi ve geri alma kaydidir (eski `category_id` / `brand_id`).
    """
    merchant_id: int | None = None
    if merchant_slug is not None:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM merchant WHERE slug = %s", (merchant_slug,))
            found = cur.fetchone()
        if found is None:
            raise ClassifyAborted("merchant_missing", merchant_slug)
        merchant_id = int(found[0])
    catalog = Catalog(conn)
    out: list[Recheck] = []
    after = 0
    while limit is None or len(out) < limit:
        rows = _read(conn, after, DEFAULT_BATCH, merchant_id, owned_only=True)
        if not rows:
            break
        for row in rows:
            decision = decide(facts_for(row, catalog))
            brand, category = _target(row, decision, catalog)
            out.append(
                Recheck(
                    row=row,
                    decision=decision,
                    old_category=catalog.path_by_id.get(row.category_id)
                    if row.category_id
                    else None,
                    new_category=catalog.path_by_id.get(category) if category else None,
                    new_category_id=category,
                    new_brand_id=brand,
                )
            )
        after = rows[-1].product_id
    catalog.pending_sources.clear()
    conn.rollback()
    return out[:limit] if limit is not None else out


def source_coverage(
    conn: psycopg.Connection, merchant_id: int, *, write: bool
) -> list[tuple[str, int, str | None, int, str]]:
    """Magazanin kaynak kategori yollari: (yol, teklif sayisi, hedef yol, guven, durum).

    `write=True` oneriyi ve teklif sayisini `category_source_map`e yazar (onaylilara dokunmaz).
    Okuma tek bir `offer` gruplamasidir (kaynak yolu basina bir satir).
    """
    catalog = Catalog(conn)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT category_raw, count(*) FROM offer
                WHERE merchant_id = %s AND category_raw IS NOT NULL
                GROUP BY 1 ORDER BY 2 DESC""",
            (merchant_id,),
        )
        rows = [(str(r[0]), int(r[1])) for r in cur.fetchall()]
    out: list[tuple[str, int, str | None, int, str]] = []
    counts: dict[str, int] = {}
    for raw, n in rows:
        verdict = catalog.source_verdict(merchant_id, raw)
        if verdict is None:
            continue
        counts[path_norm(raw)] = counts.get(path_norm(raw), 0) + n
        out.append((raw, n, verdict.path, verdict.confidence, verdict.status))
    if write:
        _flush_sources(conn, catalog)
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE category_source_map m SET offer_count = t.n, updated_at = now()
                     FROM unnest(%s::text[], %s::int[]) AS t(norm, n)
                    WHERE m.merchant_id = %s AND m.path_norm = t.norm
                      AND m.offer_count IS DISTINCT FROM t.n""",
                (list(counts), list(counts.values()), merchant_id),
            )
        conn.commit()
    else:
        catalog.pending_sources.clear()
        conn.rollback()
    return out
