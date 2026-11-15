"""Yapilandirilmis kaynak markasini (`offer.brand_raw`) mevcut `brand` satirina baglar (karar 0209).

Yalniz markayi baglar; kategoriye, `product_classification`a, slug/fiyat/yayin durumuna
dokunmaz. Kural DETERMINISTIKTIR:

1. `clean_source_brand`: bos/anlamsiz ("No Brand", "Markasiz", magaza adi...) elenir.
2. Satici/magaza adi gibi gorunen deger ("... Store", "...Shop", "Xml Bayiciniz") elenir
   (Hepsiburada marka alani bazen satici adini tasir).
3. `brand_key` (aksansiz, kucuk harf, yalniz harf/rakam) mevcut markanin `name`/`name_norm`
   anahtariyla TAM esit olmali. Bulanik eslesme YOK. Ayni anahtara iki marka satiri
   dusuyorsa belirsizdir: baglanmaz.
4. Eslesme yoksa urun markasiz kalir. Yeni marka satiri YALNIZ `create_missing=True` ile
   (varsayilan kapali; uretimde ayri onay) acilir.

Idempotent (kural 7): yalniz `product.brand_id IS NULL` olan satirlar guncellenir ve
guncelleme `brand_id IS NULL` ile kosulludur; insanin/besleme/siniflandirmanin yazdigi dolu
deger asla ezilmez. Ikinci kosu bir sey degistirmez. Kaynak: `product.source_offer_id`.

Uretimde calistirilmaz: yazma yalniz yerel veritabaninda (`assert_local`) calisir.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Final
from urllib.parse import urlsplit

import psycopg

from classify.brands import brand_key, clean_source_brand, name_norm
from classify.run import OUTBOX
from resolve.products import slugify

DEFAULT_BATCH: Final = 1_000
LOCAL_HOSTS: Final = frozenset({"localhost", "127.0.0.1", "::1", ""})

#: Satici/magaza adi eki (anahtar bicimi, sonek). "Hype Store", "Senastore", "SesaShop",
#: "Expermarket", "Xml Bayiciniz"; cok kisa govdeli degerler ("Store") de elenir.
SELLER_SUFFIXES: Final = ("store", "shop", "market", "magaza", "bayiciniz", "bayi", "outlet")

SKIP_EMPTY: Final = "empty"
SKIP_JUNK: Final = "junk"
SKIP_SELLER: Final = "seller_like"
SKIP_NO_MATCH: Final = "no_match"
SKIP_AMBIGUOUS: Final = "ambiguous"


class NotLocalError(RuntimeError):
    """Yazma yalniz yerel veritabaninda calisir."""


def is_seller_like(name: str) -> bool:
    key = brand_key(name)
    return any(key.endswith(suffix) for suffix in SELLER_SUFFIXES)


def assert_local(conn: psycopg.Connection) -> None:
    """Baglanti yerel degilse yazmayi reddeder (uretim backfill'i ayri onay ister)."""
    host = urlsplit(f"//{conn.info.host or ''}").hostname or ""
    # Unix soket yolu ("/var/run/...") yereldir.
    if host not in LOCAL_HOSTS and not (conn.info.host or "").startswith("/"):
        raise NotLocalError("marka baglama yalniz yerel veritabaninda calisir (uretim: ayri onay)")


@dataclass(frozen=True)
class LinkVerdict:
    #: Baglanacak mevcut marka kimligi; yoksa None.
    brand_id: int | None
    #: Eslesmeyen ama temiz marka adi (`create_missing` icin); yoksa None.
    new_name: str | None
    reason: str | None


class BrandIndex:
    """`brand` tablosundan `brand_key -> id`; ayni anahtara iki satir dusuyorsa belirsiz."""

    def __init__(self, rows: list[tuple[int, str, str]]) -> None:
        by_key: dict[str, set[int]] = {}
        for brand_id, name, norm in rows:
            for key in (brand_key(name), brand_key(norm)):
                if key:
                    by_key.setdefault(key, set()).add(int(brand_id))
        self.unique = {k: next(iter(v)) for k, v in by_key.items() if len(v) == 1}
        self.ambiguous = frozenset(k for k, v in by_key.items() if len(v) > 1)

    @classmethod
    def load(cls, conn: psycopg.Connection) -> BrandIndex:
        with conn.cursor() as cur:
            cur.execute("SELECT id, name, name_norm FROM brand")
            rows = [(int(i), str(n), str(m)) for i, n, m in cur.fetchall()]
        conn.rollback()
        return cls(rows)


def decide_link(raw: str | None, merchant_name: str | None, index: BrandIndex) -> LinkVerdict:
    if raw is None or not raw.strip():
        return LinkVerdict(None, None, SKIP_EMPTY)
    clean = clean_source_brand(raw, merchant_name=merchant_name)
    if clean is None:
        return LinkVerdict(None, None, SKIP_JUNK)
    if is_seller_like(clean):
        return LinkVerdict(None, None, SKIP_SELLER)
    key = brand_key(clean)
    if key in index.ambiguous:
        return LinkVerdict(None, None, SKIP_AMBIGUOUS)
    found = index.unique.get(key)
    if found is not None:
        return LinkVerdict(found, None, None)
    return LinkVerdict(None, clean, SKIP_NO_MATCH)


@dataclass
class LinkCounts:
    scanned: int = 0
    linked: int = 0
    skipped: Counter[str] = field(default_factory=Counter)
    created_brands: int = 0
    last_product_id: int = 0
    #: Eslesmeyen temiz markalar ve urun sayilari (olcum raporu).
    unmatched: Counter[str] = field(default_factory=Counter)


SELECT_BATCH = """
SELECT p.id, o.brand_raw
  FROM product p
  JOIN offer o ON o.id = p.source_offer_id
 WHERE p.source_merchant_id = %(merchant_id)s
   AND p.brand_id IS NULL
   AND p.id > %(after)s
 ORDER BY p.id
 LIMIT %(limit)s
"""

UPDATE_PRODUCTS = """
UPDATE product p SET brand_id = t.bid, updated_at = now()
  FROM unnest(%(pids)s::bigint[], %(bids)s::bigint[]) AS t(pid, bid)
 WHERE p.id = t.pid AND p.brand_id IS NULL
RETURNING p.id, p.publication_state
"""


def _create_brands(conn: psycopg.Connection, index: BrandIndex, names: set[str]) -> int:
    """Eksik temiz markalari acar (yalniz `create_missing`); ayni anahtarli satir varsa acmaz."""
    missing = sorted({n for n in names if brand_key(n) not in index.unique})
    missing = [n for n in missing if brand_key(n) not in index.ambiguous]
    if not missing:
        return 0
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
    made = 0
    for name, slug in zip(missing, slugs, strict=True):
        if slug in by_slug:
            index.unique.setdefault(brand_key(name), by_slug[slug])
            made += 1
    return made


def link_brands(
    conn: psycopg.Connection,
    *,
    merchant_slug: str,
    create_missing: bool = False,
    dry_run: bool = True,
    batch_size: int = DEFAULT_BATCH,
    max_batches: int | None = None,
) -> LinkCounts:
    """`dry_run` YALNIZCA OKUR (herhangi bir veritabaninda guvenli). Yazma yerel ister."""
    if not dry_run:
        assert_local(conn)
    batch_size = max(1, min(batch_size, 20_000))
    with conn.cursor() as cur:
        cur.execute("SELECT id, name FROM merchant WHERE slug = %s", (merchant_slug,))
        found = cur.fetchone()
    if found is None:
        raise LookupError(f"merchant yok: {merchant_slug}")
    merchant_id, merchant_name = int(found[0]), str(found[1])
    index = BrandIndex.load(conn)
    counts = LinkCounts()
    after = 0
    batches = 0
    while max_batches is None or batches < max_batches:
        with conn.cursor() as cur:
            cur.execute(
                SELECT_BATCH, {"merchant_id": merchant_id, "after": after, "limit": batch_size}
            )
            rows = [(int(i), r) for i, r in cur.fetchall()]
        if not rows:
            conn.rollback()
            break
        batches += 1
        counts.scanned += len(rows)
        after = rows[-1][0]
        counts.last_product_id = after
        verdicts = [(pid, decide_link(raw, merchant_name, index)) for pid, raw in rows]
        for _, v in verdicts:
            if v.reason:
                counts.skipped[v.reason] += 1
            if v.new_name:
                counts.unmatched[v.new_name] += 1
        if dry_run:
            counts.linked += sum(1 for _, v in verdicts if v.brand_id is not None)
            conn.rollback()
            continue
        if create_missing:
            counts.created_brands += _create_brands(
                conn, index, {v.new_name for _, v in verdicts if v.new_name}
            )
            verdicts = [(pid, decide_link(raw, merchant_name, index)) for pid, raw in rows]
        todo = [(pid, v.brand_id) for pid, v in verdicts if v.brand_id is not None]
        if todo:
            with conn.cursor() as cur:
                cur.execute(
                    UPDATE_PRODUCTS,
                    {"pids": [p for p, _ in todo], "bids": [b for _, b in todo]},
                )
                updated = [(int(i), str(s)) for i, s in cur.fetchall()]
                published = [i for i, s in updated if s == "published"]
                if published:
                    cur.execute(OUTBOX, {"ids": published})
            counts.linked += len(updated)
        conn.commit()
    return counts
