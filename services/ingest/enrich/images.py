"""Gorsel indirme, hash'leme ve base64'e cevirme.

**Indirilen bayt hicbir yere yazilmaz.** Kalici olarak yalnizca SHA-256
hash'i (`offer.image_hash`) ve embedding vektoru saklanir. Bu, katalog
gorselleri icin gereksiz depolama olmadigi gibi, `docs/kvkk.md`'nin yuklenen
gorseller icin koydugu "ham dosya saklanmaz" cizgisiyle de ayni yonde.
"""

from __future__ import annotations

import base64
import hashlib
import logging
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

#: Urun fotografi bundan buyukse bir seyler yanlis; indirmeyi kesiyoruz.
MAX_BYTES = 8 * 1024 * 1024
TIMEOUT = 30.0

ALLOWED_TYPES = ("image/jpeg", "image/jpg", "image/png", "image/webp", "image/avif")


class ImageRejected(Exception):
    """Tek bir gorsel alinamadi. Kosuyu durdurmaz, sayilir."""


@dataclass(frozen=True)
class FetchedImage:
    #: Icerigin SHA-256'si — `offer.image_hash` bu.
    sha256: str
    #: Saglayiciya gonderilecek `data:` URL'i.
    data_url: str


def content_hash(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def to_data_url(payload: bytes, media_type: str) -> str:
    encoded = base64.b64encode(payload).decode("ascii")
    return f"data:{media_type};base64,{encoded}"


def fetch(url: str, client: httpx.Client) -> FetchedImage:
    if not url.startswith(("http://", "https://")):
        raise ImageRejected(f"desteklenmeyen sema: {url[:40]!r}")

    try:
        response = client.get(url, follow_redirects=True, timeout=TIMEOUT)
    except httpx.HTTPError as error:
        raise ImageRejected(f"indirilemedi: {error}") from error

    if response.status_code != 200:
        raise ImageRejected(f"HTTP {response.status_code}")

    media_type = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
    if media_type and media_type not in ALLOWED_TYPES:
        raise ImageRejected(f"gorsel degil: {media_type}")

    payload = response.content
    if not payload:
        raise ImageRejected("bos govde")
    if len(payload) > MAX_BYTES:
        raise ImageRejected(f"cok buyuk: {len(payload)} bayt")

    return FetchedImage(
        sha256=content_hash(payload),
        data_url=to_data_url(payload, media_type or "image/jpeg"),
    )
