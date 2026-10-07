"""Toplu (chunk'li) eslestirme (karar 0069).

`resolve.pipeline.resolve_offers_sequential` her offer icin ~8-14 ayri sorgu
atar ve tum isi tek islemde tutar: uzak veritabaninda (RTT ~158 ms) 1.723
offer 42 dakika surdu. Bu modul AYNI karari verir ama sorgulari chunk
duzeyinde toplulastirir:

1. **Chunk** = ayni merchant'in en fazla `CHUNK_OFFERS` eslesmemis offer'i
   (`merchant_id, id` sirasiyla). Chunk kendi islemini (SAVEPOINT) ve
   istenirse kendi commit'ini tasir; bir chunk'in hatasi digerlerini durdurmaz.
2. **Toplu okuma** (set-based, `unnest` + LATERAL): insan kararlari, varyant
   barkodlari, gorsel vektorleri, kesin kimlik / varyant-barkod / baslik
   trigram / gorsel adaylari, "ayni merchant zaten bagli" urunler, barkod
   kumeleri, hacim metinleri. Sabit sayida ifade; offer sayisina bagli degil.
3. **Karar** Python'da, `pipeline.best_match` ile ayni akis ve AYNI skor /
   veto / auto-accept fonksiyonlariyla (`resolve.score`, `resolve.identifiers`).
   Chunk icindeki bagimlilik bellekte izlenir: bir offer'in urune baglanmasi
   ya da yeni urun acmasi, sonraki offer icin "ayni merchant zaten bagli",
   kesin barkod ve hacim/barkod kumelerini guncel tutar — ardisik calismanin
   gorecegi durumla ayni.
4. **Toplu yazim**: marka/kategori/slug cozumu, yeni urunler, `match_candidate`
   ve `offer.product_id` baglama `unnest` ile.

Chunk tek merchant'a ait oldugu icin ayni merchant'in baska offer'inin urettigi
urun ayni chunk'taki bir offer'a aday OLAMAZ (ayni-merchant kurali); farkli
merchant'larin birbirinin urununu gormesi chunk sirasi (merchant sirali) ve
commit ile korunur. Jina/embedding burada model cagirmaz; yalnizca onceden
uretilmis vektorleri okur.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field, replace
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from resolve import candidates as channels
from resolve import identifiers, products
from resolve.normalize import ProductKey, extract_color, extract_volume
from resolve.pipeline import (
    ResolveCounts,
    _candidate_key,
    _offer_key,
    explain_match,
)
from resolve.score import (
    ScoreResult,
    auto_eligible,
    combine,
    queue_threshold,
)

logger = logging.getLogger(__name__)

#: Chunk basina offer. Toplu okuma ~12 ifade ve toplu yazim ~8 ifade (~3 sn uzak
#: RTT); 200 offer ~1.100 varyant satiri demektir (okuma boyutu makul), bir
#: chunk'in hatasi en fazla bu kadar offer'i etkiler.
CHUNK_OFFERS = 200

#: Slug carpismasinda bir seferde sorgulanan sonek sayisi.
SLUG_PROBES = 8

PENDING = """
SELECT o.id, o.title_raw, o.brand_raw, o.category_raw, o.image_url, o.attributes_raw,
       m.feed_config->>'category_hint', o.merchant_id
  FROM offer o
  JOIN merchant m ON m.id = o.merchant_id
 WHERE o.is_active AND o.product_id IS NULL
   AND (%(merchant_id)s::bigint IS NULL OR o.merchant_id = %(merchant_id)s)
   AND (o.merchant_id, o.id) > (%(after_merchant)s, %(after_id)s)
 ORDER BY o.merchant_id, o.id
 LIMIT %(limit)s
"""

CANDIDATES_STATUS = """
SELECT offer_id, product_id, status FROM match_candidate WHERE offer_id = ANY(%(offer_ids)s)
"""

VARIANTS = """
SELECT offer_id, gtin, size_label FROM offer_variant WHERE offer_id = ANY(%(offer_ids)s)
"""

VECTORS = """
SELECT DISTINCT ON (e.target_id) e.target_id, e.vector::text, e.model_version
  FROM embedding e
 WHERE e.target_type = 'offer' AND e.kind = 'image' AND e.target_id = ANY(%(offer_ids)s)
 ORDER BY e.target_id, e.created_at DESC
