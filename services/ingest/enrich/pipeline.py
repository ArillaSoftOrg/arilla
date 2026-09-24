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

Gorsel yolu parti parti ilerler ve HER PARTIDEN SONRA commit eder: odenmis
bir saglayici cagrisinin vektoru ve `api_usage` satiri, sonraki bir partinin
hatasiyla geri alinmaz. Basarisiz parti atlanir; o offer'lar embedding'siz
kalir ve `PENDING_OFFERS` onlari bir sonraki kosuda yeniden secer.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from datetime import datetime

import httpx
import psycopg

from db.usage import ModelCall, record
from enrich import text as text_builder
from enrich.client import EmbeddingClient, EmbeddingError
from enrich.images import (
    IMAGE_VECTORS_VALID_FROM,
    PREPROCESS_VERSION,
    FetchedImage,
    ImageRejected,
    fetch,
)

logger = logging.getLogger(__name__)

#: Embedding'i eksik olan offer'lar. `model_version` parametre cunku model
#: degisince katalog yeniden uretilir ama eski satirlar yerinde kalir.
#: `valid_from` doluysa ondan ESKI satir da eksik sayilir: on isleme anlamli
#: bicimde degistiginde eski vektor sessizce kalmasin (bkz. karar 0028).
PENDING_OFFERS = """
SELECT o.id, o.image_url, o.title_raw, o.brand_raw, o.category_raw
  FROM offer o
 WHERE o.is_active
   AND NOT EXISTS (
        SELECT 1 FROM embedding e
         WHERE e.target_type = 'offer' AND e.target_id = o.id
           AND e.kind = %(kind)s AND e.model_version = %(model_version)s
           AND (%(valid_from)s::timestamptz IS NULL OR e.created_at >= %(valid_from)s)
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
   AND (%(valid_from)s::timestamptz IS NULL OR e.created_at >= %(valid_from)s)
 LIMIT 1
"""

INSERT_EMBEDDING = """
INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
VALUES ('offer', %(target_id)s, %(kind)s, %(model_version)s, %(vector)s)
ON CONFLICT (target_type, target_id, kind, model_version) DO UPDATE
   SET vector = EXCLUDED.vector, created_at = now()
 -- Yalnizca `valid_from`'dan eski (bayat) satir yenilenir; NULL ise hic
 -- guncellenmez, eski DO NOTHING davranisinin aynisi.
 WHERE embedding.created_at < %(valid_from)s::timestamptz
"""

UPDATE_IMAGE_HASH = "UPDATE offer SET image_hash = %(image_hash)s WHERE id = %(offer_id)s"

#: Art arda bu kadar parti basarisiz olursa kosu durur: saglayici ya da ag
#: coktu, devam etmek yalnizca bekleme ve deneme harcar.
MAX_CONSECUTIVE_FAILURES = 3


@dataclass
class EnrichCounts:
    considered: int = 0
    embedded: int = 0
    api_calls: int = 0
    deduped: int = 0
    skipped: int = 0
    tokens: int = 0
    #: Saglayiciya gonderilen (basarili) farkli gorsel sayisi.
    images_sent: int = 0
    #: Saglayici hatasi yuzunden embedding'siz kalan offer — sonraki kosu alir.
    failed: int = 0
    aborted: bool = False
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
    valid_from: datetime | None = None,
) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            PENDING_OFFERS,
            {
                "kind": kind,
                "model_version": model_version,
                "needs_image": kind == "image",
                "merchant_id": merchant_id,
                "valid_from": valid_from,
                "limit": limit,
            },
        )
        return cur.fetchall()


def _write_embedding(
    conn: psycopg.Connection,
    offer_id: int,
    kind: str,
    model_version: str,
    vector: Sequence[float],
    valid_from: datetime | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            INSERT_EMBEDDING,
            {
                "target_id": offer_id,
                "kind": kind,
                "model_version": model_version,
                "vector": _vector_literal(vector),
                "valid_from": valid_from,
            },
        )


def _note(counts: EnrichCounts, message: str) -> None:
    if len(counts.errors) < 5:
        counts.errors.append(message)


