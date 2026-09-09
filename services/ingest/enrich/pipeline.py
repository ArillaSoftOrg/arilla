"""Embedding uretim boru hatti.

Tek kural bu dosyanin varlik sebebi:

    Her offer icin bir `embedding` satiri;
    her FARKLI icerik icin bir API cagrisi.

Sema `embedding_uniq (target_type, target_id, kind, model_version)` diyor ve
`embedding_ann_idx` HNSW indeksi `WHERE target_type = 'offer'` — yani arama
offer embedding'leri uzerinden gidiyor, her offer'in kendi satiri olmali.
Ama pahali olan satir degil, model cagrisi: ayni gorsel yuz offer'da
gecse bile saglayiciya BIR kez gider.

Ikinci kosu, embedding satiri zaten olan offer'lari hic secmez → sifir cagri.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field

import httpx
import psycopg

from db.usage import ModelCall, record
from enrich import text as text_builder
from enrich.client import EmbeddingClient
from enrich.images import ImageRejected, fetch

logger = logging.getLogger(__name__)

#: Embedding'i eksik olan offer'lar. `model_version` parametre cunku model
#: degisince katalog yeniden uretilir ama eski satirlar yerinde kalir.
PENDING_OFFERS = """
SELECT o.id, o.image_url, o.title_raw, o.brand_raw, o.category_raw
  FROM offer o
 WHERE o.is_active
   AND NOT EXISTS (
        SELECT 1 FROM embedding e
         WHERE e.target_type = 'offer' AND e.target_id = o.id
           AND e.kind = %(kind)s AND e.model_version = %(model_version)s
   )
   AND (%(needs_image)s = FALSE OR o.image_url IS NOT NULL)
   -- Istege bagli daraltma: "su merchant'i yeniden embedding'le" isletimde
   -- gereken bir islem (model degisimi, bozuk gorseller, tek magazayi
   -- yeniden isleme). NULL verilirse tum katalog taranir.
   AND (%(merchant_id)s::bigint IS NULL OR o.merchant_id = %(merchant_id)s)
 ORDER BY o.id
 LIMIT %(limit)s
"""

#: Bu hash icin daha once uretilmis bir vektor var mi? Varsa API'ye gitme.
VECTOR_BY_IMAGE_HASH = """
SELECT e.vector FROM embedding e
  JOIN offer o ON o.id = e.target_id
 WHERE e.target_type = 'offer' AND e.kind = 'image'
   AND e.model_version = %(model_version)s AND o.image_hash = %(image_hash)s
 LIMIT 1
