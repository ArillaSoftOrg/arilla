"""Shopify aktivasyon hazirligi dogrulamasi. Hicbir test aga cikmaz
(httpx.MockTransport). `integration` isaretliler yerel veritabanindan SALT
OKUNUR okur ve hicbir sey yazmadigini kanitlar."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import httpx
import psycopg
import pytest

from collect.verify_currency import RateLimiter, UnknownMerchant
from collect.verify_readiness import (
    IneligibleMerchant,
    OptionConventions,
    Target,
    analyse_mapping,
    check_target,
    evaluate_robots,
    format_report,
    load_conventions,
    load_targets,
    main,
    report_json,
    verify,
)
from db.connection import database_url

# 0018'in feed_config bicimi (konumsal esleme) + 0021'in para birimi.
CONFIG_0018: dict[str, Any] = {
    "category_hint": "ev-yasam",
    "currency": "TRY",
    "currency_verified": True,
    "transport": {
        "pagination": {"size": 50},
        "rate_limit": {"requests_per_second": 1.5},
        "shopify": {"color_option": "option1"},
    },
    "mapping": {
        "external_id": "external_id",
        "url": "url",
        "title": "title",
        "brand": "vendor",
        "category": "product_type",
        "price": "price",
        "list_price": "compare_at_price",
        "image_url": "image_url",
        "variants": {
            "path": "variants",
            "size": "option2",
            "availability": "available",
            "external_id": "id",
            "price": "price",
            "sku": "sku",
        },
    },
    "value_formats": {"decimal_separator": ".", "thousands_separator": ","},
}

ALLOW_ALL = "User-agent: *\nDisallow: /cart\nDisallow: /checkout\n"
CONVENTIONS = load_conventions()


def _config(**overrides: Any) -> dict[str, Any]:
    config = json.loads(json.dumps(CONFIG_0018))
    config.update(overrides)
    return config


def _name_based_config() -> dict[str, Any]:
    """bootstrap'in ad tabanli eslemesi (0027)."""
    config = _config()
    config["transport"]["shopify"] = {
        "color_option_names": list(CONVENTIONS.colour),
        "size_option_names": list(CONVENTIONS.size),
    }
    config["mapping"]["variants"]["size"] = "size"
    return config


TARGET = Target("magaza", "magaza.myshopify.com", _config())


def _product(
    index: int,
    options: list[tuple[str, list[str]]] | None = None,
    *,
    price: str = "129.90",
    available: bool | None = True,
) -> dict[str, Any]:
    """Shopify /products.json urunu. Secenekler (ad, degerler) sirasiyla."""
    options = options or [("Title", ["Default Title"])]
    combos: list[list[str]] = [[]]
    for _, values in options:
        combos = [combo + [value] for combo in combos for value in values]
    variants = []
    for number, combo in enumerate(combos, start=1):
        variant: dict[str, Any] = {"id": index * 100 + number, "price": price, "sku": None}
        if available is not None:
            variant["available"] = available
        for position in range(1, 4):
            variant[f"option{position}"] = combo[position - 1] if position <= len(combo) else None
        variants.append(variant)
    return {
        "id": index,
        "handle": f"gizli-handle-{index}",
        "title": f"GIZLI-BASLIK-{index}",
        "body_html": "<p>GIZLI-ACIKLAMA</p>",
        "vendor": "Marka",
        "product_type": "Tur",
        "options": [
            {"name": name, "position": position, "values": values}
            for position, (name, values) in enumerate(options, start=1)
        ],
        "variants": variants,
        "images": [{"src": f"https://cdn.example/GIZLI-GORSEL-{index}.jpg"}],
    }


Responder = httpx.Response | Callable[[httpx.Request], httpx.Response]


