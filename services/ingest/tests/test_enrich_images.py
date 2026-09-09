"""Gorsel indirme, hash ve reddetme kurallari. Hicbir test aga cikmaz."""

from __future__ import annotations

import base64
from pathlib import Path

import httpx
import pytest

from enrich.images import MAX_BYTES, FetchedImage, ImageRejected, content_hash, fetch

FIXTURES = Path(__file__).parent / "fixtures" / "images"


def _client(
    payload: bytes = b"", status: int = 200, content_type: str = "image/png"
) -> httpx.Client:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=payload, headers={"content-type": content_type})

    return httpx.Client(transport=httpx.MockTransport(handler))


def _png(name: str = "urun-01-siyah.png") -> bytes:
    return (FIXTURES / name).read_bytes()


def test_hash_is_stable_for_identical_bytes() -> None:
    payload = _png()
    assert content_hash(payload) == content_hash(bytes(payload))


def test_different_images_hash_differently() -> None:
    assert content_hash(_png("urun-01-siyah.png")) != content_hash(_png("urun-02-bej.png"))


def test_fetch_returns_hash_and_data_url() -> None:
    payload = _png()
    result = fetch("https://magaza.example/img/a.png", _client(payload))

    assert isinstance(result, FetchedImage)
    assert result.sha256 == content_hash(payload)
    assert result.data_url.startswith("data:image/png;base64,")
    # data URL gercekten ayni baytlari tasimali.
    encoded = result.data_url.split(",", 1)[1]
    assert base64.b64decode(encoded) == payload


def test_non_image_content_type_is_rejected() -> None:
    with pytest.raises(ImageRejected, match="gorsel degil"):
        fetch("https://magaza.example/x", _client(b"<html>", content_type="text/html"))


def test_oversized_image_is_rejected() -> None:
    with pytest.raises(ImageRejected, match="cok buyuk"):
        fetch("https://magaza.example/x", _client(b"\x00" * (MAX_BYTES + 1)))


def test_empty_body_is_rejected() -> None:
    with pytest.raises(ImageRejected, match="bos govde"):
        fetch("https://magaza.example/x", _client(b""))


def test_http_error_is_rejected_not_raised() -> None:
    with pytest.raises(ImageRejected, match="HTTP 404"):
        fetch("https://magaza.example/x", _client(b"x", status=404))


def test_non_http_scheme_is_rejected() -> None:
    with pytest.raises(ImageRejected, match="desteklenmeyen sema"):
        fetch("file:///etc/passwd", _client(b"x"))


def test_bytes_are_not_persisted_anywhere(tmp_path: Path) -> None:
    """Indirilen gorsel diske yazilmaz; yalnizca hash ve data URL doner.

    Kalici olarak saklanan tek sey `offer.image_hash` ve embedding vektoru.
    """
    before = set(tmp_path.rglob("*"))
    fetch("https://magaza.example/img/a.png", _client(_png()))
    assert set(tmp_path.rglob("*")) == before
