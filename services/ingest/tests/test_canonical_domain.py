"""Kanonik alan adi kaniti: yonlendirme dogrulamasi ve ret yollari (agsiz)."""

from __future__ import annotations

import httpx
import pytest

from collect import canonical_domain
from collect.canonical_domain import discover, validated_redirect_host
from collect.verify_currency import RateLimiter
from collect.verify_readiness import OptionConventions, Target

START = "https://shop.myshopify.com/robots.txt"


@pytest.mark.parametrize(
    "location",
    [
        "http://www.example.com/robots.txt",  # https degil
        "https://user:pw@www.example.com/robots.txt",  # kimlik bilgisi
        "https://www.example.com:8443/robots.txt",  # standart olmayan port
        "https://www.example.com/baska",  # baska yol
        "https://www.example.com/robots.txt?x=1",  # sorgu
        "https://shop.myshopify.com/robots.txt",  # ayni host (dongu)
        "https://localhost/robots.txt",  # ic ad
        "https://10.0.0.5/robots.txt",  # ozel IP
    ],
)
def test_unsafe_redirects_are_rejected(location: str) -> None:
    with pytest.raises(ValueError):
        validated_redirect_host(START, location, "shop.myshopify.com")


def test_valid_redirect_returns_lowercase_host() -> None:
    location = "https://WWW.Example.com/robots.txt"
    host = validated_redirect_host(START, location, "shop.myshopify.com")
    assert host == "www.example.com"


def _client(handler: httpx.MockTransport) -> httpx.Client:
    return httpx.Client(transport=handler, follow_redirects=False)


def _discover(handler) -> canonical_domain.CanonicalResult:
    target = Target("shop", "shop.myshopify.com", {})
    limiter = RateLimiter(sleep=lambda _s: None)
    conventions = OptionConventions(colour=("renk",), size=("beden",))
    return discover(_client(httpx.MockTransport(handler)), target, limiter, conventions)


def test_redirect_to_other_path_fails_without_following() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(301, headers={"Location": "https://www.example.com/evil"})

    result = _discover(handler)
    assert result.verdict == "FAIL"
    assert result.reason.startswith("redirect_rejected")
    assert seen == [START]


def test_redirect_loop_and_hop_limit_fail() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        nxt = "a.example.com" if host != "a.example.com" else "shop.myshopify.com"
        return httpx.Response(301, headers={"Location": f"https://{nxt}/robots.txt"})

    result = _discover(handler)
    assert result.verdict == "FAIL"
    assert "redirect" in result.reason


def test_foreign_shop_identity_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(canonical_domain, "resolve_public_ips", lambda _h: ["23.227.38.65"])

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "shop.myshopify.com":
            return httpx.Response(301, headers={"Location": "https://www.example.com/robots.txt"})
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nDisallow:\n")
        if request.url.path == "/meta.json":
            return httpx.Response(200, json={"myshopify_domain": "other.myshopify.com"})
        raise AssertionError(f"kimlik reddinden sonra istek atilmamali: {request.url}")

    result = _discover(handler)
    assert result.verdict == "FAIL"
    assert result.shopify_identity == "FAIL"
    assert result.reason.startswith("myshopify_domain_mismatch")
    assert result.canonical_host == "www.example.com"


def test_non_public_resolution_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(canonical_domain, "resolve_public_ips", lambda _h: ["10.1.2.3"])

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "shop.myshopify.com":
            return httpx.Response(301, headers={"Location": "https://www.example.com/robots.txt"})
        return httpx.Response(200, text="")

    result = _discover(handler)
    assert result.verdict == "FAIL"
    assert result.reason.startswith("non_public_ip")