class Shop:
    """Tek magaza: robots.txt ve /products.json yanitlari, istek kaydi."""

    def __init__(
        self,
        robots: Responder | None = None,
        products: Responder | list[dict[str, Any]] | None = None,
    ) -> None:
        self.robots = robots if robots is not None else _text(ALLOW_ALL)
        if products is None:
            products = [_product(i) for i in range(1, 6)]
        self.products = products
        self.calls: list[tuple[str, dict[str, str]]] = []

    def _respond(self, responder: Any, request: httpx.Request) -> httpx.Response:
        if callable(responder) and not isinstance(responder, httpx.Response):
            return responder(request)
        if isinstance(responder, list):
            return httpx.Response(200, json={"products": responder})
        return responder

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.url.path, dict(request.url.params)))
        if request.url.path == "/robots.txt":
            return self._respond(self.robots, request)
        if request.url.path == "/products.json":
            return self._respond(self.products, request)
        raise AssertionError(f"beklenmeyen istek: {request.url}")

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler), follow_redirects=False)

    @property
    def paths(self) -> list[str]:
        return [path for path, _ in self.calls]


def _text(body: str, status: int = 200, content_type: str = "text/plain; charset=utf-8"):
    return httpx.Response(status, text=body, headers={"Content-Type": content_type})


class _FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.slept: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def _limiter(fake: _FakeClock | None = None) -> RateLimiter:
    fake = fake or _FakeClock()
    return RateLimiter(sleep=fake.sleep, clock=fake.clock)


def _run(shop: Shop, target: Target = TARGET, fake: _FakeClock | None = None):
    return check_target(shop.client(), target, _limiter(fake), CONVENTIONS)


def _raises(error: type[httpx.HTTPError]) -> Callable[[httpx.Request], httpx.Response]:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error("simule", request=request)

    return handler


# --- aday secimi (sahte baglanti) ------------------------------------------------


class _FakeCursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows
        self.statements: list[str] = []

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def execute(self, sql: str, params: object = None) -> None:
        self.statements.append(sql)

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self.rows


class _FakeConn:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.read_only = False
        self.cursor_obj = _FakeCursor(rows)

    def cursor(self) -> _FakeCursor:
        return self.cursor_obj

    def rollback(self) -> None:
        return None


_ROWS = [
    ("dogrulanmis", "dogrulanmis.myshopify.com", _config()),
    ("dogrulanmamis", "dogrulanmamis.myshopify.com", _config(currency_verified=False)),
    ("peso", "peso.myshopify.com", _config(currency="PHP")),
    ("metin-bayrak", "metin.myshopify.com", _config(currency_verified="true")),
]


def test_only_verified_try_merchants_are_candidates() -> None:
    conn = _FakeConn(_ROWS)

    targets, excluded = load_targets(conn)  # type: ignore[arg-type]

    assert conn.read_only is True
    assert conn.cursor_obj.statements[0].lstrip().upper().startswith("SELECT")
    assert [t.slug for t in targets] == ["dogrulanmis"]
    assert excluded == [
        {"slug": "dogrulanmamis", "reason": "currency_unverified"},
        {"slug": "metin-bayrak", "reason": "currency_unverified"},
        {"slug": "peso", "reason": "currency_not_try"},
    ]


@pytest.mark.parametrize("slug", ["dogrulanmamis", "peso"])
def test_ineligible_merchant_filter_is_refused(slug: str) -> None:
    with pytest.raises(IneligibleMerchant, match=slug):
        load_targets(_FakeConn(_ROWS), [slug])  # type: ignore[arg-type]


def test_unknown_merchant_filter_is_refused() -> None:
    with pytest.raises(UnknownMerchant, match="yok-boyle"):
        load_targets(_FakeConn(_ROWS), ["yok-boyle"])  # type: ignore[arg-type]


def test_conventions_come_from_the_bootstrap_manifest() -> None:
    assert "Renk" in CONVENTIONS.colour and "Color" in CONVENTIONS.colour
    assert "Beden" in CONVENTIONS.size and "Size" in CONVENTIONS.size


# --- robots.txt -----------------------------------------------------------------------


