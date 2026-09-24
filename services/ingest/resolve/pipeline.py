"""Eslestirme boru hatti.

    offer (product_id NULL)
      -> adaylar (gtin / trigram / gorsel ANN)
      -> skorla, veto uygula
           >= AUTO_ACCEPT  match_candidate(auto_accepted) + offer.product_id BAGLANIR
           >= QUEUE        match_candidate(pending)       — insan kuyrugu (D5)
           <  QUEUE        YENI product acilir + offer baglanir

Ikinci kosu zaten `product_id` dolu olan offer'i hic secmez; ayrica
`match_candidate_uniq (offer_id, product_id)` tekrar yazimi engeller.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

import psycopg

from resolve import candidates as candidate_channels
from resolve import products
from resolve.normalize import ProductKey
from resolve.score import ScoreResult, auto_accept_threshold, combine, queue_threshold

logger = logging.getLogger(__name__)

PENDING_OFFERS = """
SELECT o.id, o.title_raw, o.brand_raw, o.category_raw, o.image_url, o.attributes_raw,
       m.feed_config->>'category_hint', o.merchant_id
  FROM offer o
  JOIN merchant m ON m.id = o.merchant_id
 WHERE o.is_active AND o.product_id IS NULL
   AND (%(merchant_id)s::bigint IS NULL OR o.merchant_id = %(merchant_id)s)
 ORDER BY o.id
 LIMIT %(limit)s
"""

OFFER_VECTOR = """
SELECT e.vector::text, e.model_version FROM embedding e
 WHERE e.target_type = 'offer' AND e.target_id = %(offer_id)s AND e.kind = 'image'
 ORDER BY e.created_at DESC LIMIT 1
"""

UPSERT_CANDIDATE = """
INSERT INTO match_candidate (offer_id, product_id, score, method, status)
VALUES (%(offer_id)s, %(product_id)s, %(score)s, %(method)s, %(status)s)
ON CONFLICT (offer_id, product_id) DO UPDATE SET
    score  = EXCLUDED.score,
    method = EXCLUDED.method,
    -- Insan bir karar verdiyse (accepted/rejected) makine onu EZMEZ.
    status = CASE WHEN match_candidate.status IN ('accepted', 'rejected')
                  THEN match_candidate.status ELSE EXCLUDED.status END
RETURNING id
"""

#: Ayni merchant'in ZATEN bagli teklifi olan urunler. Bir magaza ayni kanonik
#: urunu iki ayri kayitla satmaz; ayni magazadaki iki kayit ayni urun
#: iddiasi pratikte renk kardesi ya da tekil parca (hali, vintage) demektir.
SAME_MERCHANT_PRODUCTS = """
SELECT DISTINCT product_id FROM offer
 WHERE merchant_id = %(merchant_id)s AND product_id = ANY(%(product_ids)s)
   AND id <> %(offer_id)s
