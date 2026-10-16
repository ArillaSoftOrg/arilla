"""`similarity_edge` uretimi.

`docs/search.md`: `similar_cheaper` niyeti `visual` ve `semantic` kenarlarini
kullaniyor. B3'un urettigi iki embedding turu bunlara birebir esleniyor:

    embedding.kind = 'image'  ->  similarity_edge.kind = 'visual'
    embedding.kind = 'text'   ->  similarity_edge.kind = 'semantic'

`same` ve `substitute` bu isin disinda: `same` B4 sonrasi anlamini degistirdi
(ayni urun artik ayni `product_id`), `substitute` ise tiklama ve donusum
verisinden ogrenilir ve ilk aylarda bos kalir.

Set tabanli (karar 0125 izi, Faz 3): urun vektoru (tekliflerin normalize
ortalamasi, `vectors.py` ile ayni tanim) VERITABANINDA, gecici tabloda
hesaplanir; Python hicbir vektoru bellege almaz. Komsular partiler halinde
tek `LATERAL` sorguyla offer duzeyindeki HNSW indeksinden uretilir, skor urun
vektorleri arasinda hesaplanir, kenarlar parti basina tek `unnest` ile yazilir.
Bellek urun sayisindan bagimsizdir; `commit=True` her partiyi ayri isleme
koyar (uzun islem, xmin tutma ve satir kilidi yok).

Model surumleri KARISTIRILMAZ: her `model_version` kendi icinde ortalanir ve
yalnizca kendi vektorleriyle karsilastirilir. Birden fazla surum varsa kucuk
grup once, baskin grup en son islenir (ayni kenarda baskin modelin skoru kalir).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import psycopg

from db.vector import tune_ann_search

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

#: Parti basina urun. Her parti tek kNN sorgusu + tek yazim; bellek partiyle sinirli.
BATCH_SIZE = 500

#: Ayni anda tek kenar uretimi (iki kosu ters sirada yazip kilitlenmesin).
EDGE_LOCK_KEY = 0x53494D45  # "SIME"

MODEL_GROUPS = """
SELECT e.model_version, count(*) AS n
  FROM embedding e
  JOIN offer o ON o.id = e.target_id
 WHERE e.target_type = 'offer' AND e.kind = %(embedding_kind)s
   AND o.product_id IS NOT NULL AND o.is_active
 GROUP BY e.model_version
 ORDER BY n, e.model_version
"""

CREATE_CENTROIDS = """
CREATE TEMP TABLE IF NOT EXISTS similarity_centroid (
    product_id BIGINT PRIMARY KEY,
    vector     vector NOT NULL
) ON COMMIT PRESERVE ROWS
"""

# Urun vektoru = tekliflerin ortalamasi, yeniden normalize (vectors.average).
# Sifir normlu ortalama kosinusu tanimsiz kilardi; Python'da da 0 skor verip elenirdi.
FILL_CENTROIDS = """
INSERT INTO similarity_centroid (product_id, vector)
SELECT product_id, l2_normalize(mean)
  FROM (SELECT o.product_id, avg(e.vector) AS mean
          FROM embedding e
          JOIN offer o ON o.id = e.target_id
         WHERE e.target_type = 'offer' AND e.kind = %(embedding_kind)s
           AND e.model_version = %(model_version)s
           AND o.product_id IS NOT NULL AND o.is_active
         GROUP BY o.product_id) grouped
 WHERE vector_norm(mean) > 0
"""

NEXT_BATCH = """
SELECT product_id FROM similarity_centroid
 WHERE product_id > %(after)s ORDER BY product_id LIMIT %(limit)s
