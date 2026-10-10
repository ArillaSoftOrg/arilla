"""Fiyatsiz referans sayfanin kaynak gorselinin embedding'i (docs/decisions/0035).

Fiyatsiz sayfa kataloga yazilmaz (offer yok); ama gorsel benzerligi icin
vektor gerekir. Veri modeli, kullanici yuklemesinin AYNISIDIR
(`packages/core/src/embedding/embed-uploaded-image.ts`), migration yok:

- `image_upload`: sahibi istegin `user_id`/`session_id`'si, `image_hash` =
  ON ISLENMIS ciktinin sha256'si (TS ile ayni anahtar tanimi), `status =
  'embedded'`. Ham gorsel SAKLANMAZ (`object_key` NULL); bellekte islenir.
  `purge_after` sema varsayilanidir (30 gun).
- `embedding`: `target_type = 'query'`, `target_id = image_upload.id`.
- `link_resolution_request.image_embedding_id` bu embedding'e baglanir (worker.py).

Her istek KENDI `image_upload` + `embedding` satirini alir; onbellekten gelen
vektor bile kopyalanir. Boylece baska bir istegin ya da offer'in omru bu
istegin vektorunu etkilemez (offer silinirse polimorfik tetikleyici onun
embedding'ini siler; FK varken silme engellenirdi).

Onbellek (saglayiciya gitmeden once), model_version ESLESMELI:
1. `image_upload.image_hash` (on islenmis cikti) JOIN `embedding`;
2. `offer.image_hash` (orijinal bayt) JOIN offer embedding'i
   (`enrich.pipeline.VECTOR_BY_IMAGE_HASH`, toplu kosuyla ayni sorgu).

Indirme ve on isleme `enrich.images.fetch` (SSRF korumali istemciyle, img512-v1)
ile yapilir; burada yeni indirme kodu yoktur. Fiyat/stok/offer ASLA yazilmaz.
"""

from __future__ import annotations

import base64
import hashlib
import logging
from dataclasses import dataclass

import httpx
import psycopg

from db.usage import ModelCall, record
from enrich.client import EmbeddingClient, EmbeddingError
from enrich.images import PREPROCESS_VERSION, ImageRejected, fetch
from enrich.pipeline import VECTOR_BY_IMAGE_HASH, _parse_vector, _vector_literal

logger = logging.getLogger(__name__)

#: `embed_offer_image` ile ayni ad: maliyet raporu tek operasyon altinda toplanir.
OPERATION = "image_embedding"

VECTOR_BY_UPLOAD_HASH = """
SELECT e.vector FROM image_upload u
  JOIN embedding e ON e.id = u.embedding_id
 WHERE u.image_hash = %(image_hash)s AND u.status = 'embedded'
   AND e.kind = 'image' AND e.model_version = %(model_version)s
 ORDER BY u.created_at DESC
 LIMIT 1
"""

INSERT_UPLOAD = """
INSERT INTO image_upload (user_id, session_id, image_hash, has_face)
VALUES (%(user_id)s, %(session_id)s, %(image_hash)s, FALSE)
RETURNING id
"""

INSERT_QUERY_EMBEDDING = """
INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
VALUES ('query', %(upload_id)s, 'image', %(model_version)s, %(vector)s)
RETURNING id
"""

MARK_UPLOAD_EMBEDDED = """
UPDATE image_upload SET status = 'embedded', embedding_id = %(embedding_id)s
 WHERE id = %(upload_id)s
"""


@dataclass(frozen=True)
class RequestOwner:
    """Gorselin sahibi: `link_resolution_request`in oturumu/kullanicisi."""

    session_id: str
    user_id: int | None


def _is_download_failure(error: ImageRejected) -> bool:
    """Alinamadi (ag/HTTP) -> 'failed'; icerik reddi (bicim/boyut/bozuk) -> 'rejected'."""
    cause = error.__cause__
    return isinstance(cause, httpx.HTTPError) or str(error).startswith("HTTP ")


