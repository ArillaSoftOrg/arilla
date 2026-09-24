"""Gorsel on isleme: kucultme, EXIF, bicim sozlesmesi, bellek korumalari.

Tum gorseller bellekte uretilir; hicbir test aga cikmaz.
"""

from __future__ import annotations

import base64
import io

import httpx
import pytest
from PIL import Image

from enrich import images
from enrich.images import (
    MAX_BYTES,
    TARGET_LONG_EDGE,
    ImageRejected,
    content_hash,
    estimate_tokens,
    fetch,
    preprocess,
    target_size,
)


def _encode(image: Image.Image, fmt: str, **options) -> bytes:
    out = io.BytesIO()
    image.save(out, format=fmt, **options)
    return out.getvalue()


def _decode(data_url: str) -> Image.Image:
    header, encoded = data_url.split(",", 1)
    assert header.endswith(";base64")
    return Image.open(io.BytesIO(base64.b64decode(encoded)))


def _client(payload: bytes, content_type: str = "image/jpeg") -> httpx.Client:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=payload, headers={"content-type": content_type})

    return httpx.Client(transport=httpx.MockTransport(handler))


# --- boyut kurali -------------------------------------------------------------


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ((2000, 1000), (512, 256)),
        ((1000, 2000), (256, 512)),
        ((2048, 2048), (512, 512)),
        ((512, 300), (512, 300)),
        ((300, 200), (300, 200)),  # buyutme yok
        ((5000, 3), (512, 1)),  # kenar sifira inmez
    ],
)
def test_target_size_keeps_aspect_and_never_upscales(source, expected) -> None:
    assert target_size(*source) == expected


def test_large_jpeg_is_downscaled_to_long_edge() -> None:
    payload = _encode(Image.new("RGB", (3000, 2000), (200, 30, 30)), "JPEG", quality=85)
    prepared = preprocess(payload)
    assert (prepared.width, prepared.height) == (512, 341)
    assert (prepared.source_width, prepared.source_height) == (3000, 2000)
    out = _decode(prepared.data_url)
    assert out.format == "JPEG"
    assert out.size == (512, 341)
    assert prepared.data_url.startswith("data:image/jpeg;base64,")


def test_small_image_is_not_upscaled() -> None:
    payload = _encode(Image.new("RGB", (120, 80), "white"), "PNG")
    prepared = preprocess(payload)
    assert (prepared.width, prepared.height) == (120, 80)


def test_exif_orientation_is_applied() -> None:
    """Orientation=6 (90 derece): 400x200 kaydedilmis gorsel 200x400 gorunur."""
    source = Image.new("RGB", (400, 200), "blue")
    exif = Image.Exif()
    exif[0x0112] = 6
    payload = _encode(source, "JPEG", exif=exif.tobytes())

    prepared = preprocess(payload)
    assert (prepared.width, prepared.height) == (200, 400)


def test_exif_orientation_then_downscale() -> None:
    source = Image.new("RGB", (2000, 1000), "blue")
    exif = Image.Exif()
    exif[0x0112] = 8
    payload = _encode(source, "JPEG", exif=exif.tobytes())

    prepared = preprocess(payload)
    assert (prepared.width, prepared.height) == (256, 512)


# --- bicim ve seffaflik -----------------------------------------------------


def test_real_transparency_is_kept_as_png() -> None:
    source = Image.new("RGBA", (600, 600), (255, 0, 0, 0))
    source.putpixel((10, 10), (255, 0, 0, 255))
    prepared = preprocess(_encode(source, "PNG"))
    assert prepared.data_url.startswith("data:image/png;base64,")
    out = _decode(prepared.data_url)
    assert out.mode == "RGBA"
    assert out.size == (512, 512)


def test_opaque_alpha_channel_becomes_jpeg() -> None:
    source = Image.new("RGBA", (100, 100), (10, 20, 30, 255))
    prepared = preprocess(_encode(source, "PNG"))
    assert prepared.data_url.startswith("data:image/jpeg;base64,")