"""

# Aday uretimi offer duzeyindeki HNSW indeksi uzerinden (`embedding_ann_idx`,
# `WHERE target_type = 'offer'`); urun vektoru indekslenmez. Skor urun vektorleri
# arasinda: ANN yalnizca aday uretir, karar urun duzeyindedir. Komsunun urun
# vektoru yoksa (ayni modelde aktif teklifi yok) aday elenir.
NEIGHBOURS = """
WITH batch AS (
    SELECT product_id, vector FROM similarity_centroid WHERE product_id = ANY(%(ids)s)
),
candidate AS (
    SELECT DISTINCT b.product_id, n.product_id AS other_id
      FROM batch b
     CROSS JOIN LATERAL (
           SELECT o.product_id
             FROM embedding e
             JOIN offer o ON o.id = e.target_id
            WHERE e.target_type = 'offer' AND e.kind = %(embedding_kind)s
              AND e.model_version = %(model_version)s
              AND o.product_id IS NOT NULL AND o.product_id <> b.product_id
              AND o.is_active
            ORDER BY e.vector <=> b.vector
            LIMIT %(fetch)s) n
),
scored AS (
    SELECT c.product_id, c.other_id,
           greatest(0.0, least(1.0, 1 - (b.vector <=> other.vector)))::float8 AS score
      FROM candidate c
      JOIN batch b ON b.product_id = c.product_id
      JOIN similarity_centroid other ON other.product_id = c.other_id
),
ranked AS (
    SELECT product_id, other_id, score,
           row_number() OVER (PARTITION BY product_id ORDER BY score DESC, other_id) AS rank
      FROM scored
     WHERE score > 0
)
SELECT product_id, other_id, score FROM ranked WHERE rank <= %(top_n)s
 ORDER BY product_id, rank
"""

# Tek ifade, sirali anahtarlar: es zamanli yazicilarla kilit sirasi tutarli.
UPSERT_EDGES = """
INSERT INTO similarity_edge (product_a, product_b, kind, score, computed_at)
SELECT a, b, %(kind)s, s, now()
  FROM unnest(%(a)s::bigint[], %(b)s::bigint[], %(s)s::real[]) AS t(a, b, s)
 ORDER BY a, b
ON CONFLICT (product_a, product_b, kind)
DO UPDATE SET score = EXCLUDED.score, computed_at = EXCLUDED.computed_at
"""

CREATE_SEEN = """
CREATE TEMP TABLE IF NOT EXISTS similarity_seen (
    product_a BIGINT NOT NULL,
    product_b BIGINT NOT NULL,
    PRIMARY KEY (product_a, product_b)
) ON COMMIT PRESERVE ROWS
"""

MARK_SEEN = """
INSERT INTO similarity_seen (product_a, product_b)
SELECT a, b FROM unnest(%(a)s::bigint[], %(b)s::bigint[]) AS t(a, b)
ON CONFLICT DO NOTHING
"""

# Yalnizca acikca istenirse (`prune=True`) ve tam kosuda: bu kosuda hicbir
# urunun ilk TOP_N'ine girmeyen eski kenarlar. Turetilmis veridir.
PRUNE_UNSEEN = """
DELETE FROM similarity_edge s
 WHERE s.kind = %(kind)s
   AND NOT EXISTS (SELECT 1 FROM similarity_seen n
                    WHERE n.product_a = s.product_a AND n.product_b = s.product_b)