def _prepared_hash(data_url: str) -> str:
    """Saglayiciya giden on islenmis baytlarin sha256'si (TS `hashImageBytes` ile ayni tanim)."""
    return hashlib.sha256(base64.b64decode(data_url.split(",", 1)[1])).hexdigest()


def _find_cached_vector(
    conn: psycopg.Connection, model_version: str, prepared_hash: str, original_hash: str
) -> list[float] | None:
    with conn.cursor() as cur:
        cur.execute(
            VECTOR_BY_UPLOAD_HASH,
            {"image_hash": prepared_hash, "model_version": model_version},
        )
        row = cur.fetchone()
        if row is None:
            cur.execute(
                VECTOR_BY_IMAGE_HASH,
                {"model_version": model_version, "image_hash": original_hash, "valid_from": None},
            )
            row = cur.fetchone()
    return _parse_vector(row[0]) if row is not None else None


def _store(
    conn: psycopg.Connection,
    owner: RequestOwner,
    prepared_hash: str,
    model_version: str,
    vector: list[float],
) -> int:
    with conn.cursor() as cur:
        cur.execute(
            INSERT_UPLOAD,
            {
                "user_id": owner.user_id,
                "session_id": owner.session_id,
                "image_hash": prepared_hash,
            },
        )
        upload_id = cur.fetchone()[0]  # type: ignore[index]
        cur.execute(
            INSERT_QUERY_EMBEDDING,
            {
                "upload_id": upload_id,
                "model_version": model_version,
                "vector": _vector_literal(vector),
            },
        )
        embedding_id = cur.fetchone()[0]  # type: ignore[index]
        cur.execute(MARK_UPLOAD_EMBEDDED, {"embedding_id": embedding_id, "upload_id": upload_id})
    return int(embedding_id)


def embed_reference_image(
    conn: psycopg.Connection,
    embedder: EmbeddingClient,
    image_url: str,
    owner: RequestOwner,
    http: httpx.Client,
) -> tuple[int | None, str]:
    """Fiyatsiz kaynak gorselin embedding'i -> (embedding id, `image_status`).

    Durumlar: 'embedded' | 'rejected' (icerik kabul edilmedi) | 'failed'
    (indirilemedi / saglayici hatasi / beklenmeyen hata). Hicbirinde
    istek dusmez; arama metinle surer.
    """
    model_version = embedder.model_version
    try:
        try:
            image = fetch(image_url, http)
        except ImageRejected as error:
            logger.warning("referans gorsel alinamadi: %s", error)
            return None, ("failed" if _is_download_failure(error) else "rejected")

        prepared_hash = _prepared_hash(image.data_url)
        vector = _find_cached_vector(conn, model_version, prepared_hash, image.sha256)
        if vector is not None:
            # Saglayiciya gidilmedi: yine de kayit (cache_hit), TS `visual_search` deseni.
            record(
                conn,
                ModelCall(
                    operation=OPERATION,
                    model_version=model_version,
                    units=0,
                    session_id=owner.session_id,
                    user_id=owner.user_id,
                    cache_hit=True,
                ),
            )
        else:
            try:
                result = embedder.embed_images(
                    [image.data_url], estimated_tokens=image.estimated_tokens
                )
            except EmbeddingError as error:
                conn.rollback()
                logger.warning("referans gorsel embedding'i basarisiz: %s", error)
                return None, "failed"
            vector = result.vectors[0]
            # CLAUDE.md 9. kural: odenmis cagri sonraki bir hatayla geri alinmasin.
            record(
                conn,
                ModelCall(
                    operation=OPERATION,
                    model_version=result.model_version,
                    units=result.total_tokens,
                    session_id=owner.session_id,
                    user_id=owner.user_id,
                ),
            )
            conn.commit()
            model_version = result.model_version

        embedding_id = _store(conn, owner, prepared_hash, model_version, vector)
        conn.commit()
    except Exception:
        conn.rollback()
        logger.exception("referans gorsel embedding'i beklenmeyen hata (%s)", PREPROCESS_VERSION)
        return None, "failed"
    return embedding_id, "embedded"