"""

LINK_OFFER = "UPDATE offer SET product_id = %(product_id)s WHERE id = %(offer_id)s"


@dataclass
class ResolveCounts:
    considered: int = 0
    auto_accepted: int = 0
    queued: int = 0
    products_created: int = 0
    errors: list[str] = field(default_factory=list)


def _offer_key(title: str, brand: str | None, attributes: dict | None) -> ProductKey:
    extra = attributes or {}
    return ProductKey.build(
        title=title,
        brand=brand,
        # Shopify connector'i renk grubunu `color` olarak yazar (0024).
        color=extra.get("color"),
        # B2 barkodu `attributes_raw` icine yaziyor: `offer` tablosunda gtin
        # kolonu yok, barkod kanonik `product` uzerinde durur.
        gtin=extra.get("gtin"),
        mpn=extra.get("mpn"),
    )


def _candidate_key(candidate: candidate_channels.Candidate) -> ProductKey:
    return ProductKey.build(
        title=candidate.title,
        brand=candidate.brand,
        color=candidate.color,
        gtin=candidate.gtin,
        mpn=candidate.mpn,
    )


def best_match(
    conn: psycopg.Connection,
    offer_id: int,
    key: ProductKey,
    title: str,
    merchant_id: int | None = None,
) -> tuple[candidate_channels.Candidate, ScoreResult] | None:
    """Katmanli akis: gtin/mpn kesin sonuc verirse orada durur."""
    exact = candidate_channels.by_exact_identifier(conn, key.gtin, key.mpn)
    for candidate in exact:
        result = combine(key, _candidate_key(candidate))
        if result.method in {"gtin", "mpn"} and not result.vetoed:
            return candidate, result

    with conn.cursor() as cur:
        cur.execute(OFFER_VECTOR, {"offer_id": offer_id})
        row = cur.fetchone()
    vector_text, model_version = (row[0], row[1]) if row else (None, None)

    image_candidates = (
        candidate_channels.by_image(conn, offer_id, vector_text, model_version)
        if vector_text and model_version
        else []
    )
    pool = candidate_channels.deduplicate(
        [exact, candidate_channels.by_title(conn, title), image_candidates]
    )
    if pool and merchant_id is not None:
        with conn.cursor() as cur:
            cur.execute(
                SAME_MERCHANT_PRODUCTS,
                {
                    "merchant_id": merchant_id,
                    "product_ids": [c.product_id for c in pool],
                    "offer_id": offer_id,
                },
            )
            taken = {int(row[0]) for row in cur.fetchall()}
        pool = [candidate for candidate in pool if candidate.product_id not in taken]
    if not pool:
        return None

    scored = [(candidate, combine(key, _candidate_key(candidate))) for candidate in pool]
    winner = max(scored, key=lambda pair: pair[1].score)
    return winner if not winner[1].vetoed else None


def resolve_offers(
    conn: psycopg.Connection,
    *,
    limit: int = 500,
    merchant_id: int | None = None,
    create_missing: bool = True,
) -> ResolveCounts:
    counts = ResolveCounts()
    auto = auto_accept_threshold()
    queue = queue_threshold()

    with conn.cursor() as cur:
        cur.execute(PENDING_OFFERS, {"merchant_id": merchant_id, "limit": limit})
        rows = cur.fetchall()
    counts.considered = len(rows)

    for (
        offer_id,
        title,
        brand,
        category,
        image_url,
        attributes_raw,
        category_hint,
        offer_merchant_id,
    ) in rows:
        attributes = (
            attributes_raw
            if isinstance(attributes_raw, dict)
            else json.loads(attributes_raw or "{}")
        )
        key = _offer_key(title, brand, attributes)

        try:
            found = best_match(conn, int(offer_id), key, title, int(offer_merchant_id))
        except psycopg.Error as error:
            counts.errors.append(f"offer {offer_id}: {error}")
            logger.warning("aday uretilemedi %s: %s", offer_id, error)
            continue

        if found is not None and found[1].score >= queue:
            candidate, result = found
            # Gorsel ya da metin skoru ne kadar yuksek olursa olsun, dogrulanamayan
            # renk otomatik kabul edilmez (0029).
            status = "auto_accepted" if result.score >= auto and not result.review else "pending"
            with conn.cursor() as cur:
                cur.execute(
                    UPSERT_CANDIDATE,
                    {
                        "offer_id": offer_id,
                        "product_id": candidate.product_id,
                        "score": round(result.score, 4),
                        "method": result.method,
                        "status": status,
                    },
                )
            if status == "auto_accepted":
                with conn.cursor() as cur:
                    cur.execute(
                        LINK_OFFER, {"product_id": candidate.product_id, "offer_id": offer_id}
                    )
                counts.auto_accepted += 1
            else:
                # Bilerek BAGLANMAZ: esigin altindaki iddia insan onayina duser.
                counts.queued += 1
            continue

        if not create_missing:
            continue

        product_id = products.create_from_offer(
            conn,
            title=title,
            brand=brand,
            category_path=category,
            fallback_category_path=category_hint,
            color=key.color,
            image_url=image_url,
            gtin=key.gtin,
            mpn=key.mpn,
        )
        with conn.cursor() as cur:
            cur.execute(LINK_OFFER, {"product_id": product_id, "offer_id": offer_id})
        counts.products_created += 1

    return counts