"""


@dataclass
class EdgeCounts:
    products_with_vector: int = 0
    edges_written: int = 0
    below_floor: int = 0
    #: 5'ten az kenari olan urunler — kabul kriteri bunu izliyor.
    thin_products: list[int] = field(default_factory=list)
    #: `prune=True` ile silinen bayat kenarlar.
    edges_pruned: int = 0


def _acquire_lock(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s)", (EDGE_LOCK_KEY,))
        row = cur.fetchone()
    if not (row and row[0]):
        raise RuntimeError("baska bir similarity kenar kosusu aktif; ayni anda tek kosu")


def _release_lock(conn: psycopg.Connection) -> None:
    # Hata sonrasi islem iptal durumundaysa kilit sorgusu da duserdi ve asil hatayi
    # gizlerdi; iptal edilmis islem zaten geri alinacak.
    if conn.info.transaction_status == psycopg.pq.TransactionStatus.INERROR:
        conn.rollback()
    with conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_unlock(%s)", (EDGE_LOCK_KEY,))


def _write_edges(conn: psycopg.Connection, kind: str, edges: dict[tuple[int, int], float]) -> None:
    """Kenarlar cift yonlu yazilir.

    `similarity_lookup_idx (product_a, kind, score DESC)` sorguyu `product_a`
    uzerinden yapiyor; tek yon yazilirsa alternatifler yalnizca bir taraftan
    gorunur. Ayni partide iki uc birbirini secmisse skor simetriktir; anahtar
    tekillestirilir (tek INSERT ayni satira iki kez dokunamaz).
    """
    if not edges:
        return
    keys = sorted(edges)
    params = {
        "kind": kind,
        "a": [a for a, _ in keys],
        "b": [b for _, b in keys],
        "s": [edges[key] for key in keys],
    }
    with conn.cursor() as cur:
        cur.execute(UPSERT_EDGES, params)


def _build_group(
    conn: psycopg.Connection,
    kind: str,
    model_version: str,
    counts: EdgeCounts,
    *,
    remaining: int | None,
    top_n: int,
    batch_size: int,
    commit: bool,
    track_seen: bool,
) -> int:
    """Tek model surumu; islenen urun sayisini dondurur."""
    embedding_kind = EDGE_SOURCE[kind]
    floor = MIN_SCORE[kind]
    with conn.cursor() as cur:
        cur.execute("TRUNCATE similarity_centroid")
        cur.execute(
            FILL_CENTROIDS, {"embedding_kind": embedding_kind, "model_version": model_version}
        )
        counts.products_with_vector += cur.rowcount
        cur.execute("ANALYZE similarity_centroid")

    processed = 0
    after = 0
    while remaining is None or processed < remaining:
        size = batch_size if remaining is None else min(batch_size, remaining - processed)
        with conn.cursor() as cur:
            cur.execute(NEXT_BATCH, {"after": after, "limit": size})
            ids = [int(row[0]) for row in cur.fetchall()]
        if not ids:
            break
        after = ids[-1]

        # Suzgec (kind, model) HNSW taramasindan sonra uygulanir; yeterli komsu donsun.
        # Islem-yerel ayardir: her commit'ten sonra yeniden kurulur.
        tune_ann_search(conn)
        with conn.cursor() as cur:
            cur.execute(
                NEIGHBOURS,
                {
                    "ids": ids,
                    "embedding_kind": embedding_kind,
                    "model_version": model_version,
                    "fetch": ANN_FETCH,
                    "top_n": top_n,
                },
            )
            rows = cur.fetchall()

        written_per_product = dict.fromkeys(ids, 0)
        edges: dict[tuple[int, int], float] = {}
        for product_id, other_id, score in rows:
            product, other = int(product_id), int(other_id)
            if score < floor:
                counts.below_floor += 1
                continue
            rounded = round(float(score), 4)
            edges[(product, other)] = rounded
            edges[(other, product)] = rounded
            counts.edges_written += 2
            written_per_product[product] += 1

        _write_edges(conn, kind, edges)
        if track_seen and edges:
            keys = list(edges)
            with conn.cursor() as cur:
                cur.execute(MARK_SEEN, {"a": [a for a, _ in keys], "b": [b for _, b in keys]})
        counts.thin_products.extend(
            product for product, written in written_per_product.items() if written < 5
        )
        processed += len(ids)
        if commit:
            conn.commit()
    return processed


def build_edges(
    conn: psycopg.Connection,
    kind: str,
    *,
    limit: int | None = None,
    top_n: int = TOP_N,
    batch_size: int = BATCH_SIZE,
    commit: bool = False,
    prune: bool = False,
) -> EdgeCounts:
    """Bir kenar turunu uretir.

    `commit=False` (varsayilan): hepsi cagiranin isleminde; cagiran commit/rollback
    eder (testler, `--dry-run`). `commit=True`: her parti ayri islemde (gece kosusu).
    `prune=True`: tam kosu sonunda bu kosuda uretilmeyen eski kenarlar silinir;
    `limit` verilmisse YOK SAYILIR (kismi kosu tum katalogu bilmez).
    """
    counts = EdgeCounts()
    embedding_kind = EDGE_SOURCE[kind]
    track_seen = prune and limit is None

    _acquire_lock(conn)
    try:
        with conn.cursor() as cur:
            cur.execute(CREATE_CENTROIDS)
            if track_seen:
                cur.execute(CREATE_SEEN)
                cur.execute("TRUNCATE similarity_seen")
            cur.execute(MODEL_GROUPS, {"embedding_kind": embedding_kind})
            groups = [str(row[0]) for row in cur.fetchall()]
        if len(groups) > 1:
            logger.warning(
                "%s: %d model surumu var (%s); her biri ayri islenir, baskin olan son",
                kind,
                len(groups),
                ", ".join(groups),
            )

        processed = 0
        for model_version in groups:
            remaining = None if limit is None else limit - processed
            if remaining is not None and remaining <= 0:
                break
            processed += _build_group(
                conn,
                kind,
                model_version,
                counts,
                remaining=remaining,
                top_n=top_n,
                batch_size=batch_size,
                commit=commit,
                track_seen=track_seen,
            )

        if track_seen:
            with conn.cursor() as cur:
                cur.execute(PRUNE_UNSEEN, {"kind": kind})
                counts.edges_pruned = cur.rowcount
            if commit:
                conn.commit()
    finally:
        _release_lock(conn)
    return counts
