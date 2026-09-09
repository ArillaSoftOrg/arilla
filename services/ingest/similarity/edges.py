"""`similarity_edge` uretimi.

`docs/search.md`: `similar_cheaper` niyeti `visual` ve `semantic` kenarlarini
kullaniyor. B3'un urettigi iki embedding turu bunlara birebir esleniyor:

    embedding.kind = 'image'  ->  similarity_edge.kind = 'visual'
    embedding.kind = 'text'   ->  similarity_edge.kind = 'semantic'

`same` ve `substitute` bu isin disinda: `same` B4 sonrasi anlamini degistirdi
(ayni urun artik ayni `product_id`), `substitute` ise tiklama ve donusum
verisinden ogrenilir ve ilk aylarda bos kalir.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import psycopg

from similarity.vectors import average, cosine, parse_vector, to_literal

logger = logging.getLogger(__name__)

#: Urun basina en fazla bu kadar kenar (her tur icin ayri).
TOP_N = 8

#: Bu benzerligin altindaki aday kenar olarak YAZILMAZ. Kotu bir alternatif
#: gostermek, az alternatif gostermekten kotudur.
MIN_SCORE = {"visual": 0.55, "semantic": 0.45}

#: `kind` eslemesi: hangi embedding turu hangi kenari besliyor.
EDGE_SOURCE = {"visual": "image", "semantic": "text"}

#: ANN'den kac offer cekilecek. Ayni urunun birden fazla teklifi donebilecegi
#: icin TOP_N'den bol tutuluyor.
ANN_FETCH = 60

PRODUCT_VECTORS = """
SELECT o.product_id, e.vector::text
  FROM embedding e
  JOIN offer o ON o.id = e.target_id
 WHERE e.target_type = 'offer' AND e.kind = %(embedding_kind)s
   AND o.product_id IS NOT NULL AND o.is_active
 ORDER BY o.product_id
"""

# Aday uretimi offer duzeyindeki HNSW indeksi uzerinden: `embedding_ann_idx`
# `WHERE target_type = 'offer'` kismi kosuluyla tanimli. Urun vektoru
# indekslenmedigi icin arama offer'lar uzerinde yapilip urune toplaniyor.
NEAREST_OFFERS = """
SELECT o.product_id, e.vector::text
  FROM embedding e
  JOIN offer o ON o.id = e.target_id
 WHERE e.target_type = 'offer' AND e.kind = %(embedding_kind)s
   AND o.product_id IS NOT NULL AND o.product_id <> %(product_id)s
   AND o.is_active
 ORDER BY e.vector <=> %(vector)s
 LIMIT %(limit)s
"""

UPSERT_EDGE = """
INSERT INTO similarity_edge (product_a, product_b, kind, score, computed_at)
VALUES (%(product_a)s, %(product_b)s, %(kind)s, %(score)s, now())
ON CONFLICT (product_a, product_b, kind)
DO UPDATE SET score = EXCLUDED.score, computed_at = EXCLUDED.computed_at
"""


@dataclass
class EdgeCounts:
    products_with_vector: int = 0
    edges_written: int = 0
    below_floor: int = 0
    #: 5'ten az kenari olan urunler — kabul kriteri bunu izliyor.
    thin_products: list[int] = field(default_factory=list)


def product_vectors(conn: psycopg.Connection, embedding_kind: str) -> dict[int, list[float]]:
    """Her urun icin tekliflerinin ortalama vektoru."""
    with conn.cursor() as cur:
        cur.execute(PRODUCT_VECTORS, {"embedding_kind": embedding_kind})
        rows = cur.fetchall()

    grouped: dict[int, list[list[float]]] = {}
    for product_id, raw in rows:
        grouped.setdefault(int(product_id), []).append(parse_vector(raw))

    vectors: dict[int, list[float]] = {}
    for product_id, group in grouped.items():
        mean = average(group)
        if mean is not None:
            vectors[product_id] = mean
    return vectors


def build_edges(
    conn: psycopg.Connection,
    kind: str,
    *,
    limit: int | None = None,
    top_n: int = TOP_N,
) -> EdgeCounts:
    embedding_kind = EDGE_SOURCE[kind]
    floor = MIN_SCORE[kind]
    counts = EdgeCounts()

    vectors = product_vectors(conn, embedding_kind)
    counts.products_with_vector = len(vectors)
    product_ids = sorted(vectors)[:limit] if limit else sorted(vectors)

    for product_id in product_ids:
        own = vectors[product_id]
        with conn.cursor() as cur:
            cur.execute(
                NEAREST_OFFERS,
                {
                    "embedding_kind": embedding_kind,
                    "product_id": product_id,
                    "vector": to_literal(own),
                    "limit": ANN_FETCH,
                },
            )
            neighbours = cur.fetchall()

        # Ayni urunun birden fazla teklifi donebilir; urun basina en iyi skor.
        best: dict[int, float] = {}
        for other_id, _raw in neighbours:
            other = int(other_id)
            other_vector = vectors.get(other)
            if other_vector is None:
                continue
            # Skor urun vektorleri uzerinden hesaplanir: ANN yalnizca aday
            # uretti, karar urun duzeyinde veriliyor.
            score = cosine(own, other_vector)
            if score > best.get(other, 0.0):
                best[other] = score

        ranked = sorted(best.items(), key=lambda item: -item[1])[:top_n]
        written = 0
        for other_id, score in ranked:
            if score < floor:
                counts.below_floor += 1
                continue
            _write_both_directions(conn, product_id, other_id, kind, score)
            counts.edges_written += 2
            written += 1

        if written < 5:
            counts.thin_products.append(product_id)

    return counts


def _write_both_directions(
    conn: psycopg.Connection, left: int, right: int, kind: str, score: float
) -> None:
    """Kenar cift yonlu yazilir.

    `similarity_lookup_idx (product_a, kind, score DESC)` sorguyu `product_a`
    uzerinden yapiyor; tek yon yazilirsa alternatifler yalnizca bir taraftan
    gorunur.
    """
    with conn.cursor() as cur:
        for a, b in ((left, right), (right, left)):
            cur.execute(
                UPSERT_EDGE,
                {"product_a": a, "product_b": b, "kind": kind, "score": round(score, 4)},
            )
