"""Shopify toplamasinda magazaya saygi (docs/decisions/0042).

Kendimizi tanitan user-agent, yonlendirme izlememe, ilk katalog isteginden
once kati robots.txt, `Crawl-delay` ve bunlarin `run_ingest`'teki ret
sozlesmesi. Hicbir test aga cikmaz (httpx.MockTransport); `integration`
isaretli olanlar yerel veritabani ister.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import pytest

from collect import pipeline
from collect.bootstrap import SHOPIFY_MAPPING
from collect.gate import IngestRefused
from collect.link.robots import USER_AGENT
from collect.link.safe_http import GuardedTransport
from collect.robots_policy import MAX_CRAWL_DELAY_SECONDS
from collect.sources.shopify import ShopifyConnector
from collect.verify_readiness import evaluate_robots

BASE_URL = "https://magaza.example/products.json"

CONFIG: dict[str, Any] = {
    "value_formats": {"decimal_separator": ".", "thousands_separator": ","},
    "currency": "TRY",
    "currency_verified": True,
    "mapping": SHOPIFY_MAPPING,
}


def _product(index: int) -> dict[str, Any]:
    return {
        "id": index,
        "handle": f"urun-{index}",
        "title": f"Urun {index}",
        "vendor": "Marka",
        "product_type": "Tur",
        "variants": [{"id": index * 10, "available": True, "price": "129.90"}],
        "images": [],
    }


def _text(body: str, content_type: str = "text/plain; charset=utf-8") -> httpx.Response:
    return httpx.Response(200, text=body, headers={"Content-Type": content_type})


Responder = httpx.Response | Callable[[httpx.Request], httpx.Response]


class Shop:
    """Sahte magaza: her istegi (yol+sorgu, user-agent) kaydeder."""

    def __init__(
        self,
        robots: Responder | None = None,
        *,
        total: int = 3,
        products: Responder | None = None,
    ) -> None:
        self.robots = robots if robots is not None else httpx.Response(404)
        self.total = total
        self.products = products
        self.calls: list[str] = []
        self.user_agents: list[str | None] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request.url.raw_path.decode())
        self.user_agents.append(request.headers.get("User-Agent"))
        if request.url.path == "/robots.txt":
            return self._respond(self.robots, request)
        if self.products is not None:
            return self._respond(self.products, request)
        page = int(request.url.params["page"])
        limit = int(request.url.params["limit"])
        start = (page - 1) * limit
        items = [_product(i + 1) for i in range(start, min(start + limit, self.total))]
        return httpx.Response(200, json={"products": items})

    @staticmethod
    def _respond(responder: Responder, request: httpx.Request) -> httpx.Response:
        return responder(request) if callable(responder) else responder

    def client(self, **kwargs: Any) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler), **kwargs)

    @property
    def product_calls(self) -> list[str]:
        return [call for call in self.calls if call.startswith("/products.json")]


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0
        self.slept: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(round(seconds, 6))
        self.now += seconds


def _connector(shop: Shop, transport: dict[str, Any] | None = None, **kwargs: Any):
    config = {**CONFIG, "transport": transport or {}}
    fake = kwargs.pop("fake", None) or FakeClock()
    return ShopifyConnector(
        base_url=kwargs.pop("base_url", BASE_URL),
        config=config,
        client=kwargs.pop("client", None) or shop.client(),
        sleep=fake.sleep,
        clock=fake.clock,
    )


def _raises(error: type[Exception]) -> Callable[[httpx.Request], httpx.Response]:
    def respond(request: httpx.Request) -> httpx.Response:
        raise error("sahte hata", request=request)

    return respond


# --- istemci ve user-agent -------------------------------------------------------------


def test_default_client_is_guarded_identifying_and_does_not_follow_redirects() -> None:
    connector = ShopifyConnector(base_url=BASE_URL, config=CONFIG)

    client = connector._client()

    assert client.headers["User-Agent"] == USER_AGENT
    assert USER_AGENT.startswith("ArillaBot/")
    assert "python-httpx" not in client.headers["User-Agent"]
    assert client.follow_redirects is False
    assert isinstance(client._transport, GuardedTransport)
    assert client.timeout.read is not None and client.timeout.connect is not None
    # Kosu boyunca tek istemci.
    assert connector._client() is client


def test_every_request_identifies_us_even_with_an_anonymous_client() -> None:
    shop = Shop()

    records = list(_connector(shop).fetch())

    assert len(records) == 3
    assert shop.calls[0] == "/robots.txt"
    assert shop.user_agents == [USER_AGENT] * len(shop.calls)


def test_robots_is_fetched_exactly_once_before_the_first_products_request() -> None:
    shop = Shop(total=25)

    list(_connector(shop, {"pagination": {"size": 10}}).fetch())

    assert shop.calls == [
        "/robots.txt",
        "/products.json?page=1&limit=10",
        "/products.json?page=2&limit=10",
        "/products.json?page=3&limit=10",
    ]


def test_products_redirect_is_not_followed_even_if_the_client_would() -> None:
    def moved(request: httpx.Request) -> httpx.Response:
        return httpx.Response(301, headers={"Location": "https://baska.example/products.json"})

    shop = Shop(products=moved)
    connector = _connector(shop, client=shop.client(follow_redirects=True))

    with pytest.raises(httpx.HTTPStatusError):
        list(connector.fetch())

    assert shop.calls == ["/robots.txt", "/products.json?page=1&limit=30"]


def test_redirect_is_not_retried_even_with_retry_config() -> None:
    shop = Shop(products=httpx.Response(302, headers={"Location": "/products.json"}))
    connector = _connector(shop, {"retry": {"max_retries": 3}})

    with pytest.raises(httpx.HTTPStatusError):
        list(connector.fetch())

    assert len(shop.product_calls) == 1


# --- robots.txt: kati, kosu basina bir kez ------------------------------------------------


@pytest.mark.parametrize(
    ("robots", "code", "reason"),
    [
        (_text("User-agent: *\nDisallow: /products.json\n"), "robots_disallowed", ""),
        (_text("User-agent: *\nDisallow: /products\n"), "robots_disallowed", ""),
        (_text("User-agent: *\nDisallow: /\n"), "robots_disallowed", ""),
        (
            _text("User-agent: ArillaBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"),
            "robots_disallowed",
            "",
        ),
        (_text("User-agent: *\nDisallow: /*.json\n"), "robots_disallowed", "wildcard"),
        (
            httpx.Response(301, headers={"Location": "https://www.magaza.example/robots.txt"}),
            "robots_unavailable",
            "http_301",
        ),
        (httpx.Response(302), "robots_unavailable", "http_302"),
        (httpx.Response(401), "robots_unavailable", "http_401"),
        (httpx.Response(403), "robots_unavailable", "http_403"),
        (httpx.Response(500), "robots_unavailable", "http_500"),
        (httpx.Response(503), "robots_unavailable", "http_503"),
        (_text("<html>challenge</html>", "text/html"), "robots_unavailable", "robots_unusable"),
        (_raises(httpx.ReadTimeout), "robots_unavailable", "timeout"),
        (_raises(httpx.ConnectError), "robots_unavailable", "network_error"),
    ],
)
def test_robots_blocks_or_fails_closed_before_any_products_request(
    robots: Responder, code: str, reason: str
) -> None:
    shop = Shop(robots=robots)
    # Yeniden deneme ayari robots'a UYGULANMAZ.
    connector = _connector(shop, {"retry": {"max_retries": 3}})

    with pytest.raises(IngestRefused) as refused:
        list(connector.fetch())

    assert refused.value.refusal.code == code
    assert reason in refused.value.refusal.message
    assert shop.calls == ["/robots.txt"]


def test_robots_redirect_is_not_followed_even_if_the_client_would() -> None:
    shop = Shop(robots=httpx.Response(301, headers={"Location": "https://magaza.example/r.txt"}))
    connector = _connector(shop, client=shop.client(follow_redirects=True))

    with pytest.raises(IngestRefused):
        list(connector.fetch())

    assert shop.calls == ["/robots.txt"]


def test_missing_robots_txt_means_no_rules() -> None:
    shop = Shop(robots=httpx.Response(404))

    assert len(list(_connector(shop).fetch())) == 3


def test_rules_for_other_paths_and_bots_do_not_block() -> None:
    body = "User-agent: AhrefsBot\nDisallow: /\n\nUser-agent: *\nDisallow: /cart\n"
    shop = Shop(robots=_text(body))

    assert len(list(_connector(shop).fetch())) == 3


def test_invalid_feed_url_is_refused_without_any_request() -> None:
    shop = Shop()
    for url in ("http://magaza.example/products.json", "https://u:p@magaza.example/p.json"):
        with pytest.raises(IngestRefused) as refused:
            list(_connector(shop, base_url=url).fetch())
        assert refused.value.refusal.code == "feed_url_invalid"
    assert shop.calls == []


# --- sorgu bicimi --------------------------------------------------------------------


def test_robots_paths_match_the_real_first_request() -> None:
    shop = Shop(total=1)
    connector = _connector(shop, {"pagination": {"size": 250}, "shopify": {"max_products": 600}})

    list(connector.fetch())

    first_products_request = shop.product_calls[0]
    assert first_products_request == "/products.json?page=1&limit=250"
    assert connector.robots_paths() == (
        "/products.json",
        first_products_request,
        "/products.json?page=2&limit=250",
    )


def test_single_page_run_does_not_check_a_second_page_shape() -> None:
    connector = _connector(Shop())  # varsayilan tavan 30, sayfa 30

    assert connector.robots_paths() == ("/products.json", "/products.json?page=1&limit=30")


def test_rule_on_the_actual_page_size_blocks_only_that_run() -> None:
    body = "User-agent: *\nDisallow: /products.json?page=1&limit=250\n"

    blocked = Shop(robots=_text(body))
    with pytest.raises(IngestRefused):
        list(
            _connector(
                blocked, {"pagination": {"size": 250}, "shopify": {"max_products": 300}}
            ).fetch()
        )
    assert blocked.product_calls == []

    # Ayni kural 30'luk sayfalari yasaklamiyor.
    allowed = Shop(robots=_text(body))
    assert len(list(_connector(allowed).fetch())) == 3


# --- Crawl-delay ---------------------------------------------------------------------


def test_crawl_delay_spaces_every_request_including_after_robots() -> None:
    fake = FakeClock()
    shop = Shop(robots=_text("User-agent: *\nCrawl-delay: 5\n"), total=25)

    list(_connector(shop, {"pagination": {"size": 10}}, fake=fake).fetch())

    assert len(shop.product_calls) == 3
    assert fake.slept == [5.0, 5.0, 5.0]


def test_slower_configured_rate_wins_over_shorter_crawl_delay() -> None:
    fake = FakeClock()
    shop = Shop(robots=_text("User-agent: *\nCrawl-delay: 2\n"))
    transport = {"rate_limit": {"requests_per_second": 0.1}}

    list(_connector(shop, transport, fake=fake).fetch())

    assert fake.slept == [10.0]


def test_longer_crawl_delay_slows_a_faster_configured_rate() -> None:
    fake = FakeClock()
    shop = Shop(robots=_text("User-agent: *\nCrawl-delay: 4\n"))
    transport = {"rate_limit": {"requests_per_second": 1.5}}

    list(_connector(shop, transport, fake=fake).fetch())

    assert fake.slept == [4.0]


def test_crawl_delay_at_threshold_is_honoured() -> None:
    fake = FakeClock()
    delay = int(MAX_CRAWL_DELAY_SECONDS)
    shop = Shop(robots=_text(f"User-agent: *\nCrawl-delay: {delay}\n"))

    list(_connector(shop, fake=fake).fetch())

    assert fake.slept == [float(delay)]


def test_excessive_crawl_delay_is_refused_without_waiting() -> None:
    fake = FakeClock()
    delay = int(MAX_CRAWL_DELAY_SECONDS) + 1
    shop = Shop(robots=_text(f"User-agent: *\nCrawl-delay: {delay}\n"))

    with pytest.raises(IngestRefused) as refused:
        list(_connector(shop, fake=fake).fetch())

    assert refused.value.refusal.code == "robots_crawl_delay_too_long"
    assert shop.calls == ["/robots.txt"]
    assert fake.slept == []


# --- hazirlik dogrulamasi ile ayni yorum -------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        "User-agent: *\nDisallow: /products\n",
        "User-agent: *\nDisallow: /*.json\n",
        "User-agent: *\nDisallow: /*products*\n",
        "User-agent: ArillaBot\nDisallow: /\n",
        "User-agent: *\nDisallow: /cart\n",
        "User-agent: AhrefsBot\nDisallow: /\n",
    ],
)
def test_runtime_and_readiness_agree_on_robots(body: str) -> None:
    shop = Shop(robots=_text(body))
    readiness_refusal, _ = evaluate_robots(body)

    try:
        list(_connector(shop).fetch())
    except IngestRefused:
        runtime_allowed = False
    else:
        runtime_allowed = True

    assert runtime_allowed is (readiness_refusal is None)


# --- boru hatti: ret sozlesmesi (veritabanisiz) -----------------------------------------


class _Cursor:
    def __init__(self, conn: _Conn) -> None:
        self.conn = conn
        self._row: tuple[Any, ...] | None = None

    def __enter__(self) -> _Cursor:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def execute(self, sql: str, params: Any = None) -> None:
        self.conn.statements.append((" ".join(sql.split()), params))
        if "FROM merchant WHERE slug" in sql:
            self._row = (7, "magaza", "shopify", BASE_URL, self.conn.feed_config, True)
        elif "pg_try_advisory_lock" in sql:
            self._row = (True,)
        elif "INSERT INTO ingest_run" in sql:
            self._row = (99,)
        else:
            self._row = None

    def fetchone(self) -> tuple[Any, ...] | None:
        return self._row


class _Conn:
    def __init__(self, feed_config: dict[str, Any]) -> None:
        self.feed_config = feed_config
        self.statements: list[tuple[str, Any]] = []
        self.rollbacks = 0

    def cursor(self) -> _Cursor:
        return _Cursor(self)

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        self.rollbacks += 1


def test_pipeline_records_robots_refusal_as_failed_without_writes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shop = Shop(robots=_text("User-agent: *\nDisallow: /products.json\n"))
    monkeypatch.setattr(ShopifyConnector, "_client", lambda self: shop.client())
    conn = _Conn({**CONFIG, "transport": {}})

    result = pipeline.run_ingest(conn, "magaza")  # type: ignore[arg-type]

    assert result.status == "failed"
    assert result.refusal == "robots_disallowed"
    assert (result.offers_seen, result.counts.offers_created) == (0, 0)
    assert result.counts.price_points_written == 0
    assert shop.calls == ["/robots.txt"]
    written = [sql for sql, _ in conn.statements]
    assert not any(
        "INSERT INTO offer" in sql or "INSERT INTO price_point" in sql for sql in written
    )
    ((close_sql, params),) = [
        s for s in conn.statements if "checkpoint = coalesce(%s::jsonb, checkpoint)" in s[0]
    ]
    status, seen, created, updated, points, error_text, checkpoint, run_id = params
    assert '"resumable": false' in checkpoint
    assert (status, seen, created, updated, points, run_id) == ("failed", 0, 0, 0, 0, 99)
    assert error_text.startswith("refused:robots_disallowed: robots_disallowed (/products.json")
    assert conn.rollbacks == 1


def test_pipeline_gate_still_refuses_before_robots(monkeypatch: pytest.MonkeyPatch) -> None:
    """Veritabani kapisi (para birimi) zayiflamadi: robots bile sorulmaz."""
    shop = Shop()
    monkeypatch.setattr(ShopifyConnector, "_client", lambda self: shop.client())
    conn = _Conn({**CONFIG, "currency_verified": False})

    result = pipeline.run_ingest(conn, "magaza")  # type: ignore[arg-type]

    assert result.refusal == "currency_unverified"
    assert shop.calls == []


def test_refusal_is_not_an_uncaught_error(monkeypatch: pytest.MonkeyPatch) -> None:
    shop = Shop(robots=httpx.Response(503))
    monkeypatch.setattr(ShopifyConnector, "_client", lambda self: shop.client())

    result = pipeline.run_ingest(_Conn({**CONFIG}), "magaza")  # type: ignore[arg-type]

    assert result.refusal == "robots_unavailable"
    assert result.status == "failed"
    assert shop.calls == ["/robots.txt"]
