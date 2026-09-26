"""SSRF korumasi (docs/decisions/0031).

Iki katman ayri ayri ve birlikte dogrulanir:

* `check_url` — yazim duzeyi (sema, kimlik bilgisi, ic ad, IP literali, port).
* `GuardedBackend` — GERCEK soketle: cozulen IP denetlenir ve baglanti o
  IP'ye yapilir. Yerel bir HTTP sunucusu "genel" sayilan tek adres olarak
  politikaya eklenir; `evil.test` gibi baska bir ada cozulen her adres ic ag
  gibi davranir.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from collect.link.resolver import ResolutionFailed, fetch_page
from collect.link.safe_http import (
    BlockedDestination,
    DestinationPolicy,
    GuardedBackend,
    check_url,
    guarded_client,
    is_public_ip,
)

# --- is_public_ip -------------------------------------------------------------


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "127.8.9.10",
        "10.0.0.5",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",  # bulut metadata
        "100.64.0.1",  # CGNAT
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "fe80::1",
        "fc00::1",
        "::ffff:127.0.0.1",  # IPv4-mapped loopback
        "::ffff:10.0.0.1",
        "64:ff9b::7f00:1",  # NAT64 -> 127.0.0.1
        "2002:7f00:1::",  # 6to4 -> 127.0.0.1
        "not-an-ip",
    ],
)
def test_private_and_special_addresses_are_not_public(address: str) -> None:
    assert is_public_ip(address) is False


@pytest.mark.parametrize("address", ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
def test_global_addresses_are_public(address: str) -> None:
    assert is_public_ip(address) is True


# --- check_url ------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://magaza.example/urun",
        "data:text/html,<h1>x</h1>",
        "javascript:alert(1)",
        "gopher://magaza.example/",
        "https://user:pass@magaza.example/urun",
        "https://:pass@magaza.example/urun",
        "http://localhost/urun",
        "http://LOCALHOST./urun",
        "http://api.localhost/urun",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://db.internal/",
        "http://printer.local/",
        "http://intranet/",
        "http://127.0.0.1/",
        "http://10.1.2.3/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "https://magaza.example:6379/",
        "https://magaza.example:22/",
        "https://magaza.example/" + "a" * 3000,
    ],
)
def test_check_url_rejects_unsafe_urls(url: str) -> None:
    with pytest.raises(BlockedDestination):
        check_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://magaza.example/urun/canta",
        "http://magaza.example/urun",
        "https://www.magaza.example:8443/urun",
        "https://8.8.8.8/urun",
    ],
)
def test_check_url_accepts_public_http_urls(url: str) -> None:
    check_url(url)


# --- GuardedBackend: cozumleme aninda ----------------------------------------


def _client_resolving(mapping: dict[str, list[str]], **kwargs: object) -> httpx.Client:
    def resolver(host: str, port: int) -> list[str]:
        return mapping[host]

    return guarded_client(user_agent="test", backend=GuardedBackend(resolver=resolver), **kwargs)


def test_hostname_resolving_to_loopback_is_blocked_before_connecting() -> None:
    client = _client_resolving({"sahte-magaza.example": ["127.0.0.1"]})
    with pytest.raises(BlockedDestination):
        client.get("http://sahte-magaza.example/urun")


def test_hostname_resolving_to_metadata_address_is_blocked() -> None:
    client = _client_resolving({"sahte-magaza.example": ["169.254.169.254"]})
    with pytest.raises(BlockedDestination):
        client.get("http://sahte-magaza.example/latest/meta-data/")


def test_mixed_public_and_private_records_are_blocked() -> None:
    # Bir genel, bir ic A kaydi: istemci hangisine baglanacagini secemez olmali.
    client = _client_resolving({"karisik.example": ["8.8.8.8", "10.0.0.7"]})
    with pytest.raises(BlockedDestination):
        client.get("http://karisik.example/")


def test_ipv6_loopback_resolution_is_blocked() -> None:
    client = _client_resolving({"v6.example": ["::1"]})
    with pytest.raises(BlockedDestination):
        client.get("http://v6.example/")


def test_disallowed_port_is_blocked_at_connect_time() -> None:
    client = _client_resolving({"magaza.example": ["8.8.8.8"]})
    with pytest.raises(BlockedDestination):
        client.get("http://magaza.example:6379/")


# --- gercek soket ---------------------------------------------------------------


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - http.server API'si
        port = self.server.server_address[1]
        if self.path == "/urun":
            body = b"<html><title>ok</title></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/ic-aga-yonlendir":
            self.send_response(302)
            self.send_header("Location", f"http://ic-servis.test:{port}/gizli")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self.path == "/zincir":
            self.send_response(301)
            self.send_header("Location", "/urun")
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

    def log_message(self, *args: object) -> None:
        pass


@pytest.fixture
def local_server() -> Iterator[int]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()


def _local_setup(port: int) -> tuple[httpx.Client, DestinationPolicy, list[str]]:
    """`magaza.test` -> 127.0.0.1 ("genel"), `ic-servis.test` -> 127.0.0.2 (ic ag)."""
    policy = DestinationPolicy(
        allowed_ports=frozenset({port}), ip_allowed=lambda ip: ip == "127.0.0.1"
    )
    lookups: list[str] = []

    def resolver(host: str, _port: int) -> list[str]:
        lookups.append(host)
        return {"magaza.test": ["127.0.0.1"], "ic-servis.test": ["127.0.0.2"]}[host]

    client = guarded_client(
        user_agent="test", backend=GuardedBackend(resolver=resolver, policy=policy)
    )
    return client, policy, lookups


def test_connection_goes_to_the_validated_ip(local_server: int) -> None:
    # `magaza.test` isletim sisteminde cozulmez; istek basariliysa baglanti
    # denetlenen IP'ye yapilmistir — ikinci bir (rebinding'e acik) DNS
    # sorgusu yoktur.
    client, _, lookups = _local_setup(local_server)
    response = client.get(f"http://magaza.test:{local_server}/urun")
    assert response.status_code == 200
    assert lookups == ["magaza.test"]


def test_public_url_redirecting_to_internal_host_is_blocked(local_server: int) -> None:
    client, policy, _ = _local_setup(local_server)
    with pytest.raises(ResolutionFailed) as caught:
        fetch_page(f"http://magaza.test:{local_server}/ic-aga-yonlendir", client, policy=policy)
    assert caught.value.code == "blocked_destination"


def test_same_host_redirect_is_followed_and_revalidated(local_server: int) -> None:
    client, policy, lookups = _local_setup(local_server)
    page = fetch_page(f"http://magaza.test:{local_server}/zincir", client, policy=policy)
    assert page.final_url == f"http://magaza.test:{local_server}/urun"
    assert "ok" in page.html
    assert lookups  # her baglanti cozumleyiciden gecti


def test_guarded_client_ignores_environment_proxies(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
    client = guarded_client(user_agent="test")
    assert client._trust_env is False  # noqa: SLF001 - davranisin kendisi


def test_guarded_client_does_not_keep_cookies() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"set-cookie": "oturum=abc; Path=/"})

    client = guarded_client(user_agent="test")
    client._transport = httpx.MockTransport(handler)  # noqa: SLF001
    client.get("https://magaza.example/")
    assert len(client.cookies.jar) == 0
