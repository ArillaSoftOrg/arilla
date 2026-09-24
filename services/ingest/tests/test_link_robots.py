"""`robots.txt` denetimi — atlatma yolu olmadigini da sinar."""

from __future__ import annotations

from urllib.robotparser import RobotFileParser

import httpx
import pytest

from collect.link.robots import USER_AGENT, RobotsCache, RobotsDisallowed, build_user_agent

ROBOTS = """
User-agent: *
Disallow: /gizli/
Disallow: /sepet
Crawl-delay: 5

User-agent: ArillaBot
Disallow: /yasak/
"""


def _client(body: str = ROBOTS, status: int = 200) -> httpx.Client:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(status, text=body)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    client._arilla_calls = calls  # type: ignore[attr-defined]
    return client


def test_allowed_path_passes() -> None:
    cache = RobotsCache(client=_client())
    cache.check("https://magaza.example", "https://magaza.example/urun/canta")


def test_disallowed_path_is_refused() -> None:
    cache = RobotsCache(client=_client())
    with pytest.raises(RobotsDisallowed):
        cache.check("https://magaza.example", "https://magaza.example/yasak/urun")


def test_our_own_user_agent_rules_are_honoured() -> None:
    """Site bizi adimizla engellediyse, yildiz kurali bizi kurtarmaz."""
    cache = RobotsCache(client=_client())
    with pytest.raises(RobotsDisallowed):
        cache.check("https://magaza.example", "https://magaza.example/yasak/x")


def test_missing_robots_means_no_rules() -> None:
    cache = RobotsCache(client=_client(body="", status=404))
    cache.check("https://magaza.example", "https://magaza.example/urun/canta")


def test_forbidden_robots_blocks_everything() -> None:
    """401/403 site kapali demektir; izin varsaymak yanlis olur."""
    cache = RobotsCache(client=_client(body="", status=403))
    with pytest.raises(RobotsDisallowed):
        cache.check("https://magaza.example", "https://magaza.example/urun/canta")


def test_robots_is_cached_per_host() -> None:
    client = _client()
    cache = RobotsCache(client=client)
    for _ in range(3):
        cache.check("https://magaza.example", "https://magaza.example/urun/canta")
    assert len(client._arilla_calls) == 1  # type: ignore[attr-defined]


def test_crawl_delay_is_read_from_the_star_group() -> None:
    cache = RobotsCache(client=_client(body="User-agent: *\nCrawl-delay: 5\n"))
    assert cache.crawl_delay("https://magaza.example") == 5.0


def test_specific_group_wins_entirely_over_star() -> None:
    """robots.txt'te yonergeler birlesmez: bize ozel grup varsa yalnizca o gecerli.

    ROBOTS icinde `*` grubunun Crawl-delay'i var, `ArillaBot` grubunun yok —
    dogru sonuc None. `*`'dan miras almak sartnameye aykiri olurdu.
    """
    cache = RobotsCache(client=_client())
    assert cache.crawl_delay("https://magaza.example") is None


# --- user-agent: alan adi koda gomulmez, APP_URL'den turetilir ---------------


def test_user_agent_without_app_url_has_no_url() -> None:
    assert build_user_agent(None) == "ArillaBot/1.0"
    assert build_user_agent("") == "ArillaBot/1.0"
    assert build_user_agent("   ") == "ArillaBot/1.0"


def test_user_agent_uses_normalized_app_url() -> None:
    expected = "ArillaBot/1.0 (+https://site.test)"
    assert build_user_agent("https://site.test") == expected
    assert build_user_agent("https://site.test/") == expected
    assert build_user_agent('  "https://site.test/"  ') == expected
    assert build_user_agent("'https://site.test'") == expected


def test_user_agent_keeps_port() -> None:
    assert build_user_agent("http://site.test:8080/") == "ArillaBot/1.0 (+http://site.test:8080)"


def test_user_agent_ignores_invalid_or_local_app_url() -> None:
    for value in (
        "site.test",
        "ftp://site.test",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://user:pw@site.test",
        "https://:gizli-parola@site.test",
    ):
        assert build_user_agent(value) == "ArillaBot/1.0", value


def test_user_agent_never_contains_placeholder_domain() -> None:
    # Yerel .env'den bagimsiz: modul sabiti degil, fonksiyonun kendisi sinanir.
    assert ".example" not in build_user_agent(None)
    assert build_user_agent(None) == "ArillaBot/1.0"
    assert ".example" not in USER_AGENT


def test_robots_group_still_matches_versioned_user_agent() -> None:
    """robots.txt `ArillaBot` grubu, URL'li UA icin de gecerli kalir."""
    parser = RobotFileParser()
    parser.parse(["User-agent: ArillaBot", "Disallow: /gizli", "", "User-agent: *", "Allow: /"])
    agent = build_user_agent("https://site.test")
    assert not parser.can_fetch(agent, "https://merchant.test/gizli/urun")
    assert parser.can_fetch(agent, "https://merchant.test/urun")