"""

INSERT_EMBEDDING = """
INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
VALUES ('offer', %(target_id)s, %(kind)s, %(model_version)s, %(vector)s)
ON CONFLICT (target_type, target_id, kind, model_version) DO NOTHING
"""

UPDATE_IMAGE_HASH = "UPDATE offer SET image_hash = %(image_hash)s WHERE id = %(offer_id)s"


@dataclass
class EnrichCounts:
    considered: int = 0
    embedded: int = 0
    api_calls: int = 0
    deduped: int = 0
    skipped: int = 0
    tokens: int = 0
    errors: list[str] = field(default_factory=list)


def _vector_literal(vector: Sequence[float]) -> str:
    """pgvector metin bicimi: '[0.1,0.2,...]'."""
    return "[" + ",".join(f"{value:.6f}" for value in vector) + "]"


def _chunks(items: list, size: int) -> Iterator[list]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _pending(
    conn: psycopg.Connection,
    kind: str,
    model_version: str,
    limit: int,
    merchant_id: int | None,
) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            PENDING_OFFERS,
            {
                "kind": kind,
                "model_version": model_version,
                "needs_image": kind == "image",
                "merchant_id": merchant_id,
                "limit": limit,
            },
        )
        return cur.fetchall()


def _write_embedding(
    conn: psycopg.Connection, offer_id: int, kind: str, model_version: str, vector: Sequence[float]
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            INSERT_EMBEDDING,
            {
                "target_id": offer_id,
                "kind": kind,
                "model_version": model_version,
                "vector": _vector_literal(vector),
            },
        )


def embed_images(
    conn: psycopg.Connection,
    client: EmbeddingClient,
    *,
    limit: int = 1000,
    merchant_id: int | None = None,
    http: httpx.Client | None = None,
) -> EnrichCounts:
    counts = EnrichCounts()
    model_version = client.model_version
    rows = _pending(conn, "image", model_version, limit, merchant_id)
    counts.considered = len(rows)
    if not rows:
        return counts

    downloader = http or httpx.Client(timeout=30.0, follow_redirects=True)

    # 1. Indir, hash'le, offer.image_hash yaz. Hash'e gore grupla.
    by_hash: dict[str, list[int]] = {}
    data_url_by_hash: dict[str, str] = {}

    for offer_id, image_url, *_ in rows:
        try:
            image = fetch(image_url, downloader)
        except ImageRejected as error:
            counts.skipped += 1
            if len(counts.errors) < 5:
                counts.errors.append(f"offer {offer_id}: {error}")
            logger.warning("gorsel atlandi %s: %s", offer_id, error)
            continue

        with conn.cursor() as cur:
            cur.execute(UPDATE_IMAGE_HASH, {"image_hash": image.sha256, "offer_id": offer_id})
        by_hash.setdefault(image.sha256, []).append(offer_id)
        data_url_by_hash.setdefault(image.sha256, image.data_url)

    # 2. Veritabaninda bu hash icin vektor var mi? Varsa API'ye hic gitme.
    vectors: dict[str, list[float]] = {}
    for image_hash in list(by_hash):
        with conn.cursor() as cur:
            cur.execute(
                VECTOR_BY_IMAGE_HASH,
                {"model_version": model_version, "image_hash": image_hash},
            )
            found = cur.fetchone()
        if found is not None:
            vectors[image_hash] = _parse_vector(found[0])

    # 3. Kalan FARKLI gorseller icin API cagrisi.
    missing = [image_hash for image_hash in by_hash if image_hash not in vectors]
    for batch in _chunks(missing, client.image_batch_size):
        result = client.embed_images([data_url_by_hash[image_hash] for image_hash in batch])
        counts.api_calls += 1
        counts.tokens += result.total_tokens
        for image_hash, vector in zip(batch, result.vectors, strict=True):
            vectors[image_hash] = vector
        record(
            conn,
            ModelCall(
                operation="image_embedding",
                model_version=model_version,
                units=result.total_tokens,
            ),
        )

    # 4. Her offer'a kendi satirini yaz — vektor paylasilsa da satir paylasilmaz.
    for image_hash, offer_ids in by_hash.items():
        vector = vectors.get(image_hash)
        if vector is None:
            continue
        for offer_id in offer_ids:
            _write_embedding(conn, offer_id, "image", model_version, vector)
            counts.embedded += 1

    # Saglayiciya yalnizca `missing` gonderildi; geri kalan her satir bir
    # yineleme isabetidir (ya bu kosudaki ayni gorsel, ya veritabanindaki
    # onceki bir kosunun vektoru).
    counts.deduped = counts.embedded - len(missing)
    return counts


def embed_texts(
    conn: psycopg.Connection,
    client: EmbeddingClient,
    *,
    limit: int = 1000,
    merchant_id: int | None = None,
) -> EnrichCounts:
    counts = EnrichCounts()
    model_version = client.model_version
    rows = _pending(conn, "text", model_version, limit, merchant_id)
    counts.considered = len(rows)
    if not rows:
        return counts

    # Ayni kanonik metin iki merchant'ta gecebilir: bir kez cagir.
    by_text: dict[str, list[int]] = {}
    for offer_id, _image_url, title, brand, category in rows:
        canonical = text_builder.build(title, brand, category)
        if not canonical:
            counts.skipped += 1
            continue
        by_text.setdefault(canonical, []).append(offer_id)

    vectors: dict[str, list[float]] = {}
    for batch in _chunks(list(by_text), client.text_batch_size):
        result = client.embed_texts(batch)
        counts.api_calls += 1
        counts.tokens += result.total_tokens
        for canonical, vector in zip(batch, result.vectors, strict=True):
            vectors[canonical] = vector
        record(
            conn,
            ModelCall(
                operation="text_embedding",
                model_version=model_version,
                units=result.total_tokens,
            ),
        )

    for canonical, offer_ids in by_text.items():
        vector = vectors[canonical]
        for offer_id in offer_ids:
            _write_embedding(conn, offer_id, "text", model_version, vector)
            counts.embedded += 1

    # Ayni kanonik metni paylasan her ek offer bir yineleme isabeti.
    counts.deduped = counts.embedded - len(by_text)
    return counts


def _parse_vector(raw: object) -> list[float]:
    """pgvector'un dondugu degeri listeye cevirir."""
    if isinstance(raw, list):
        return [float(value) for value in raw]
    text = str(raw).strip().lstrip("[").rstrip("]")
    return [float(part) for part in text.split(",") if part]