"""

_PRODUCT = "p.id, p.title, b.name, p.color, p.gtin, p.mpn"

EXACT = f"""
SELECT t.idx, {_PRODUCT}
  FROM unnest(%(idx)s::int[], %(gtin)s::text[], %(mpn)s::text[]) AS t(idx, gtin, mpn)
 CROSS JOIN LATERAL (
        SELECT p0.id, p0.title, p0.brand_id, p0.color, p0.gtin, p0.mpn FROM product p0
         WHERE (p0.gtin IS NOT NULL AND p0.gtin = t.gtin)
            OR (p0.mpn IS NOT NULL AND p0.mpn = t.mpn)
         ORDER BY p0.id
         LIMIT %(limit)s) p
  LEFT JOIN brand b ON b.id = p.brand_id
"""

VARIANT_EXACT = f"""
SELECT t.idx, {_PRODUCT}, x.gtin, x.size_label
  FROM unnest(%(idx)s::int[], %(offer_id)s::bigint[], %(gtin)s::text[])
       AS t(idx, offer_id, gtin)
 CROSS JOIN LATERAL (
        SELECT o.product_id, ov.gtin, ov.size_label
          FROM offer_variant ov JOIN offer o ON o.id = ov.offer_id
         WHERE ov.gtin = t.gtin AND o.is_active AND o.product_id IS NOT NULL
           AND o.id <> t.offer_id
        UNION
        SELECT p2.id, p2.gtin, NULL::text FROM product p2 WHERE p2.gtin = t.gtin) x
  JOIN product p ON p.id = x.product_id
  LEFT JOIN brand b ON b.id = p.brand_id
"""

# `%%` psycopg icin kacis: SQL'e tek `%` (pg_trgm) gider.
TITLE = f"""
SELECT t.idx, {_PRODUCT}, p.sim
  FROM unnest(%(idx)s::int[], %(title)s::text[]) AS t(idx, title)
 CROSS JOIN LATERAL (
        SELECT p0.id, p0.title, p0.brand_id, p0.color, p0.gtin, p0.mpn,
               similarity(p0.title, t.title) AS sim
          FROM product p0
         WHERE p0.title %% t.title
         ORDER BY similarity(p0.title, t.title) DESC, p0.id
         LIMIT %(limit)s) p
  LEFT JOIN brand b ON b.id = p.brand_id
"""

IMAGE = f"""
SELECT t.idx, {_PRODUCT}
  FROM unnest(%(idx)s::int[], %(offer_id)s::bigint[], %(vector)s::text[],
              %(model_version)s::text[]) AS t(idx, offer_id, vector, model_version)
 CROSS JOIN LATERAL (
        SELECT DISTINCT ON (p0.id) p0.id, p0.title, p0.brand_id, p0.color, p0.gtin, p0.mpn
          FROM embedding e
          JOIN offer o ON o.id = e.target_id
          JOIN product p0 ON p0.id = o.product_id
         WHERE e.target_type = 'offer' AND e.kind = 'image'
           AND e.model_version = t.model_version
           AND o.product_id IS NOT NULL
           AND e.target_id <> t.offer_id
         ORDER BY p0.id, e.vector <=> t.vector::vector
         LIMIT %(limit)s) p
  LEFT JOIN brand b ON b.id = p.brand_id
"""

TAKEN = """
SELECT DISTINCT product_id FROM offer
 WHERE merchant_id = %(merchant_id)s AND product_id = ANY(%(product_ids)s)
"""

GTIN_SETS = """
SELECT o.product_id,
       array_remove(array_agg(DISTINCT COALESCE(ov.gtin, o.attributes_raw->>'gtin')), NULL),
       bool_and(COALESCE(ov.gtin, o.attributes_raw->>'gtin') IS NOT NULL)
  FROM offer o
  LEFT JOIN offer_variant ov ON ov.offer_id = o.id
 WHERE o.product_id = ANY(%(product_ids)s) AND o.is_active
 GROUP BY o.product_id
"""

VOLUME_TEXTS = """
SELECT o.product_id, COALESCE(ov.size_label, o.title_raw)
  FROM offer o LEFT JOIN offer_variant ov ON ov.offer_id = o.id
 WHERE o.product_id = ANY(%(product_ids)s) AND o.is_active
