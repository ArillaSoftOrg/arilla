"""Admitad kesfi ve akisla indirme; gercek aga cikilmaz (httpx.MockTransport)."""

from __future__ import annotations

import base64
import gzip
import random
from pathlib import Path

import httpx
import pytest

from feeds.admitad import AdmitadNetwork
from feeds.download import DownloadError, download
from feeds.network import NetworkUnavailable, redact_url

SECRET_CODE = "s3cr3tc0de"


def feed_link(feed_id: str, fmt: str = "xml") -> str:
    return (
        "http://export.admitad.com/webmaster/websites/3009939/products/export_adv_products/"
        f"?user=someone&code={SECRET_CODE}&feed_id={feed_id}&format={fmt}"
    )


def program(pid: int, feeds: list[tuple[str, str]], currency: str = "USD") -> dict:
    return {
        "id": pid,
        "name": f"Program {pid}",
        "currency": currency,
        "connection_status": "active",
        "feeds_info": [
            {
                "name": name,
                "xml_link": feed_link(fid),
                "csv_link": feed_link(fid, "csv"),
                "admitad_last_update": "2026-10-13 22:47:39+00:00",
                "advertiser_last_update": "2026-10-13 22:47:39",
            }
            for fid, name in feeds
        ],
    }


class Api:
    def __init__(self, programs: list[dict], *, fail_first: int = 0) -> None:
        self.programs = programs
        self.fail_first = fail_first
        self.calls: list[str] = []
        self.token_calls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append(path)
        if path == "/token/":
            self.token_calls += 1
            expected = base64.b64encode(b"cid:csecret").decode()
            assert request.headers["authorization"] == f"Basic {expected}"
            body = dict(httpx.QueryParams(request.content.decode()))
            assert body["grant_type"] == "client_credentials"
            assert "advcampaigns_for_website" in body["scope"]
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 604800})
        assert request.headers["authorization"] == "Bearer tok"
        if self.fail_first:
            self.fail_first -= 1
            return httpx.Response(429, headers={"retry-after": "1"})
        if path == "/websites/v2/":
            return httpx.Response(200, json=[{"id": 3009939, "status": "active"}])
        if path == "/advcampaigns/website/3009939/":
            offset = int(request.url.params.get("offset", "0"))
            limit = int(request.url.params["limit"])
            page = self.programs[offset : offset + limit]
            return httpx.Response(
                200,
                json={
                    "_meta": {"count": len(self.programs), "limit": limit, "offset": offset},
                    "results": page,
                },
            )
        return httpx.Response(404)


def network(api: Api) -> AdmitadNetwork:
    return AdmitadNetwork(
        "cid",
        "csecret",
        client=httpx.Client(transport=httpx.MockTransport(api)),
        sleep=lambda _s: None,
    )


def test_kesif_besleme_kimligi_ad_alanli_ve_sir_saklanmaz() -> None:
    api = Api(
        [
            program(6115, [("14267", "10-25$"), ("15830", "hot products")]),
            program(20881, [("1", "x")]),
        ]
    )
    feeds = {f.external_id: f for f in network(api).discover()}
    assert set(feeds) == {"6115:14267", "6115:15830", "20881:1"}
    f = feeds["6115:14267"]
    assert (f.network, f.program_external_id, f.name, f.format, f.currency) == (
        "admitad",
        "6115",
        "10-25$",
        "xml",
        "USD",
    )
    assert f.default_config == {"parser": "yml"}
    assert f.source_url_redacted is not None
    assert SECRET_CODE not in f.source_url_redacted and "user=" not in f.source_url_redacted
    assert f.source_url_redacted.startswith("https://export.admitad.com/")
    assert "feed_id=14267" in f.source_url_redacted
    assert f.source_updated_at is not None and f.source_updated_at.year == 2026


def test_sayfalama_ve_program_filtresi() -> None:
    programs = [program(i, [(str(i), f"f{i}")]) for i in range(1, 251)]
    api = Api(programs)
    assert len(network(api).discover()) == 250
    assert api.calls.count("/advcampaigns/website/3009939/") == 3
    only = AdmitadNetwork(
        "cid",
        "csecret",
        client=httpx.Client(transport=httpx.MockTransport(Api(programs))),
        sleep=lambda _s: None,
        programs=frozenset({"7"}),
    )
    assert [f.external_id for f in only.discover()] == ["7:7"]


