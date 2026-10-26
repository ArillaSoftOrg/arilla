"""Besleme dosyasi butunluk taramasi ve HTTP tanilama (karar 0152). Veritabani yok."""

from __future__ import annotations

import gzip
import json
import tracemalloc
from pathlib import Path

import httpx
import pytest

from feeds.download import (
    DownloadError,
    diagnostics_path,
    download,
    http_diagnostics,
    read_diagnostics,
)
from feeds.integrity import BLOCK, verify
from tests.feed_fixtures import offer, write, yml


def feed(count: int, **kw: object) -> bytes:
    return yml([offer(str(1005000000000000 + i), **kw) for i in range(count)])


def scan(tmp_path: Path, data: bytes, *, gz: bool = False):
    path = write(tmp_path / ("f.gz" if gz else "f.xml"), data, gz=gz)
    result = verify(path, "yml")
    assert result is not None
    return result


def test_tam_dosya_gecer_ve_kayitlari_sayar(tmp_path: Path) -> None:
    result = scan(tmp_path, feed(25))
    assert (result.ok, result.code, result.records) == (True, None, 25)
    gz = scan(tmp_path, feed(25), gz=True)
    assert (gz.ok, gz.records) == (True, 25)
    assert gz.bytes_decoded == result.bytes_decoded


def test_kapanis_etiketi_olmayan_dosya_kesiktir(tmp_path: Path) -> None:
    data = feed(30)
    cut = data[: data.rindex(b"</offers>")]  # son kayit tam, kapanis yok (26 Ekim durumu)
    result = scan(tmp_path, cut)
    assert (result.ok, result.code) == (False, "truncated")
    assert "kapanis" in result.detail
    assert result.records == 30


def test_kayit_ortasinda_kesilen_dosya_kesiktir(tmp_path: Path) -> None:
    data = feed(30)
    result = scan(tmp_path, data[: int(len(data) * 0.8)])
    assert (result.ok, result.code) == (False, "truncated")
    assert "acik kayit" in result.detail