"""

UPSERT_CANDIDATES = """
INSERT INTO match_candidate (offer_id, product_id, score, method, status, explain)
SELECT t.offer_id, t.product_id, t.score, t.method, t.status, t.explain
  FROM unnest(%(offer_id)s::bigint[], %(product_id)s::bigint[], %(score)s::numeric[],
              %(method)s::text[], %(status)s::text[], %(explain)s::jsonb[])
       AS t(offer_id, product_id, score, method, status, explain)
ON CONFLICT (offer_id, product_id) DO UPDATE SET
    score   = EXCLUDED.score,
    method  = EXCLUDED.method,
    -- Aciklama makine verisidir; insan karari olan satirda da guncellenir.
    explain = EXCLUDED.explain,
    -- Insan bir karar verdiyse (accepted/rejected) makine onu EZMEZ.
    status = CASE WHEN match_candidate.status IN ('accepted', 'rejected')
                  THEN match_candidate.status ELSE EXCLUDED.status END
RETURNING offer_id, product_id, status
"""

LINK = """
UPDATE offer SET product_id = t.product_id
  FROM unnest(%(offer_id)s::bigint[], %(product_id)s::bigint[]) AS t(offer_id, product_id)
 WHERE offer.id = t.offer_id AND offer.product_id IS NULL
"""

INSERT_PRODUCTS = """
INSERT INTO product (slug, title, brand_id, category_id, gtin, mpn, color, primary_image_url)
SELECT t.slug, t.title, t.brand_id, t.category_id, t.gtin, t.mpn, t.color, t.image_url
  FROM unnest(%(slug)s::text[], %(title)s::text[], %(brand_id)s::bigint[],
              %(category_id)s::bigint[], %(gtin)s::text[], %(mpn)s::text[], %(color)s::text[],
              %(image_url)s::text[])
       AS t(slug, title, brand_id, category_id, gtin, mpn, color, image_url)
RETURNING id, slug
"""

INSERT_BRANDS = """
INSERT INTO brand (slug, name, name_norm)
SELECT t.slug, t.name, t.name_norm
  FROM unnest(%(slug)s::text[], %(name)s::text[], %(name_norm)s::text[]) AS t(slug, name, name_norm)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
