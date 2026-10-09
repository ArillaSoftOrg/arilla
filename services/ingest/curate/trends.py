"""Trend-urun eslestirme toplu isi (karar 0077).

Akis: her yayinlanmis `trend` icin profil -> SQL on suzgec (katlanmis baslik
uzerinde indeksli `LIKE ANY`) -> Python puanlama ve cesitlilikli secim ->
(yalniz `--apply` ile) `trend_product` yeniden yazimi.

Varsayilan KURU KOSUDUR: hicbir sey yazmaz, rapor basar. Yazim tek islemde,
trend basina "sil + ekle"dir; ayni girdi ayni sonucu verir (idempotent).
Bu is HTTP sunmaz; TypeScript tarafi onu cagirmaz, yalnizca `trend_product`
satirlarini okur.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import urlparse

import psycopg

from curate.profiles import BY_SLUG, PROFILES
from curate.selection import (
    LOW_MATCH_THRESHOLD,
    MIN_PUBLIC_PRODUCTS,
    Candidate,
    Profile,
    Scored,
    score_candidate,
    select_diverse,
)
from curate.text import sql_pattern

#: SQL on suzgecin trend basina ust siniri (puanlama bellekte yapilir).
PREFILTER_LIMIT = 6000

_FOLDED_TITLE = "lower(translate(p.title, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu'))"

#: Gosterilebilirlik `packages/core` `SHOWABLE` ile ayni + en az bir aktif,
#: stokta, fiyatli teklif ve aktif magaza. Test/tanilama magazalari disarida.
CANDIDATES_SQL = f"""
SELECT p.id, p.title, b.name, c.path, m.slug, p.min_price, p.offer_count
  FROM product p
  LEFT JOIN brand b ON b.id = p.brand_id
  LEFT JOIN category c ON c.id = p.category_id
  JOIN LATERAL (
        SELECT mm.slug
          FROM offer o
          JOIN merchant mm ON mm.id = o.merchant_id AND mm.is_active
         WHERE o.product_id = p.id AND o.is_active AND o.in_stock AND o.current_price > 0
           AND mm.slug NOT LIKE 'diag-%%' AND mm.slug NOT LIKE 'admin-%%'
         ORDER BY o.current_price, o.id
         LIMIT 1
  ) m ON TRUE
 WHERE p.primary_image_url IS NOT NULL AND p.min_price > 0 AND p.in_stock_count > 0
   AND ({_FOLDED_TITLE} LIKE ANY(%(patterns)s))
 ORDER BY p.id
 LIMIT {PREFILTER_LIMIT}
"""


@dataclass
class TrendResult:
    slug: str
    title: str
    candidates: int
    selected: list[Scored] = field(default_factory=list)
    note: str = ""

    @property
    def count(self) -> int:
        return len(self.selected)

    @property
    def min_price(self) -> int | None:
        """Secilen urunlerin en dusuk `min_price`i (kurus)."""
        prices = [s.candidate.min_price for s in self.selected]
        return min(prices) if prices else None

    @property
    def status(self) -> str:
        if self.count == 0:
            return "bos"
        if self.count < MIN_PUBLIC_PRODUCTS:
            return "gizli"  # arayuz esigin altindaki trendi gostermez
        if self.count < LOW_MATCH_THRESHOLD:
            return "az"
        return "tamam"


def fetch_candidates(conn: psycopg.Connection, profile: Profile) -> list[Candidate]:
    patterns = sorted({sql_pattern(term) for term in profile.core})
    if not patterns:
        return []
    with conn.cursor() as cur:
        cur.execute(CANDIDATES_SQL, {"patterns": patterns})
        return [
            Candidate(
                product_id=row[0],
                title=row[1],
                brand=row[2],
                category_path=row[3],
                merchant=row[4],
                min_price=row[5],
                offer_count=row[6],
            )
            for row in cur.fetchall()
        ]


def curate_trend(conn: psycopg.Connection, slug: str, title: str) -> TrendResult:
    profile = BY_SLUG.get(slug)
    if profile is None:
        return TrendResult(slug, title, 0, note="profil tanimli degil")
    if not profile.core:
        return TrendResult(slug, title, 0, note=profile.note)
    candidates = fetch_candidates(conn, profile)
    scored = [s for c in candidates if (s := score_candidate(profile, c)) is not None]
    return TrendResult(slug, title, len(scored), select_diverse(profile, scored))


def load_trends(conn: psycopg.Connection, slugs: list[str] | None) -> list[tuple[int, str, str]]:
    """Yayinlanmis ve taslak trendler (taslak baglari da hazir tutulur; arayuz yalniz
    yayinlananlari okur). `trend` tablosu YOKSA (0056 uygulanmamis ortam) profillerden
    `(0, slug, slug)` doner: yalniz KURU KOSU icin; yazim yolu `trend_id = 0` ile
    asla calismaz (`run` bunu reddeder)."""
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('trend') IS NOT NULL")
        has_table = bool(cur.fetchone()[0])
        if not has_table:
            return [(0, p.slug, p.slug) for p in PROFILES if not slugs or p.slug in slugs]
        cur.execute(
            "SELECT id, slug, title FROM trend WHERE status IN ('published', 'draft') "
            "AND (%(all)s OR slug = ANY(%(slugs)s)) ORDER BY sort_order, id",
            {"all": not slugs, "slugs": slugs or []},
        )
        return list(cur.fetchall())


def write_trend(conn: psycopg.Connection, trend_id: int, result: TrendResult) -> None:
    """Trend baglarini yeniden yazar. Esigin altindaki trend icin baglar TEMIZLENIR
    (eski eslesme bayatlamis olabilir; az urunle bozuk izgara gosterilmez)."""
    rows = (
        [(trend_id, s.candidate.product_id, i) for i, s in enumerate(result.selected)]
        if result.count >= MIN_PUBLIC_PRODUCTS
        else []
    )
    with conn.cursor() as cur:
        cur.execute("DELETE FROM trend_product WHERE trend_id = %s", (trend_id,))
        if rows:
            cur.executemany(
                "INSERT INTO trend_product (trend_id, product_id, sort_order) VALUES (%s, %s, %s)",
                rows,
            )
        cur.execute("UPDATE trend SET updated_at = now() WHERE id = %s", (trend_id,))


def run(
    conn: psycopg.Connection, *, apply: bool, slugs: list[str] | None = None
) -> list[TrendResult]:
    """Kuru kosuda islem SUNUCU TARAFINDA salt-okunurdur (`BEGIN READ ONLY`):
    yanlislikla bir yazim yolu eklense bile veritabani reddeder. Isleme baslamadan
    once ayarlanir; acik bir islem varsa kapatilir."""
    if not apply:
        conn.rollback()
        conn.read_only = True
    results: list[TrendResult] = []
    for trend_id, slug, title in load_trends(conn, slugs):
        result = curate_trend(conn, slug, title)
        results.append(result)
        if apply:
            if trend_id == 0:
                raise RuntimeError("trend tablosu yok: --apply calistirilamaz (0056 uygulanmali)")
            write_trend(conn, trend_id, result)
    if apply:
        conn.commit()
    else:
        conn.rollback()
        conn.read_only = False
    return results


def is_local_url(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host in {"localhost", "127.0.0.1", "::1"}