def test_webp_is_accepted() -> None:
    payload = _encode(Image.new("RGB", (800, 400), "green"), "WEBP")
    prepared = preprocess(payload)
    assert (prepared.width, prepared.height) == (512, 256)


def test_cmyk_jpeg_is_converted() -> None:
    payload = _encode(Image.new("CMYK", (100, 100), (0, 50, 50, 0)), "JPEG")
    out = _decode(preprocess(payload).data_url)
    assert out.mode == "RGB"


def test_unsupported_format_is_rejected_even_with_image_header() -> None:
    """Sozlesme: yalnizca JPEG/PNG/WebP/AVIF. GIF basligi yalan soylese de reddedilir."""
    payload = _encode(Image.new("RGB", (20, 20), "red"), "GIF")
    with pytest.raises(ImageRejected, match="cozulemedi"):
        fetch("https://magaza.example/a.png", _client(payload, "image/png"))


def test_bytes_that_are_not_an_image_are_rejected() -> None:
    with pytest.raises(ImageRejected, match="cozulemedi"):
        fetch("https://magaza.example/a.jpg", _client(b"<html>not an image</html>"))


def test_truncated_image_is_rejected() -> None:
    payload = _encode(Image.new("RGB", (400, 400), "red"), "PNG")
    with pytest.raises(ImageRejected):
        preprocess(payload[: len(payload) // 2])


def test_generic_binary_content_type_is_accepted_when_it_decodes() -> None:
    payload = _encode(Image.new("RGB", (50, 50), "red"), "JPEG")
    result = fetch("https://magaza.example/a", _client(payload, "application/octet-stream"))
    assert result.sha256 == content_hash(payload)


# --- bellek korumalari -------------------------------------------------------


def test_pixel_bomb_is_rejected_before_decoding(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(images, "MAX_SOURCE_PIXELS", 100)
    payload = _encode(Image.new("RGB", (20, 20), "red"), "PNG")
    with pytest.raises(ImageRejected, match="cok fazla piksel"):
        preprocess(payload)


def test_stream_without_content_length_is_cut_at_max_bytes() -> None:
    """Content-Length yoksa bile govde MAX_BYTES'i asinca okuma kesilir."""
    read = {"chunks": 0}

    def body():
        chunk = b"\x00" * (1024 * 1024)
        for _ in range(64):
            read["chunks"] += 1
            yield chunk

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body(), headers={"content-type": "image/jpeg"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(ImageRejected, match="cok buyuk"):
        fetch("https://magaza.example/a.jpg", client)
    assert read["chunks"] <= MAX_BYTES // (1024 * 1024) + 2


def test_declared_content_length_over_limit_is_rejected() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"x",
            headers={"content-type": "image/jpeg", "content-length": str(MAX_BYTES + 1)},
        )

    with pytest.raises(ImageRejected, match="cok buyuk"):
        fetch("https://magaza.example/a.jpg", httpx.Client(transport=httpx.MockTransport(handler)))


# --- kimlik ve tahmin -------------------------------------------------------


def test_hash_is_of_original_bytes_not_preprocessed_output() -> None:
    payload = _encode(Image.new("RGB", (1500, 1500), "red"), "JPEG")
    result = fetch("https://magaza.example/a.jpg", _client(payload))
    assert result.sha256 == content_hash(payload)
    assert (result.width, result.height) == (TARGET_LONG_EDGE, TARGET_LONG_EDGE)


def test_token_estimate_is_one_tile_after_preprocessing() -> None:
    assert estimate_tokens(512, 512) == 4000
    assert estimate_tokens(512, 341) == 4000
    # Tam boy bir Shopify gorseli (olculen ~48.000) karo sayisiyla orantili.
    assert estimate_tokens(1500, 2000) == 4000 * 3 * 4