RETURNING id, slug, name_norm
"""


@dataclass
class _Offer:
    idx: int
    id: int
    title: str
    brand: str | None
    category: str | None
    image_url: str | None
    category_hint: str | None
    merchant_id: int
    key: ProductKey
    #: (gtin | None, size_label | None) tum varyantlari
    variants: list[tuple[str | None, str | None]] = field(default_factory=list)
    identity: identifiers.OfferIdentity | None = None
    vector: tuple[str, str] | None = None
    rejected: set[int] = field(default_factory=set)
    existing_status: dict[int, str] = field(default_factory=dict)
    # ham aday satirlari (anlik goruntu)
    exact: list[channels.Candidate] = field(default_factory=list)
    variant_exact: list[tuple] = field(default_factory=list)
    title_rows: list[channels.Candidate] = field(default_factory=list)
    image_rows: list[channels.Candidate] = field(default_factory=list)


@dataclass
class _Decision:
    offer: _Offer
    #: gercek urun kimligi ya da `-n` (bu chunk'ta acilacak urun)
    product_ref: int
    result: ScoreResult | None = None
    candidate: channels.Candidate | None = None
    status: str | None = None
    explain: dict | None = None
    create: bool = False
    linked: bool = False


def _candidates(rows: list[tuple]) -> list[channels.Candidate]:
    return [
        channels.Candidate(
            product_id=int(r[0]),
            title=r[1],
            brand=r[2],
            color=r[3],
            gtin=r[4],
            mpn=r[5],
            channel="",
        )
        for r in rows
    ]


class _Chunk:
    """Tek merchant'in bir chunk'i: toplu okuma, sirali karar, toplu yazim."""

    def __init__(
        self,
        conn: psycopg.Connection,
        rows: list[tuple],
        infer_index: dict[str, str],
        display_brands: dict[str, str],
        *,
        create_missing: bool,
    ) -> None:
        self.conn = conn
        #: Marka CIKARIMI koşu basindaki indekse bakar (`pipeline.resolve_offers_sequential`
        #: ile ayni; bu kosuda acilan yeni markalar cikarima girmez).
        #: `display_brands` ise yalnizca gorunen ad icindir ve kosu boyunca buyur.
        self.brands = display_brands
        self.create_missing = create_missing
        self.queue = queue_threshold()
        self.merchant_id = int(rows[0][7])
        self.offers: list[_Offer] = []
        for idx, (oid, title, brand, category, image_url, attrs, hint, merchant_id) in enumerate(
            rows
        ):
            attributes = attrs if isinstance(attrs, dict) else json.loads(attrs or "{}")
            brand = brand or products.infer_brand(title, infer_index)
            self.offers.append(
                _Offer(
                    idx=idx,
                    id=int(oid),
                    title=title,
                    brand=brand,
                    category=category,
                    image_url=image_url,
                    category_hint=hint,
                    merchant_id=int(merchant_id),
                    key=_offer_key(title, brand, attributes),
                )
            )
        self.by_id = {offer.id: offer for offer in self.offers}
        # chunk ici durum
        self.taken: set[int] = set()
        self.sets: dict[int, tuple[set[str], bool]] = {}
        self.volumes: dict[int, set[str | None]] = {}
        self.reg_variant: dict[str, list[tuple]] = {}
        self.reg_exact: list[channels.Candidate] = []
        self.new_products: list[_Decision] = []
        self.score_cache: dict[tuple[int, int], ScoreResult] = {}

    # -- toplu okuma ---------------------------------------------------------

    def _fetch(self, sql: str, params: dict[str, Any]) -> list[tuple]:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()

    def prefetch(self) -> None:
        ids = [o.id for o in self.offers]
        for offer_id, product_id, status in self._fetch(CANDIDATES_STATUS, {"offer_ids": ids}):
            offer = self.by_id[int(offer_id)]
            offer.existing_status[int(product_id)] = status
            if status == "rejected":
                offer.rejected.add(int(product_id))

        for offer_id, gtin, size_label in self._fetch(VARIANTS, {"offer_ids": ids}):
            self.by_id[int(offer_id)].variants.append((gtin, size_label))

        for offer in self.offers:
            gtins: dict[str, str | None] = {}
            if offer.key.gtin:
                gtins[offer.key.gtin] = offer.key.volume
            for gtin, size_label in offer.variants:
                if gtin:
                    gtins.setdefault(str(gtin), extract_volume(size_label or ""))
            offer.identity = identifiers.OfferIdentity(gtins=gtins)

        for offer_id, vector, model_version in self._fetch(VECTORS, {"offer_ids": ids}):
            if vector and model_version:
                self.by_id[int(offer_id)].vector = (vector, model_version)

        limit = channels.PER_CHANNEL_LIMIT
        exact = [o for o in self.offers if o.key.gtin or o.key.mpn]
        if exact:
            for row in self._fetch(
                EXACT,
                {
                    "idx": [o.idx for o in exact],
                    "gtin": [o.key.gtin for o in exact],
                    "mpn": [o.key.mpn for o in exact],
                    "limit": limit,
                },
            ):
                self.offers[int(row[0])].exact.append(
                    replace(_candidates([row[1:]])[0], channel="exact")
                )

        with_gtins = [
            (o, g) for o in self.offers for g in (o.identity.values if o.identity else [])
        ]
        if with_gtins:
            for row in self._fetch(
                VARIANT_EXACT,
                {
                    "idx": [o.idx for o, _ in with_gtins],
                    "offer_id": [o.id for o, _ in with_gtins],
                    "gtin": [g for _, g in with_gtins],
                },
            ):
                self.offers[int(row[0])].variant_exact.append(tuple(row[1:]))

        titled = [o for o in self.offers if o.title.strip()]
        if titled:
            scored: dict[int, list[tuple[float, channels.Candidate]]] = {}
            for row in self._fetch(
                TITLE,
                {
                    "idx": [o.idx for o in titled],
                    "title": [o.title for o in titled],
                    "limit": limit,
                },
            ):
                scored.setdefault(int(row[0]), []).append(
                    (float(row[7]), replace(_candidates([row[1:7]])[0], channel="text"))
                )
            for idx, items in scored.items():
                items.sort(key=lambda item: (-item[0], item[1].product_id))
                self.offers[idx].title_rows = [candidate for _, candidate in items]

        imaged = [o for o in self.offers if o.vector]
        if imaged:
            for row in self._fetch(
                IMAGE,
                {
                    "idx": [o.idx for o in imaged],
                    "offer_id": [o.id for o in imaged],
                    "vector": [o.vector[0] for o in imaged if o.vector],
                    "model_version": [o.vector[1] for o in imaged if o.vector],
                    "limit": limit,
                },
            ):
                self.offers[int(row[0])].image_rows.append(
                    replace(_candidates([row[1:]])[0], channel="image")
                )

        # Havuzdaki urunler icin: ayni merchant bagli mi, barkod kumesi, hacimler.
        pool_ids: set[int] = set()
        volume_ids: set[int] = set()
        gtin_ids: set[int] = set()
        for offer in self.offers:
            pool = self._pool(offer, taken=set())
            pool_ids.update(c.product_id for c in pool)
            if offer.identity and offer.identity.gtins:
                gtin_ids.update(c.product_id for c in pool)
            if offer.key.volume:
                for candidate in pool:
                    score = self._score(offer, candidate)
                    if not score.vetoed and score.score >= self.queue:
                        volume_ids.add(candidate.product_id)
        if pool_ids:
            self.taken = {
                int(r[0])
                for r in self._fetch(
                    TAKEN, {"merchant_id": self.merchant_id, "product_ids": sorted(pool_ids)}
                )
            }
        if gtin_ids:
            for pid, gtins, complete in self._fetch(GTIN_SETS, {"product_ids": sorted(gtin_ids)}):
                self.sets[int(pid)] = (set(gtins or ()), bool(complete))
        if volume_ids:
            for pid, text in self._fetch(VOLUME_TEXTS, {"product_ids": sorted(volume_ids)}):
                self.volumes.setdefault(int(pid), set()).add(extract_volume(text or ""))

    # -- karar ---------------------------------------------------------------

    def _score(self, offer: _Offer, candidate: channels.Candidate) -> ScoreResult:
        cache_key = (offer.idx, candidate.product_id)
        cached = self.score_cache.get(cache_key)
        if cached is None:
            cached = combine(offer.key, _candidate_key(candidate))
            self.score_cache[cache_key] = cached
        return cached

    def _exact(self, offer: _Offer) -> list[channels.Candidate]:
        extra = [
            c
            for c in self.reg_exact
            if (offer.key.gtin and c.gtin == offer.key.gtin)
            or (offer.key.mpn and c.mpn == offer.key.mpn)
        ]
        return [c for c in [*offer.exact, *extra] if c.product_id not in offer.rejected]

    def _pool(self, offer: _Offer, taken: set[int]) -> list[channels.Candidate]:
        pool = [
            c
            for c in channels.deduplicate([self._exact(offer), offer.title_rows, offer.image_rows])
            if c.product_id not in offer.rejected
        ]
        return [c for c in pool if c.product_id not in taken]

    def _best(self, offer: _Offer) -> tuple[channels.Candidate, ScoreResult] | None:
        """`pipeline.best_match` ile ayni akis, onceden okunmus verilerle."""
        assert offer.identity is not None
        identity = offer.identity
        if identity.gtins:
            rows = list(offer.variant_exact)
            for gtin in identity.values:
                rows.extend(self.reg_variant.get(gtin, []))
            found = identifiers.exact_variant_match_from_rows(rows, offer.key, identity)
            if found is not None and found[0].product_id not in offer.rejected:
                return found

        exact = self._exact(offer)
        for candidate in exact:
            result = self._score(offer, candidate)
            if result.method in {"gtin", "mpn"} and not result.vetoed:
                return candidate, result

        pool = [
            c
            for c in channels.deduplicate([exact, offer.title_rows, offer.image_rows])
            if c.product_id not in offer.rejected
        ]
        if pool:
            pool = [c for c in pool if c.product_id not in self.taken]
        if identity.gtins and pool:
            known = {
                c.product_id: self.sets[c.product_id] for c in pool if c.product_id in self.sets
            }
            disjoint = identifiers.disjoint_from_sets(known, identity)
            pool = [c for c in pool if c.product_id not in disjoint]
        if not pool:
            return None

        scored = [(c, self._score(offer, c)) for c in pool]
        winner = max(scored, key=lambda pair: pair[1].score)
        if winner[1].vetoed:
            return None
        if not winner[1].review:
            reason = identifiers.volume_conflict(
                offer.key, self.volumes.get(winner[0].product_id, set())
            )
            if reason:
                winner = (winner[0], replace(winner[1], review=reason))
        return winner

    def _volume_labels(self, offer: _Offer) -> set[str | None]:
        # COALESCE(ov.size_label, o.title_raw): varyant yoksa baslik.
        if not offer.variants:
            return {extract_volume(offer.title or "")}
        return {
            extract_volume((size_label if size_label is not None else offer.title) or "")
            for _, size_label in offer.variants
        }

    def _register(self, offer: _Offer, candidate: channels.Candidate, product_ref: int) -> None:
        """Offer urune baglandi / urun acildi: sonraki offer'lar icin durumu guncelle."""
        self.taken.add(product_ref)
        gtins, complete = self.sets.get(product_ref, (set(), True))
        rows = offer.variants or [(None, None)]
        offer_gtin = offer.key.gtin
        row_gtins = [(g or offer_gtin) for g, _ in rows]
        self.sets[product_ref] = (
            gtins | {g for g in row_gtins if g},
            complete and all(g is not None for g in row_gtins),
        )
        self.volumes.setdefault(product_ref, set()).update(self._volume_labels(offer))
        shown = replace(candidate, product_id=product_ref)
        for gtin, size_label in offer.variants:
            if gtin:
                self.reg_variant.setdefault(str(gtin), []).append(
                    (
                        product_ref,
                        shown.title,
                        shown.brand,
                        shown.color,
                        shown.gtin,
                        shown.mpn,
                        str(gtin),
                        size_label,
                    )
                )

    def decide(self, counts: ResolveCounts) -> list[_Decision]:
        decisions: list[_Decision] = []
        next_ref = -1
        for offer in self.offers:
            found = self._best(offer)
            if found is not None and found[1].score >= self.queue:
                candidate, result = found
                candidate_key = _candidate_key(candidate)
                eligible = auto_eligible(result, offer.key, candidate_key)
                status = "auto_accepted" if eligible else "pending"
                stored = offer.existing_status.get(candidate.product_id)
                stored_status = stored if stored in ("accepted", "rejected") else status
                decision = _Decision(
                    offer=offer,
                    product_ref=candidate.product_id,
                    result=result,
                    candidate=candidate,
                    status=status,
                    explain=explain_match(result, offer.key, candidate_key, eligible),
                )
                if status == "auto_accepted" and stored_status == "auto_accepted":
                    decision.linked = True
                    counts.auto_accepted += 1
                    self._register(offer, candidate, candidate.product_id)
                else:
                    # Bilerek BAGLANMAZ: esigin altindaki iddia insan onayina duser.
                    counts.queued += 1
                decisions.append(decision)
                continue
            if not self.create_missing:
                continue
            color = offer.key.color or extract_color(offer.title)
            shown = channels.Candidate(
                product_id=next_ref,
                title=offer.title.strip(),
                brand=self._display_brand(offer.brand),
                color=color,
                gtin=offer.key.gtin,
                mpn=offer.key.mpn,
                channel="exact",
            )
            decision = _Decision(offer=offer, product_ref=next_ref, create=True, linked=True)
            decision.candidate = shown
            self.new_products.append(decision)
            decisions.append(decision)
            if shown.gtin or shown.mpn:
                self.reg_exact.append(shown)
            if shown.gtin:
                self.reg_variant.setdefault(shown.gtin, []).append(
                    (
                        next_ref,
                        shown.title,
                        shown.brand,
                        shown.color,
                        shown.gtin,
                        shown.mpn,
                        shown.gtin,
                        None,
                    )
                )
            self._register(offer, shown, next_ref)
            counts.products_created += 1
            next_ref -= 1
        return decisions

    def _display_brand(self, brand: str | None) -> str | None:
        if not brand or not brand.strip():
            return None
        norm = products.strip_accents(brand).lower().replace(" ", "")
        return self.brands.get(norm, brand.strip())

    # -- toplu yazim ---------------------------------------------------------

    def persist(self, decisions: list[_Decision]) -> None:
        refs = self._create_products()
        resolved = {d.offer.id: refs.get(d.product_ref, d.product_ref) for d in decisions}

        rows = [d for d in decisions if not d.create and d.candidate is not None]
        stored: dict[tuple[int, int], str] = {}
        if rows:
            with self.conn.cursor() as cur:
                cur.execute(
                    UPSERT_CANDIDATES,
                    {
                        "offer_id": [d.offer.id for d in rows],
                        "product_id": [resolved[d.offer.id] for d in rows],
                        "score": [round(d.result.score, 4) for d in rows if d.result],
                        "method": [d.result.method for d in rows if d.result],
                        "status": [d.status for d in rows],
                        "explain": [Jsonb(d.explain) for d in rows],
                    },
                )
                stored = {(int(o), int(p)): s for o, p, s in cur.fetchall()}

        links = [
            (d.offer.id, resolved[d.offer.id])
            for d in decisions
            if d.linked
            and (d.create or stored.get((d.offer.id, resolved[d.offer.id])) == "auto_accepted")
        ]
        if links:
            with self.conn.cursor() as cur:
                cur.execute(
                    LINK,
                    {"offer_id": [o for o, _ in links], "product_id": [p for _, p in links]},
                )

    def _create_products(self) -> dict[int, int]:
        """Yeni urunler: marka/kategori/slug toplu cozum, tek INSERT. `-n` -> gercek id."""
        if not self.new_products:
            return {}
        brand_ids = self._resolve_brands({d.offer.brand for d in self.new_products})
        category_ids = self._resolve_categories(
            {p for d in self.new_products for p in (d.offer.category, d.offer.category_hint)}
        )
        slugs = self._assign_slugs(
            [
                products.slugify(
                    products.slug_base(
                        title=d.offer.title, brand=d.offer.brand, color=d.offer.key.color
                    )
                )
                for d in self.new_products
            ]
        )
        with self.conn.cursor() as cur:
            cur.execute(
                INSERT_PRODUCTS,
                {
                    "slug": slugs,
                    "title": [d.offer.title.strip() for d in self.new_products],
                    "brand_id": [brand_ids.get(d.offer.brand) for d in self.new_products],
                    "category_id": [
                        category_ids.get((d.offer.category or "").strip())
                        or category_ids.get((d.offer.category_hint or "").strip())
                        for d in self.new_products
                    ],
                    "gtin": [d.offer.key.gtin for d in self.new_products],
                    "mpn": [d.offer.key.mpn for d in self.new_products],
                    "color": [
                        d.offer.key.color or extract_color(d.offer.title) for d in self.new_products
                    ],
                    "image_url": [d.offer.image_url for d in self.new_products],
                },
            )
            by_slug = {slug: int(pid) for pid, slug in cur.fetchall()}
        for decision, slug in zip(self.new_products, slugs, strict=True):
            logger.info("yeni urun acildi: %s (%s)", decision.offer.title.strip(), slug)
        return {
            d.product_ref: by_slug[slug] for d, slug in zip(self.new_products, slugs, strict=True)
        }

    def _resolve_brands(self, names: set[str | None]) -> dict[str | None, int]:
        wanted = {
            name: products.strip_accents(name).lower().replace(" ", "")
            for name in names
            if name and name.strip()
        }
        if not wanted:
            return {}
        by_norm: dict[str, int] = {}
        for norm, brand_id in self._fetch(
            "SELECT name_norm, id FROM brand WHERE name_norm = ANY(%(norms)s)",
            {"norms": sorted(set(wanted.values()))},
        ):
            by_norm[str(norm)] = int(brand_id)
        missing = {n: v for n, v in wanted.items() if v not in by_norm}
        if missing:
            # Ayni slug'a giden adlar tek satir olur (ON CONFLICT ayni ifadede cift etkilemez).
            rows: dict[str, tuple[str, str]] = {}
            for name, norm in missing.items():
                rows.setdefault(products.slugify(name), (name.strip(), norm))
            by_slug: dict[str, int] = {}
            with self.conn.cursor() as cur:
                cur.execute(
                    INSERT_BRANDS,
                    {
                        "slug": list(rows),
                        "name": [name for name, _ in rows.values()],
                        "name_norm": [norm for _, norm in rows.values()],
                    },
                )
                for brand_id, slug, _norm in cur.fetchall():
                    by_slug[str(slug)] = int(brand_id)
            for name, norm in missing.items():
                by_norm[norm] = by_slug[products.slugify(name)]
                self.brands[norm] = name.strip()
        return {name: by_norm[norm] for name, norm in wanted.items()}

    def _resolve_categories(self, paths: set[str | None]) -> dict[str, int]:
        wanted = sorted({p.strip() for p in paths if p and p.strip()})
        if not wanted:
            return {}
        return {
            str(path): int(cid)
            for path, cid in self._fetch(
                "SELECT path, id FROM category WHERE path = ANY(%(paths)s)", {"paths": wanted}
            )
        }

    def _assign_slugs(self, bases: list[str]) -> list[str]:
        """`unique_slug` ile ayni kural (cakisirsa `-2`, `-3`...), ama tek sorguda ve
        chunk ici cakismalar dahil."""
        probes = {
            candidate
            for base in bases
            for candidate in [base, *(f"{base}-{n}" for n in range(2, 2 + SLUG_PROBES))]
        }
        existing = {
            str(r[0])
            for r in self._fetch(
                "SELECT slug FROM product WHERE slug = ANY(%(slugs)s)", {"slugs": sorted(probes)}
            )
        }
        used: set[str] = set()
        out: list[str] = []

        def taken(candidate: str) -> bool:
            if candidate in used or candidate in existing:
                return True
            if candidate in probes:
                return False
            if self._fetch("SELECT 1 FROM product WHERE slug = %(slug)s", {"slug": candidate}):
                existing.add(candidate)
                return True
            return False

        for base in bases:
            candidate, suffix = base, 2
            while taken(candidate):
                candidate = f"{base}-{suffix}"
                suffix += 1
            used.add(candidate)
            out.append(candidate)
        return out


