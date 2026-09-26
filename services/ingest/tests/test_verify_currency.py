"""Shopify para birimi dogrulamasi. Hicbir test aga cikmaz (httpx.MockTransport).

Birim testleri veritabanina dokunmaz; `integration` isaretliler yerel
veritabanindan SALT OKUNUR merchant satiri okur ve hicbir sey yazmadigini
kanitlar.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager

import httpx
import psycopg
import pytest

from collect.verify_currency import (
    CurrencyCheck,
    MerchantTarget,
    RateLimiter,
    UnknownMerchant,
    check_merchant,
    format_report,
    load_targets,
    main,
    verify,
)
from db.connection import database_url

Handler = Callable[[httpx.Request], httpx.Response]


def _client(handler: Handler, calls: list[str]) -> httpx.Client:
    def recording(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return handler(request)

    return httpx.Client(transport=httpx.MockTransport(recording), follow_redirects=False)


def _json(payload: object, status: int = 200) -> Handler:
    return lambda request: httpx.Response(status, json=payload)


def _raises(error: type[httpx.HTTPError]) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error("simule", request=request)

    return handler


class _FakeClock:
    """Uyumadan zamani ilerletir; oran sinirini gercek beklemeden olcer."""

    def __init__(self) -> None:
        self.now = 0.0
        self.slept: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def _limiter() -> RateLimiter:
    fake = _FakeClock()
    return RateLimiter(sleep=fake.sleep, clock=fake.clock)


TARGET = MerchantTarget(slug="riva-istanbul", domain="riva-istanbul.myshopify.com")


def _check(handler: Handler) -> tuple[CurrencyCheck, list[str]]:
    calls: list[str] = []
    result = check_merchant(_client(handler, calls), TARGET, _limiter())
    return result, calls


# --- tek merchant: her yol TEK istek ------------------------------------------


def test_try_passes_with_one_request_to_meta_json() -> None:
    result, calls = _check(_json({"name": "Riva", "currency": "TRY", "country": "TR"}))

    assert result.passed and result.result == "PASS"
    assert result.currency == "TRY"
    assert result.reason == "ok"
    assert calls == ["https://riva-istanbul.myshopify.com/meta.json"]
    assert result.requests == 1


@pytest.mark.parametrize(
    ("handler", "reason", "currency", "status"),
    [
        (_json({"currency": "EUR"}), "currency_not_try", "EUR", 200),
        # Tam esitlik: kucuk harf ya da bosluklu deger TRY sayilmaz.
        (_json({"currency": "try"}), "currency_not_try", "try", 200),
        (_json({"name": "Riva"}), "missing_currency", None, 200),
        (_json({"currency": ""}), "missing_currency", None, 200),
        (_json({"currency": 949}), "invalid_currency", None, 200),
        (lambda r: httpx.Response(200, text="<html>not json</html>"), "invalid_json", None, 200),
        (_json(["TRY"]), "invalid_json", None, 200),
        (_json({"errors": "Not Found"}, 404), "http_404", None, 404),
        (_json({}, 403), "http_403", None, 403),
        (_json({}, 429), "http_429", None, 429),
        (_json({}, 500), "http_500", None, 500),
        (_json({}, 503), "http_503", None, 503),
        (
            lambda r: httpx.Response(301, headers={"Location": "https://www.riva.example/"}),
            "http_301",
            None,
            301,
        ),
    ],
)
def test_failures_are_reported_after_exactly_one_request(
    handler: Handler, reason: str, currency: str | None, status: int
) -> None:
    result, calls = _check(handler)

    assert not result.passed and result.result == "FAIL"
    assert result.reason == reason
    assert result.currency == currency
    assert result.http_status == status
    # Yeniden deneme yok, yonlendirme izlenmez: 429/5xx/301 dahil tek istek.
    assert len(calls) == 1
    assert result.requests == 1


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (httpx.ReadTimeout, "timeout"),
        (httpx.ConnectTimeout, "timeout"),
        (httpx.ConnectError, "network_error"),
        (httpx.RemoteProtocolError, "network_error"),
    ],
)
def test_transport_errors_fail_without_retry(error: type[httpx.HTTPError], reason: str) -> None:
    result, calls = _check(_raises(error))

    assert not result.passed
    assert result.reason == reason
    assert result.currency is None
    assert len(calls) == 1


@pytest.mark.parametrize(
    "domain",
    [None, "", "https://riva.example", "riva.example/meta.json", "riva.example:443", "localhost"],
)
def test_invalid_domain_fails_without_any_request(domain: str | None) -> None:
    calls: list[str] = []
    result = check_merchant(
        _client(_json({"currency": "TRY"}), calls),
        MerchantTarget(slug="bozuk", domain=domain),
        _limiter(),
    )

    assert not result.passed
    assert result.reason == "invalid_domain"
    assert calls == []
    assert result.requests == 0


# --- toplu kosu -----------------------------------------------------------------


def test_one_failure_does_not_stop_the_report_and_order_is_by_slug() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if host.startswith("zaman"):
            raise httpx.ReadTimeout("simule", request=request)
        if host.startswith("euro"):
            return httpx.Response(200, json={"currency": "EUR"})
        return httpx.Response(200, json={"currency": "TRY"})

    calls: list[str] = []
    targets = [
        MerchantTarget("zaman-asimi", "zaman.myshopify.com"),
        MerchantTarget("euro-magaza", "euro.myshopify.com"),
        MerchantTarget("bozuk-alan", "bozuk alan"),
        MerchantTarget("a-try-magaza", "atry.myshopify.com"),
    ]

    results = verify(targets, _client(handler, calls), _limiter())

    assert [(r.slug, r.result, r.reason) for r in results] == [
        ("a-try-magaza", "PASS", "ok"),
        ("bozuk-alan", "FAIL", "invalid_domain"),
        ("euro-magaza", "FAIL", "currency_not_try"),
        ("zaman-asimi", "FAIL", "timeout"),
    ]
    # Gecerli alan adi basina tam bir istek; gecersiz olana hic.
    assert calls == [
        "https://atry.myshopify.com/meta.json",
        "https://euro.myshopify.com/meta.json",
        "https://zaman.myshopify.com/meta.json",
    ]


def test_rate_limit_spaces_requests_at_most_one_per_second() -> None:
    fake = _FakeClock()
    limiter = RateLimiter(sleep=fake.sleep, clock=fake.clock)
    request_times: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        request_times.append(fake.now)
        fake.now += 0.25  # yanit suresi
        return httpx.Response(200, json={"currency": "TRY"})

    targets = [MerchantTarget(f"m{i}", f"m{i}.myshopify.com") for i in range(4)]
    verify(targets, _client(handler, []), limiter)

    gaps = [b - a for a, b in zip(request_times, request_times[1:], strict=False)]
    assert gaps == [1.0, 1.0, 1.0]
    # Ilk istekten once beklenmez; sonrakilerde yanit suresi dusulur.
    assert fake.slept == [0.75, 0.75, 0.75]


def test_rate_limiter_refuses_more_than_two_per_second() -> None:
    with pytest.raises(ValueError):
        RateLimiter(requests_per_second=3)
    with pytest.raises(ValueError):
        RateLimiter(requests_per_second=0)


def test_report_is_deterministic_with_summary() -> None:
    results = [
        CurrencyCheck("a", "a.myshopify.com", "TRY", True, "ok", requests=1),
        CurrencyCheck("b", "b.myshopify.com", "EUR", False, "currency_not_try", "EUR != TRY"),
        CurrencyCheck("c", "c.myshopify.com", None, False, "timeout"),
    ]

    report = format_report(results)

    assert report == format_report(list(results))
    lines = report.splitlines()
    assert lines[1].split() == ["a", "TRY", "PASS", "ok"]
    assert lines[2].split()[:4] == ["b", "EUR", "FAIL", "currency_not_try"]
    assert lines[3].split() == ["c", "-", "FAIL", "timeout"]
    assert lines[-1] == "summary: total=3 pass=1 fail=2"


# --- merchant filtresi (sahte baglanti: veritabani yok) -------------------------


class _FakeCursor:
    def __init__(self, rows: list[tuple[str, str | None]]) -> None:
        self.rows = rows
        self.statements: list[str] = []

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def execute(self, sql: str, params: object = None) -> None:
        self.statements.append(sql)

    def fetchall(self) -> list[tuple[str, str | None]]:
        return self.rows


class _FakeConn:
    def __init__(self, rows: list[tuple[str, str | None]]) -> None:
        self.read_only = False
        self.cursor_obj = _FakeCursor(rows)

    def cursor(self) -> _FakeCursor:
        return self.cursor_obj

    def rollback(self) -> None:
        return None


_ROWS = [("assema", "assema4455.myshopify.com"), ("riva-istanbul", "riva-istanbul.myshopify.com")]


def test_load_targets_is_read_only_and_selects_only_shopify() -> None:
    conn = _FakeConn(_ROWS)

    targets = load_targets(conn)  # type: ignore[arg-type]

    assert conn.read_only is True
    assert [t.slug for t in targets] == ["assema", "riva-istanbul"]
    (sql,) = conn.cursor_obj.statements
    assert "source_type = 'shopify'" in sql
    assert sql.lstrip().upper().startswith("SELECT")


def test_merchant_filter_selects_only_requested() -> None:
    targets = load_targets(_FakeConn(_ROWS), ["riva-istanbul"])  # type: ignore[arg-type]

    assert targets == [MerchantTarget("riva-istanbul", "riva-istanbul.myshopify.com")]


def test_unknown_merchant_filter_is_an_error_not_an_empty_pass() -> None:
    with pytest.raises(UnknownMerchant, match="yok-boyle"):
        load_targets(_FakeConn(_ROWS), ["riva-istanbul", "yok-boyle"])  # type: ignore[arg-type]


# --- yerel veritabani: salt okunur oldugunun kaniti ----------------------------

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


@pytest.mark.integration
def test_cli_writes_nothing_to_the_database(capsys: pytest.CaptureFixture[str]) -> None:
    before = _snapshot()
    calls: list[str] = []

    code = main(["--merchant", "riva-istanbul"], client=_client(_json({"currency": "TRY"}), calls))

    assert code == 0
    assert calls == ["https://riva-istanbul.myshopify.com/meta.json"]
    assert "riva-istanbul" in capsys.readouterr().out
    # merchant satirlari (is_active, feed_config.currency_verified dahil) aynen.
    assert _snapshot() == before


@pytest.mark.integration
def test_cli_unknown_merchant_exits_2_without_requests() -> None:
    calls: list[str] = []

    code = main(["--merchant", "yok-boyle-bir-magaza"], client=_client(_json({}), calls))

    assert code == 2
    assert calls == []


@pytest.mark.integration
def test_verifier_connection_rejects_writes() -> None:
    try:
        conn = psycopg.connect(database_url("DATABASE_URL"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with conn:
        load_targets(conn)
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            conn.execute("UPDATE merchant SET name = name WHERE false")
        conn.rollback()