def test_robots_allow_then_exactly_one_sample_request() -> None:
    shop = Shop()

    result = _run(shop)

    assert result.robots.status == "PASS"
    assert shop.calls == [("/robots.txt", {}), ("/products.json", {"limit": "5", "page": "1"})]
    assert result.robots.requests == 1 and result.product_sample.requests == 1
    assert result.requests == 2


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        ("User-agent: *\nDisallow: /products\n", "robots_disallowed"),
        ("User-agent: *\nDisallow: /products.json\n", "robots_disallowed"),
        ("User-agent: *\nDisallow: /\n", "robots_disallowed"),
        ("User-agent: ArillaBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n", "robots_disallowed"),
        # Standart kutuphane bunu izin sanar; joker korumasi yakalar.
        ("User-agent: *\nDisallow: /*.json\n", "robots_wildcard_disallow"),
        ("User-agent: *\nDisallow: /*products*\n", "robots_wildcard_disallow"),
    ],
)
def test_robots_disallow_skips_the_product_request(body: str, reason: str) -> None:
    shop = Shop(robots=_text(body))

    result = _run(shop)

    assert result.robots.status == "FAIL"
    assert result.robots.reason.startswith(reason)
    assert result.product_sample.status == "SKIPPED"
    assert result.overall == "NOT_READY"
    assert shop.paths == ["/robots.txt"]


def test_rules_for_other_bots_do_not_block_us() -> None:
    body = "User-agent: AhrefsBot\nDisallow: /\n\nUser-agent: *\nDisallow: /cart\n"

    refusal, delay = evaluate_robots(body)

    assert refusal is None and delay is None


def test_wildcard_that_does_not_match_products_is_fine() -> None:
    refusal, _ = evaluate_robots("User-agent: *\nDisallow: /collections/*sort_by*\n")

    assert refusal is None


def test_robots_404_means_no_rules_per_repo_convention() -> None:
    shop = Shop(robots=httpx.Response(404))

    result = _run(shop)

    assert result.robots.status == "PASS"
    assert shop.paths == ["/robots.txt", "/products.json"]


@pytest.mark.parametrize(
    ("response", "reason"),
    [
        (
            httpx.Response(301, headers={"Location": "https://www.magaza.example/robots.txt"}),
            "http_301",
        ),
        (
            httpx.Response(302, headers={"Location": "https://magaza.example/robots.txt"}),
            "http_302",
        ),
        (httpx.Response(401), "http_401"),
        (httpx.Response(403), "http_403"),
        (httpx.Response(500), "http_500"),
        (httpx.Response(503), "http_503"),
        (_text("<html>challenge</html>", content_type="text/html"), "robots_unusable"),
    ],
)
def test_robots_http_failures_block_without_follow(response: httpx.Response, reason: str) -> None:
    shop = Shop(robots=response)

    result = _run(shop)

    assert result.robots.status == "FAIL"
    assert result.robots.reason.startswith(reason)
    assert shop.paths == ["/robots.txt"]


@pytest.mark.parametrize(
    ("error", "reason"),
    [(httpx.ReadTimeout, "timeout"), (httpx.ConnectError, "network_error")],
)
def test_robots_transport_errors_fail_without_retry(
    error: type[httpx.HTTPError], reason: str
) -> None:
    shop = Shop(robots=_raises(error))

    result = _run(shop)

    assert result.robots.reason.startswith(reason)
    assert shop.paths == ["/robots.txt"]


def test_invalid_domain_makes_no_request() -> None:
    shop = Shop()

    result = _run(shop, Target("bozuk", "https://bozuk.example", _config()))

    assert result.robots.reason.startswith("invalid_domain")
    assert shop.calls == []
    assert result.requests == 0


def test_crawl_delay_is_honoured_before_the_sample_request() -> None:
    fake = _FakeClock()
    shop = Shop(robots=_text("User-agent: *\nCrawl-delay: 5\n"))

    result = _run(shop, fake=fake)

    assert result.robots.crawl_delay == 5.0
    assert fake.slept == [5.0]