def test_gzip_akisi_kesilirse_kesiktir(tmp_path: Path) -> None:
    packed = gzip.compress(feed(2000))
    path = tmp_path / "f.gz"
    path.write_bytes(packed[: len(packed) // 3])
    result = verify(path, "yml")
    assert result is not None and (result.ok, result.code) == (False, "truncated")


def test_gecerli_gzip_icinde_kesik_belge_kesiktir(tmp_path: Path) -> None:
    """26 Ekim 2026: gzip kendi icinde tamam, ama icindeki YML belgesi yarim."""
    data = feed(200)
    result = scan(tmp_path, data[: int(len(data) * 0.34)], gz=True)
    assert (result.ok, result.code) == (False, "truncated")


def test_kayitsiz_dosya_bostur(tmp_path: Path) -> None:
    result = scan(tmp_path, yml([]))
    assert (result.ok, result.code) == (False, "empty")


def test_kapanistan_sonra_bosluk_serbest_baska_metin_degil(tmp_path: Path) -> None:
    assert scan(tmp_path, feed(3) + b"\n\n  \n").ok
    junk = scan(tmp_path, feed(3) + b"garbage")
    assert (junk.ok, junk.code) == (False, "truncated")


def test_blok_sinirinda_kayit_sayisi_sasmaz(tmp_path: Path) -> None:
    """Dosya birkac MiB: `<offer`/`</offer>` blok sinirlarina dusse de cift/eksik sayim yok."""
    big = yml([offer(str(1005000000000000 + i), title="t" * 977 + str(i)) for i in range(4000)])
    assert len(big) > 3 * BLOCK
    result = scan(tmp_path, big)
    assert (result.ok, result.records) == (True, 4000)
    # Ayni dosya her bayt kaymasinda ayni sonucu verir.
    for pad in (1, 7, 15, 16, 17):
        assert scan(tmp_path, b" " * pad + big).records == 4000  # basta bosluk serbest


def test_desteklenmeyen_bicimde_tarama_yok(tmp_path: Path) -> None:
    path = write(tmp_path / "x.ndjson", b'{"a": 1}\n')
    assert verify(path, "ndjson") is None


def test_tarama_dosya_buyuklugunde_bellek_tutmaz(tmp_path: Path) -> None:
    """Yaklasik 24 MiB cozulmus icerik; tepe bellek birkac MiB'i asmamali (RAM'e yukleme yok)."""
    big = yml([offer(str(1005000000000000 + i), title="t" * 1500 + str(i)) for i in range(16_000)])
    path = write(tmp_path / "big.gz", big, gz=True)
    assert len(big) > 20 << 20
    tracemalloc.start()
    try:
        result = verify(path, "yml")
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert result is not None and (result.ok, result.records) == (True, 16_000)
    assert peak < 8 << 20, peak


# --------------------------------------------------------------------------
# HTTP tanilama: izin listesi, sir sizmaz, content-length denetimi
# --------------------------------------------------------------------------

SECRET = "s3cr3tc0de"
URL = f"https://export.test/webmaster/export/?user=someone&code={SECRET}&feed_id=7"


def client_for(body: bytes, headers: dict[str, str]) -> httpx.Client:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=httpx.ByteStream(body), headers=headers)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_tanilama_izin_listeli_ve_sir_icermez(tmp_path: Path) -> None:
    body = gzip.compress(feed(5))
    headers = {
        "content-encoding": "gzip",
        "content-length": str(len(body)),
        "etag": '"abc123"',
        "last-modified": "Sun, 25 Oct 2026 18:48:51 GMT",
        "set-cookie": f"session={SECRET}",
        "authorization": f"Bearer {SECRET}",
        "location": f"https://elsewhere.test/?code={SECRET}",
        "x-cache": "https://cdn.test/?token=abc",
    }
    result = download(
        URL, tmp_path / "feed-7-1.bin", client=client_for(body, headers), min_free_bytes=0
    )
    diag = result.diagnostics
    assert diag["status"] == 200 and diag["host"] == "export.test"
    assert diag["gzip_complete"] is True
    assert diag["bytes_on_disk"] == len(body)
    assert diag["headers"]["etag"] == '"abc123"'  # type: ignore[index]
    # Sidecar diskte ve ayni icerikte; hicbir yerde sir, yol ya da sorgu yok.
    stored = diagnostics_path(tmp_path / "feed-7-1.bin").read_text(encoding="utf-8")
    assert json.loads(stored) == read_diagnostics(tmp_path / "feed-7-1.bin")
    for text in (stored, json.dumps(diag)):
        lowered = text.lower()
        for leak in (SECRET, "someone", "feed_id", "/webmaster", "set-cookie", "authorization"):
            assert leak.lower() not in lowered, leak
    assert "set-cookie" not in diag["headers"] and "location" not in diag["headers"]  # type: ignore[operator]


def test_http_diagnostics_adres_degerlerini_dusurur() -> None:
    response = httpx.Response(
        200,
        headers={"etag": "https://x.test/?code=abc", "age": "12"},
        request=httpx.Request("GET", URL),
    )
    diag = http_diagnostics(response)
    assert diag["headers"] == {"age": "12"}
    assert SECRET not in json.dumps(diag)


def test_content_length_uyusmazligi_kesik_sayilir_ve_yeniden_denenir(tmp_path: Path) -> None:
    body = b"x" * 1000
    with pytest.raises(DownloadError) as error:
        download(
            URL,
            tmp_path / "feed-7-2.bin",
            client=client_for(body, {"content-length": "5000"}),
            min_free_bytes=0,
        )
    assert error.value.code == "truncated" and error.value.retryable
    assert not (tmp_path / "feed-7-2.bin").exists()
    assert not diagnostics_path(tmp_path / "feed-7-2.bin").exists()