def embed_images(
    conn: psycopg.Connection,
    client: EmbeddingClient,
    *,
    limit: int = 1000,
    merchant_id: int | None = None,
    http: httpx.Client | None = None,
    valid_from: datetime | None = IMAGE_VECTORS_VALID_FROM,
) -> EnrichCounts:
    counts = EnrichCounts()
    model_version = client.model_version
    rows = _pending(conn, "image", model_version, limit, merchant_id, valid_from)
    counts.considered = len(rows)
    if not rows:
        return counts

    logger.info(
        "gorsel embedding: %s aday, model %s, on isleme %s",
        len(rows),
        model_version,
        PREPROCESS_VERSION,
    )
    downloader = http or httpx.Client(timeout=30.0, follow_redirects=True)

    #: Bu kosuda elde edilen vektorler (API ya da veritabani) — hash'e gore.
    known: dict[str, list[float]] = {}
    #: API'ye gidecek partideki farkli gorseller ve onlari bekleyen offer'lar.
    batch: dict[str, FetchedImage] = {}
    waiting: dict[str, list[int]] = {}
    consecutive_failures = 0

    def write(image_hash: str, offer_ids: list[int]) -> None:
        vector = known[image_hash]
        for offer_id in offer_ids:
            _write_embedding(conn, offer_id, "image", model_version, vector, valid_from)
            counts.embedded += 1

    def flush() -> None:
        nonlocal consecutive_failures
        if not batch:
            return
        hashes = list(batch)
        estimate = sum(batch[image_hash].estimated_tokens for image_hash in hashes)
        try:
            result = client.embed_images(
                [batch[image_hash].data_url for image_hash in hashes],
                estimated_tokens=estimate,
            )
        except EmbeddingError as error:
            consecutive_failures += 1
            lost = sum(len(waiting[image_hash]) for image_hash in hashes)
            counts.failed += lost
            _note(counts, f"parti ({len(hashes)} gorsel, {lost} offer): {error}")
            logger.warning("parti atlandi, %s offer sonraki kosuya kaldi: %s", lost, error)
        else:
            consecutive_failures = 0
            counts.api_calls += 1
            counts.images_sent += len(hashes)
            counts.tokens += result.total_tokens
            # CLAUDE.md 9. kural: basarili her cagri api_usage'a.
            record(
                conn,
                ModelCall(
                    operation="image_embedding",
                    model_version=model_version,
                    units=result.total_tokens,
                ),
            )
            for image_hash, vector in zip(hashes, result.vectors, strict=True):
                known[image_hash] = vector
                write(image_hash, waiting[image_hash])
            logger.info(
                "parti: %s gorsel, %s token (tahmin %s)",
                len(hashes),
                result.total_tokens,
                estimate,
            )
        batch.clear()
        for image_hash in hashes:
            waiting.pop(image_hash, None)
        # Odenmis cagri ve hash guncellemeleri sonraki bir hatayla geri alinmasin.
        conn.commit()

    for offer_id, image_url, *_ in rows:
        if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
            counts.aborted = True
            _note(counts, f"art arda {consecutive_failures} parti basarisiz, kosu durdu")
            break

        try:
            image = fetch(image_url, downloader)
        except ImageRejected as error:
            counts.skipped += 1
            _note(counts, f"offer {offer_id}: {error}")
            logger.warning("gorsel atlandi %s: %s", offer_id, error)
            continue

        with conn.cursor() as cur:
            cur.execute(UPDATE_IMAGE_HASH, {"image_hash": image.sha256, "offer_id": offer_id})

        if image.sha256 in known:
            write(image.sha256, [offer_id])
            continue
        if image.sha256 in batch:
            waiting[image.sha256].append(offer_id)
            continue

        # Veritabaninda bu hash icin vektor var mi? Varsa API'ye hic gitme.
        with conn.cursor() as cur:
            cur.execute(
                VECTOR_BY_IMAGE_HASH,
                {
                    "model_version": model_version,
                    "image_hash": image.sha256,
                    "valid_from": valid_from,
                },
            )
            found = cur.fetchone()
        if found is not None:
            known[image.sha256] = _parse_vector(found[0])
            write(image.sha256, [offer_id])
            continue

        batch[image.sha256] = image
        waiting[image.sha256] = [offer_id]
        if len(batch) >= client.image_batch_size:
            flush()

    if not counts.aborted:
        flush()
    else:
        counts.failed += sum(len(offer_ids) for offer_ids in waiting.values())
        batch.clear()
        waiting.clear()
    conn.commit()

    # Saglayiciya yalnizca `images_sent` gorsel gitti; geri kalan her satir bir
    # yineleme isabetidir (ya bu kosudaki ayni gorsel, ya veritabanindaki
    # onceki bir kosunun vektoru).
    counts.deduped = counts.embedded - counts.images_sent
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
