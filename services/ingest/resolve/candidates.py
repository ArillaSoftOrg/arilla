"""Aday uretimi — tum katalogla karsilastirma YOK.

400 urunde kaba kuvvet calisir, 400 binde calismaz. Uc kanal da mevcut
indeksleri kullanir:

* `gtin` / `mpn` → `product_gtin_idx`
* baslik trigram → `product_title_trgm` (GIN, `%` operatoru)
* gorsel → `embedding_ann_idx` (HNSW)

Gorsel kanali **offer↔offer** calisir: B3 yalnizca offer embedding'i uretti,
product duzeyi vektor yok (o B5'in isi). En yakin ZATEN ESLESMIS offer'lar
bulunur ve onlarin urunu aday olarak onerilir.
"""

from __future__ import annotations

from dataclasses import dataclass

import psycopg

#: Her kanaldan en fazla bu kadar aday; skorlama pahali degil ama sinirsiz da degil.
PER_CHANNEL_LIMIT = 10

PRODUCT_COLUMNS = """
    p.id, p.title, b.name AS brand, p.color, p.gtin, p.mpn
"""

BY_EXACT_ID = f"""
SELECT {PRODUCT_COLUMNS}
  FROM product p LEFT JOIN brand b ON b.id = p.brand_id
 WHERE (p.gtin IS NOT NULL AND p.gtin = %(gtin)s)
    OR (p.mpn IS NOT NULL AND p.mpn = %(mpn)s)
 LIMIT %(limit)s
"""

# `%%` psycopg icin kacistir; SQL'e tek `%` gider — pg_trgm benzerlik
# operatoru. GIN indeksini kullanan tek bicim bu.
BY_TRIGRAM = f"""
SELECT {PRODUCT_COLUMNS}
  FROM product p LEFT JOIN brand b ON b.id = p.brand_id
 WHERE p.title %% %(title)s
 ORDER BY similarity(p.title, %(title)s) DESC
 LIMIT %(limit)s
"""

BY_IMAGE = f"""
SELECT DISTINCT ON (p.id) {PRODUCT_COLUMNS}
  FROM embedding e
  JOIN offer o ON o.id = e.target_id
  JOIN product p ON p.id = o.product_id
  LEFT JOIN brand b ON b.id = p.brand_id
 WHERE e.target_type = 'offer' AND e.kind = 'image'
   AND e.model_version = %(model_version)s
   AND o.product_id IS NOT NULL
   AND e.target_id <> %(offer_id)s
 ORDER BY p.id, e.vector <=> %(vector)s
 LIMIT %(limit)s
"""


@dataclass(frozen=True)
class Candidate:
    product_id: int
    title: str
    brand: str | None
    color: str | None
    gtin: str | None
    mpn: str | None
    #: Adayi hangi kanal onerdi — hata ayiklama ve `method` secimi icin.
    channel: str


def _rows_to_candidates(rows: list[tuple], channel: str) -> list[Candidate]:
    return [
        Candidate(
            product_id=int(row[0]),
            title=row[1],
            brand=row[2],
            color=row[3],
            gtin=row[4],
            mpn=row[5],
            channel=channel,
        )
        for row in rows
    ]


def by_exact_identifier(
    conn: psycopg.Connection, gtin: str | None, mpn: str | None
) -> list[Candidate]:
    if not gtin and not mpn:
        return []
    with conn.cursor() as cur:
        cur.execute(BY_EXACT_ID, {"gtin": gtin, "mpn": mpn, "limit": PER_CHANNEL_LIMIT})
        return _rows_to_candidates(cur.fetchall(), "exact")


def by_title(conn: psycopg.Connection, title: str) -> list[Candidate]:
    if not title.strip():
        return []
    with conn.cursor() as cur:
        cur.execute(BY_TRIGRAM, {"title": title, "limit": PER_CHANNEL_LIMIT})
        return _rows_to_candidates(cur.fetchall(), "text")


def by_image(
    conn: psycopg.Connection, offer_id: int, vector: str, model_version: str
) -> list[Candidate]:
    with conn.cursor() as cur:
        cur.execute(
            BY_IMAGE,
            {
                "offer_id": offer_id,
                "vector": vector,
                "model_version": model_version,
                "limit": PER_CHANNEL_LIMIT,
            },
        )
        return _rows_to_candidates(cur.fetchall(), "image")


def deduplicate(groups: list[list[Candidate]]) -> list[Candidate]:
    """Ayni urunu birden fazla kanal onerebilir; ilk oneri korunur."""
    seen: set[int] = set()
    merged: list[Candidate] = []
    for group in groups:
        for candidate in group:
            if candidate.product_id in seen:
                continue
            seen.add(candidate.product_id)
            merged.append(candidate)
    return merged