def test_excessive_crawl_delay_skips_sample_for_review() -> None:
    shop = Shop(robots=_text("User-agent: *\nCrawl-delay: 120\n"))

    result = _run(shop)

    assert result.product_sample.status == "SKIPPED"
    assert result.overall == "REVIEW"
    assert shop.paths == ["/robots.txt"]


# --- urun ornegi --------------------------------------------------------------------


def test_valid_sample_is_consumed_by_the_real_pipeline_offline() -> None:
    shop = Shop(
        products=[
            _product(i, [("Renk", ["Mavi", "Siyah"]), ("Beden", ["S", "M"])]) for i in range(1, 6)
        ]
    )

    result = _run(shop)

    sample = result.product_sample
    assert sample.status == "PASS"
    assert sample.product_count == 5
    assert sample.variant_count == 20
    # Renk bolmesi: 5 urun x 2 renk = 10 kayit, hepsi normalize edildi.
    assert (sample.records_normalized, sample.records_rejected) == (10, 0)
    assert result.prices.status == "PASS"
    assert result.overall == "READY"


def test_only_first_five_products_are_examined_even_if_server_sends_more() -> None:
    shop = Shop(products=[_product(i) for i in range(1, 9)])

    result = _run(shop)

    assert result.product_sample.product_count == 5
    assert [params for path, params in shop.calls if path == "/products.json"] == [
        {"limit": "5", "page": "1"}
    ]


@pytest.mark.parametrize(
    ("products", "reason"),
    [
        ([], "empty_products"),
        (httpx.Response(200, text="<html></html>"), "invalid_json"),
        (httpx.Response(200, json=[{"id": 1}]), "missing_products"),
        (httpx.Response(200, json={"items": []}), "missing_products"),
        (httpx.Response(404), "http_404"),
        (httpx.Response(429), "http_429"),
        (httpx.Response(500), "http_500"),
        (httpx.Response(301, headers={"Location": "https://x.example/products.json"}), "http_301"),
        (_raises(httpx.ReadTimeout), "timeout"),
        (_raises(httpx.ConnectError), "network_error"),
    ],
)
def test_sample_failures(products: Any, reason: str) -> None:
    shop = Shop(products=products)

    result = _run(shop)

    assert result.product_sample.status == "FAIL"
    assert result.product_sample.reason.startswith(reason)
    assert result.overall == "NOT_READY"
    # Tek urun istegi, ikinci sayfa ya da tekrar yok.
    assert shop.paths == ["/robots.txt", "/products.json"]


@pytest.mark.parametrize(
    ("product", "reason"),
    [
        ({**_product(1), "variants": []}, "malformed_variants"),
        ({**_product(1), "variants": "yok"}, "malformed_variants"),
        ({**_product(1), "variants": [{"id": 1, "available": True}]}, "malformed_variants"),
        (_product(1, available=None), "missing_availability"),
        ({"handle": "kimliksiz", "variants": []}, "malformed_product"),
    ],
)
def test_malformed_variants_fail_the_sample(product: dict[str, Any], reason: str) -> None:
    result = _run(Shop(products=[product]))

    assert result.product_sample.status == "FAIL"
    assert result.product_sample.reason.startswith(reason)
    assert result.prices.status == "SKIPPED"


@pytest.mark.parametrize("price", ["0.00", "abc", ""])
def test_zero_or_invalid_price_fails_prices(price: str) -> None:
    result = _run(Shop(products=[_product(1, price=price), _product(2)]))

    assert result.prices.status == "FAIL"
    assert result.prices.invalid == 1
    assert result.overall == "NOT_READY"


# --- secenek eslemesi -----------------------------------------------------------------

COLOUR_THEN_SIZE = [("Renk", ["Lacivert", "Beyaz"]), ("Beden", ["S", "M", "L"])]
# casadora-baby (0027): option1 beden.
CASADORA = [("Beden", ["0-3 Ay", "3-6 Ay"]), ("Renk", ["Pembe", "Mavi"])]
# for-fun (0027): option2 renk.
FOR_FUN = [("Size", ["S", "M"]), ("Renk", ["Siyah", "Kirmizi"])]