def resolve_offers_batched(
    conn: psycopg.Connection,
    *,
    limit: int | None = None,
    merchant_id: int | None = None,
    create_missing: bool = True,
    chunk_size: int = CHUNK_OFFERS,
    commit_each_chunk: bool = False,
) -> ResolveCounts:
    """Eslesmemis offer'lari chunk'larla cozer.

    `commit_each_chunk=True` (CLI): her chunk kendi commit'ini alir; kesilirse
    commit edilmis chunk'lar kalir ve yeniden calistirmak kalan offer'lardan
    devam eder (durum `offer.product_id`'dedir, ek checkpoint gerekmez). Hatali
    chunk geri alinir, hata kaydedilir, sonraki chunk'a gecilir.
    `False`: cagirana ait islemde calisir (chunk hatasi SAVEPOINT ile izole)."""
    counts = ResolveCounts()
    infer_index = products.load_brand_index(conn)
    display_brands = dict(infer_index)
    after = (-1, -1)
    remaining = limit

    while remaining is None or remaining > 0:
        take = chunk_size if remaining is None else min(chunk_size, remaining)
        with conn.cursor() as cur:
            cur.execute(
                PENDING,
                {
                    "merchant_id": merchant_id,
                    "after_merchant": after[0],
                    "after_id": after[1],
                    "limit": take,
                },
            )
            rows = cur.fetchall()
        if not rows:
            break
        # Chunk tek merchant'a ait: ilk merchant'in satirlari.
        first = rows[0][7]
        chunk_rows = [row for row in rows if row[7] == first]
        after = (int(first), int(chunk_rows[-1][0]))
        if remaining is not None:
            remaining -= len(chunk_rows)
        counts.considered += len(chunk_rows)

        chunk_counts = ResolveCounts()
        try:
            with conn.transaction():
                chunk = _Chunk(
                    conn, chunk_rows, infer_index, display_brands, create_missing=create_missing
                )
                chunk.prefetch()
                decisions = chunk.decide(chunk_counts)
                chunk.persist(decisions)
        except psycopg.OperationalError:
            raise  # baglanti kopmus: kosuyu durdur, commit edilmis chunk'lar kalir
        except psycopg.Error as error:
            counts.errors.append(
                f"merchant {first} chunk {chunk_rows[0][0]}..{chunk_rows[-1][0]}: {error}"
            )
            logger.warning("chunk cozulemedi: %s", error)
            continue
        counts.auto_accepted += chunk_counts.auto_accepted
        counts.queued += chunk_counts.queued
        counts.products_created += chunk_counts.products_created
        if commit_each_chunk:
            conn.commit()
    return counts