def test_indirme_adresi_her_seferinde_yeniden_cozulur_https() -> None:
    net = network(Api([program(6115, [("14267", "a")])]))
    url = net.download_url("6115:14267")
    assert url.startswith("https://export.admitad.com/") and f"code={SECRET_CODE}" in url
    with pytest.raises(NetworkUnavailable):
        net.download_url("6115:999")


def test_429_geri_cekilip_yeniden_denenir_token_tek_alinir() -> None:
    api = Api([program(6115, [("1", "a")])], fail_first=2)
    assert len(network(api).discover()) == 1
    assert api.token_calls == 1


def test_kimlik_bilgisi_yoksa_ag_kullanilamaz(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADMITAD_CLIENT_ID", "")
    monkeypatch.setenv("ADMITAD_CLIENT_SECRET", "")
    with pytest.raises(NetworkUnavailable):
        AdmitadNetwork()


def test_redact_url() -> None:
    url = "https://h.test/p?code=x&user=y&feed_id=1&token=z"
    assert redact_url(url) == "https://h.test/p?feed_id=1"


# --------------------------------------------------------------------------
# Indirme
# --------------------------------------------------------------------------


def client_for(body: bytes, *, status: int = 200, gz_header: bool = False) -> httpx.Client:
    def handler(_request: httpx.Request) -> httpx.Response:
        headers = {"content-encoding": "gzip"} if gz_header else {}
        return httpx.Response(status, stream=httpx.ByteStream(body), headers=headers)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_gzip_diske_sikistirilmis_ozet_cozulmus_icerikten(tmp_path: Path) -> None:
    import hashlib

    plain = b"<yml_catalog>" + b"x" * 100_000 + b"</yml_catalog>"
    a = download(
        "https://f.test/a",
        tmp_path / "a.bin",
        client=client_for(gzip.compress(plain, mtime=1), gz_header=True),
        min_free_bytes=0,
    )
    b = download(
        "https://f.test/a",
        tmp_path / "b.bin",
        client=client_for(gzip.compress(plain, mtime=2), gz_header=True),
        min_free_bytes=0,
    )
    assert a.sha256 == b.sha256 == hashlib.sha256(plain).hexdigest()
    assert a.bytes_on_disk < len(plain) and a.bytes_decoded == len(plain)
    assert a.path.read_bytes()[:2] == b"\x1f\x8b"


def test_tavan_disk_ve_hata_kodlari(tmp_path: Path) -> None:
    with pytest.raises(DownloadError) as big:
        download(
            "https://f.test/a",
            tmp_path / "a.bin",
            client=client_for(b"x" * 5000),
            max_bytes=1000,
            min_free_bytes=0,
        )
    assert big.value.code == "too_large" and not (tmp_path / "a.bin").exists()
    assert not (tmp_path / "a.bin.part").exists()
    with pytest.raises(DownloadError) as low:
        download(
            "https://f.test/a", tmp_path / "b.bin", client=client_for(b"x"), min_free_bytes=1 << 62
        )
    assert low.value.code == "disk_low"
    with pytest.raises(DownloadError) as server:
        download(
            "https://f.test/a",
            tmp_path / "c.bin",
            client=client_for(b"", status=503),
            min_free_bytes=0,
        )
    assert server.value.code == "http_5xx" and server.value.retryable
    truncated = gzip.compress(random.Random(1).randbytes(100_000))[:2000]
    with pytest.raises(DownloadError) as cut:
        download(
            "https://f.test/a",
            tmp_path / "d.bin",
            client=client_for(truncated, gz_header=True),
            min_free_bytes=0,
        )
    assert cut.value.code in {"truncated", "corrupt"}


def test_ornek_kipi_erken_keser_hata_vermez(tmp_path: Path) -> None:
    body = gzip.compress(random.Random(2).randbytes(3 << 20))
    result = download(
        "https://f.test/a",
        tmp_path / "s.bin",
        client=client_for(body, gz_header=True),
        min_free_bytes=0,
        stop_after_bytes=1 << 20,
    )
    assert result.partial and result.bytes_on_disk < len(body)
    assert result.path.exists()