def _mapping(options: list[tuple[str, list[str]]], config: dict[str, Any] | None = None):
    return analyse_mapping(
        [_product(1, options), _product(2, options)], config or _config(), CONVENTIONS
    )


def test_colour_then_size_matches_positional_config() -> None:
    mapping = _mapping(COLOUR_THEN_SIZE)

    assert mapping.status == "PASS"
    assert [(o.name, o.role, o.positions) for o in mapping.observed_options] == [
        ("Renk", "colour", [1]),
        ("Beden", "size", [2]),
    ]
    assert mapping.recommended is not None


@pytest.mark.parametrize("shape", [CASADORA, FOR_FUN], ids=["casadora-baby", "for-fun"])
def test_size_first_shapes_prove_positional_config_wrong(shape: Any) -> None:
    mapping = _mapping(shape)

    assert mapping.status == "FAIL"
    assert any("beden secenegini kullaniyor" in issue for issue in mapping.issues)
    assert any("renk secenegini okuyor" in issue for issue in mapping.issues)
    assert mapping.recommended == {
        "transport.shopify.color_option_names": list(CONVENTIONS.colour),
        "transport.shopify.size_option_names": list(CONVENTIONS.size),
        "mapping.variants.size": "size",
    }


@pytest.mark.parametrize("shape", [CASADORA, FOR_FUN], ids=["casadora-baby", "for-fun"])
def test_name_based_config_is_correct_for_size_first_shapes(shape: Any) -> None:
    assert _mapping(shape, _name_based_config()).status == "PASS"


def test_casadora_shape_end_to_end_is_not_ready() -> None:
    target = Target("casadora-baby", "casadora-baby.myshopify.com", _config())
    shop = Shop(products=[_product(i, CASADORA) for i in range(1, 6)])

    result = _run(shop, target)

    assert result.mapping.status == "FAIL"
    assert result.overall == "NOT_READY"
    assert "ad tabanli" in result.overall_reason


def test_size_only_products_would_be_split_by_size() -> None:
    mapping = _mapping([("Beden", ["S", "M", "L"])])

    assert mapping.status == "FAIL"


def test_colour_only_products_pass() -> None:
    assert _mapping([("Renk", ["Mavi", "Siyah"])]).status == "PASS"


def test_unknown_option_names_are_unknown_not_guessed() -> None:
    mapping = _mapping([("Ayak", ["Ahsap", "Metal"])])

    assert mapping.status == "UNKNOWN"
    assert "Ayak" in mapping.reason
    assert mapping.recommended is None


def test_title_only_sample_is_insufficient_evidence() -> None:
    target = Target("tek-varyant", "tek.myshopify.com", _config())

    result = _run(Shop(), target)

    assert result.mapping.status == "UNKNOWN"
    assert result.overall == "REVIEW"


# --- toplu kosu ve rapor ------------------------------------------------------------


