"""Tek sayfa getirmenin sinirlari ve hata kodlari (docs/decisions/0031).

Ag yok: `httpx.MockTransport`. IP duzeyi denetim `test_link_safe_http.py`'de;
burada yazim duzeyi denetimin yonlendirme dongusunde HER adimda calistigi,
durum kodlarinin kararli `code`lara dondugu ve govde sinirlari dogrulanir.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator

import httpx
import pytest

from collect.link import resolver
from collect.link.resolver import ResolutionFailed, fetch_page
from collect.link.robots import RobotsCache

PAGE = "<html><head><title>Urun</title></head><body>ok</body></html>"


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def _code(url: str, client: httpx.Client, **kwargs: object) -> str:
    with pytest.raises(ResolutionFailed) as caught:
        fetch_page(url, client, **kwargs)
    return caught.value.code


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (404, "not_found"),
        (410, "not_found"),
        (401, "access_denied"),
        (403, "access_denied"),
        (429, "rate_limited"),
        (500, "upstream_error"),
        (503, "upstream_error"),
        (418, "http_error"),
    ],
)
def test_http_status_maps_to_stable_code(status: int, code: str) -> None:
    client = _client(lambda request: httpx.Response(status, text="hata"))
    assert _code("https://magaza.example/urun", client) == code


@pytest.mark.parametrize(
    "content_type",
    ["application/pdf", "image/jpeg", "application/json", "text/plain"],
)
def test_unsupported_content_type_is_rejected(content_type: str) -> None:
    client = _client(
        lambda request: httpx.Response(200, content=b"x", headers={"content-type": content_type})
    )
    assert _code("https://magaza.example/urun", client) == "unsupported_content"


def test_declared_huge_body_is_rejected_without_reading() -> None:
    client = _client(
        lambda request: httpx.Response(
            200,
            content=b"<html></html>",
            headers={"content-type": "text/html", "content-length": str(50 * 1024 * 1024)},
        )
    )
    assert _code("https://magaza.example/urun", client) == "too_large"


def test_streamed_huge_body_is_cut_at_the_limit() -> None:
    sent = {"bytes": 0}

    def chunks() -> Iterator[bytes]:
        block = b"<p>" + b"x" * 65_536 + b"</p>"
        while sent["bytes"] < 20 * 1024 * 1024:
            sent["bytes"] += len(block)
            yield block

    client = _client(
        lambda request: httpx.Response(200, content=chunks(), headers={"content-type": "text/html"})
    )
    assert _code("https://magaza.example/urun", client) == "too_large"
    # Sinirin hemen ustunde durdu; 20 MB'in tamami okunmadi.
    assert sent["bytes"] < resolver.MAX_BYTES + 200_000


def test_read_timeout_maps_to_timeout() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("yavas", request=request)

    assert _code("https://magaza.example/urun", _client(handler)) == "timeout"


def test_slow_drip_body_hits_the_total_deadline() -> None:
    def chunks() -> Iterator[bytes]:
        while True:
            yield b"<p>x</p>"

    client = _client(
        lambda request: httpx.Response(200, content=chunks(), headers={"content-type": "text/html"})
    )
    assert _code("https://magaza.example/urun", client, deadline_seconds=0.0) == "timeout"


def test_connection_error_maps_to_fetch_failed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("baglanti yok", request=request)

    assert _code("https://magaza.example/urun", _client(handler)) == "fetch_failed"


def test_redirect_chain_is_followed_to_the_final_page() -> None:
    hops = {
        "/kisa": "https://magaza.example/ara-adim",
        "/ara-adim": "/urun/canta",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path in hops:
            return httpx.Response(301, headers={"location": hops[request.url.path]})
        return httpx.Response(200, text=PAGE, headers={"content-type": "text/html"})

    page = fetch_page("https://magaza.example/kisa", _client(handler))
    assert page.final_url == "https://magaza.example/urun/canta"
    assert "ok" in page.html


def test_too_many_redirects_is_a_stable_failure() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": f"{request.url.path}x"})

    assert _code("https://magaza.example/d", _client(handler)) == "too_many_redirects"


@pytest.mark.parametrize(
    "location",
    [
        "http://127.0.0.1/admin",
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost:6379/",
        "http://[::1]/",
        "file:///etc/passwd",
        "http://user:pw@magaza.example/",
    ],
)
def test_redirect_to_unsafe_destination_is_blocked(location: str) -> None:
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(302, headers={"location": location})

    assert _code("https://magaza.example/urun", _client(handler)) == "blocked_destination"
    # Tehlikeli adrese hic istek gitmedi.
    assert requested == ["https://magaza.example/urun"]


def test_redirect_to_other_origin_rechecks_robots() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "baska.example" and request.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nDisallow: /\n")
        if request.url.host == "magaza.example":
            return httpx.Response(302, headers={"location": "https://baska.example/urun"})
        return httpx.Response(200, text=PAGE, headers={"content-type": "text/html"})

    client = _client(handler)
    code = _code("https://magaza.example/urun", client, robots=RobotsCache(client=client))
    assert code == "robots_disallowed"


def test_request_carries_only_our_user_agent_and_no_cookies() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, text=PAGE, headers={"content-type": "text/html"})

    fetch_page("https://magaza.example/urun", _client(handler))
    headers = seen[0].headers
    assert headers["user-agent"].startswith("ArillaBot/")
    assert "cookie" not in headers
    assert "authorization" not in headers


def test_charset_from_header_is_respected() -> None:
    body = "<html><title>Çanta</title></html>".encode("iso-8859-9")
    client = _client(
        lambda request: httpx.Response(
            200, content=body, headers={"content-type": "text/html; charset=iso-8859-9"}
        )
    )
    assert "Çanta" in fetch_page("https://magaza.example/urun", client).html