def test_request_counts_across_merchants() -> None:
    shops = {
        "a-izinli": Shop(),
        "b-yasakli": Shop(robots=_text("User-agent: *\nDisallow: /products\n")),
        "c-403": Shop(robots=httpx.Response(403)),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return shops[request.url.host.split(".")[0]].handler(request)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    targets = [Target(slug, f"{slug}.myshopify.com", _config()) for slug in reversed(list(shops))]

    results = verify(targets, client, _limiter(), CONVENTIONS)

    assert [r.slug for r in results] == ["a-izinli", "b-yasakli", "c-403"]
    assert [r.requests for r in results] == [2, 1, 1]
    for shop in shops.values():
        assert shop.paths.count("/robots.txt") == 1
        assert all(
            params.get("page") == "1" for path, params in shop.calls if path == "/products.json"
        )


def test_rate_limit_spaces_every_request_by_one_second() -> None:
    fake = _FakeClock()
    times: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        times.append(fake.now)
        return Shop().handler(request)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    targets = [Target(f"m{i}", f"m{i}.myshopify.com", _config()) for i in range(2)]

    verify(targets, client, _limiter(fake), CONVENTIONS)

    assert [b - a for a, b in zip(times, times[1:], strict=False)] == [1.0, 1.0, 1.0]


def test_report_has_no_payload_or_secrets_and_is_deterministic() -> None:
    shop = Shop(products=[_product(i, CASADORA) for i in range(1, 6)])
    results = [_run(shop, Target("casadora-baby", "casadora-baby.myshopify.com", _config()))]

    report = report_json(results, [{"slug": "turkish-finds", "reason": "currency_unverified"}])
    dumped = json.dumps(report, ensure_ascii=False)

    assert list(report) == [
        "checked_at",
        "endpoints",
        "user_agent_token",
        "requests_per_second",
        "timeout_seconds",
        "sample_size",
        "summary",
        "excluded",
        "results",
    ]
    assert report["user_agent_token"] == "ArillaBot/1.0"
    assert report["summary"] == {"total": 1, "ready": 0, "not_ready": 1, "review": 0, "requests": 2}
    for forbidden in ("GIZLI", "feed_config", "password", "postgres", "DATABASE_URL", "cookie"):
        assert forbidden not in dumped
    result = report["results"][0]
    assert list(result) == [
        "slug",
        "domain",
        "robots",
        "product_sample",
        "prices",
        "mapping",
        "overall",
        "overall_reason",
        "requests",
    ]
    assert format_report(results) == format_report(list(results))
    assert format_report(results).splitlines()[-1].startswith("summary: total=1 ready=0")


# --- yerel veritabani: salt okunur oldugunun kaniti -------------------------------------

_SNAPSHOT = """
SELECT (SELECT md5(string_agg(m::text, ',' ORDER BY m.id)) FROM merchant m),
       (SELECT count(*) FROM ingest_run),
       (SELECT count(*) FROM offer),
       (SELECT count(*) FROM price_point)
"""


@contextmanager
def _owner() -> Iterator[psycopg.Connection]:
    try:
        conn = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with conn:
        yield conn


def _snapshot() -> tuple[object, ...]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(_SNAPSHOT)
        row = cur.fetchone()
        assert row is not None
        return tuple(row)


def _eligible_slug() -> str:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT slug FROM merchant WHERE source_type = 'shopify'
                 AND feed_config->'currency_verified' = 'true'::jsonb
                 AND feed_config->>'currency' = 'TRY' ORDER BY slug LIMIT 1"""
        )
        row = cur.fetchone()
    if row is None:
        pytest.skip("para birimi dogrulanmis Shopify merchant'i yok (0021 uygulanmamis)")
    return str(row[0])


@pytest.mark.integration
def test_cli_writes_nothing_to_the_database(capsys: pytest.CaptureFixture[str]) -> None:
    slug = _eligible_slug()
    before = _snapshot()
    shop = Shop()

    code = main(["--merchant", slug], client=shop.client())

    assert code in {0, 1}
    assert shop.paths == ["/robots.txt", "/products.json"]
    assert slug in capsys.readouterr().out
    assert _snapshot() == before


@pytest.mark.integration
@pytest.mark.parametrize("slug", ["turkish-finds", "yok-boyle-bir-magaza"])
def test_cli_refuses_ineligible_or_unknown_without_requests(slug: str) -> None:
    shop = Shop()

    code = main(["--merchant", slug], client=shop.client())

    assert code == 2
    assert shop.calls == []


@pytest.mark.integration
def test_readiness_connection_rejects_writes() -> None:
    try:
        conn = psycopg.connect(database_url("DATABASE_URL"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with conn:
        load_targets(conn)
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            conn.execute("UPDATE merchant SET is_active = is_active WHERE false")
        conn.rollback()


def test_conventions_type() -> None:
    assert isinstance(CONVENTIONS, OptionConventions)
