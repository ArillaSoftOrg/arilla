"""Affiliate donusumleri (karar 0128). Gercek aga cikilmaz."""

from __future__ import annotations

import base64
import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime
from decimal import Decimal

import httpx
import psycopg
import pytest

from affiliate.admitad_actions import Action, AdmitadActions, parse_action
from affiliate.conversions import conversion_status, store_actions, to_kurus
from db.connection import database_url
from feeds.admitad import AdmitadNetwork


def raw(**overrides: object) -> dict:
    base = {
        "action_id": 555,
        "advcampaign_id": 6115,
        "status": "pending",
        "cart": "12.50",
        "payment": "0.75",
        "currency": "USD",
        "action_date": "2026-10-10 08:30:00",
        "subid": None,
        "paid": 0,
    }
    base.update(overrides)
    return base


# --------------------------------------------------------------------------
# Ayristirma ve kurallar
# --------------------------------------------------------------------------


def test_eylem_ayristirma() -> None:
    action = parse_action(raw(subid="ABC"))
    assert action == Action(
        action_id="555",
        program_id="6115",
        status="pending",
        order_value=Decimal("12.50"),
        commission=Decimal("0.75"),
        currency="USD",
        occurred_at=datetime(2026, 10, 10, 8, 30, tzinfo=UTC),
        subid="ABC",
        paid=False,
    )


@pytest.mark.parametrize(
    "bad",
    [
        raw(action_id=None),
        raw(advcampaign_id=""),
        raw(cart="abc"),
        raw(cart="-1"),
        raw(cart=True),
        raw(currency="US"),
        raw(action_date="dun"),
        "liste degil",
    ],
)
def test_bozuk_eylem_uydurulmaz(bad: object) -> None:
    assert parse_action(bad) is None


def test_durum_esleme() -> None:
    def status(**kw: object) -> str | None:
        action = parse_action(raw(**kw))
        assert action
        return conversion_status(action)

    assert status(status="pending") == "pending"
    assert status(status="approved") == "confirmed"
    assert status(status="approved_but_stalled") == "confirmed"
    assert status(status="approved", paid=1) == "paid"
    assert status(status="declined") == "cancelled"
    assert status(status="declined", paid=1) == "cancelled"
    assert status(status="baska") is None


def test_kurus_yuvarlama_tamsayi() -> None:
    assert to_kurus(Decimal("12.345")) == 1235
    assert to_kurus(Decimal("12.50"), Decimal("49.3041")) == 61630
    assert isinstance(to_kurus(Decimal("1")), int)


# --------------------------------------------------------------------------
# Admitad istemcisi (sahte tasima)
# --------------------------------------------------------------------------


class Api:
    def __init__(self, actions: list[dict]) -> None:
        self.actions = actions
        self.scopes: list[str] = []
        self.params: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token/":
            expected = base64.b64encode(b"cid:csecret").decode()
            assert request.headers["authorization"] == f"Basic {expected}"
            self.scopes.append(dict(httpx.QueryParams(request.content.decode()))["scope"])
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 604800})
        assert request.headers["authorization"] == "Bearer tok"
        assert request.url.path == "/statistics/actions/"
        params = dict(request.url.params)
        self.params.append(params)
        offset, limit = int(params["offset"]), int(params["limit"])
        return httpx.Response(
            200,
            json={
                "_meta": {"count": len(self.actions), "limit": limit, "offset": offset},
                "results": self.actions[offset : offset + limit],
            },
        )


def test_istemci_sayfalar_ve_statistics_kapsami_ister() -> None:
    api = Api([raw(action_id=i) for i in range(1, 1201)] + [{"bozuk": True}])
    network = AdmitadNetwork(
        "cid",
        "csecret",
        client=httpx.Client(transport=httpx.MockTransport(api)),
        sleep=lambda _s: None,
        scope="statistics",
    )
    pairs = list(AdmitadActions(network).actions(date(2026, 7, 1), date(2026, 10, 1)))
    assert len(pairs) == 1201
    assert sum(1 for action, _ in pairs if action is None) == 1
    assert api.scopes == ["statistics"]
    assert [p["offset"] for p in api.params] == ["0", "500", "1000"]
    assert api.params[0]["date_start"] == "01.07.2026"
    assert api.params[0]["date_end"] == "01.10.2026"


# --------------------------------------------------------------------------
# Veritabani (yerel PostgreSQL)
# --------------------------------------------------------------------------

DOMAIN = "t0128.example.test"


@pytest.fixture
def db() -> Iterator[tuple[psycopg.Connection, psycopg.Connection, dict]]:
    try:
        owner = psycopg.connect(database_url("DATABASE_URL_OWNER"), autocommit=True)
        app = psycopg.connect(database_url("DATABASE_URL"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    merchants = "SELECT id FROM merchant WHERE domain LIKE %s"

    def cleanup() -> None:
        like = (f"%{DOMAIN}",)
        owner.execute(f"DELETE FROM conversion WHERE merchant_id IN ({merchants})", like)
        owner.execute(
            "DELETE FROM click WHERE offer_id IN (SELECT o.id FROM offer o"
            f" WHERE o.merchant_id IN ({merchants}))",
            like,
        )
        owner.execute(f"DELETE FROM offer WHERE merchant_id IN ({merchants})", like)
        owner.execute("DELETE FROM feed_source WHERE external_id LIKE 't0128:%'")
        owner.execute(f"DELETE FROM merchant WHERE id IN ({merchants})", like)
        owner.execute("DELETE FROM fx_rate WHERE bulletin = 'test0128'")

    cleanup()
    ids: dict = {}
    for slug in ("t0128-ali", "t0128-other", "t0128-dup-a", "t0128-dup-b"):
        row = owner.execute(
            """INSERT INTO merchant (slug, name, domain, source_type)
               VALUES (%s, %s, %s, 'affiliate_network') RETURNING id""",
            (slug, slug, f"{slug}.{DOMAIN}"),
        ).fetchone()
        assert row
        ids[slug] = int(row[0])
    for program, slug in (
        ("6115", "t0128-ali"),
        ("777", "t0128-other"),
        ("900", "t0128-dup-a"),
        ("900", "t0128-dup-b"),
    ):
        owner.execute(
            """INSERT INTO feed_source (network, external_id, merchant_id, program_external_id)
               VALUES ('admitad', %s, %s, %s)""",
            (f"t0128:{program}:{slug}", ids[slug], program),
        )
    offers = {}
    for slug in ("t0128-ali", "t0128-other"):
        row = owner.execute(
            """INSERT INTO offer (merchant_id, external_id, url, title_raw, currency)
               VALUES (%s, '1', %s, 't', 'USD') RETURNING id""",
            (ids[slug], f"https://{slug}.{DOMAIN}/p/1"),
        ).fetchone()
        assert row
        offers[slug] = int(row[0])
    ids["click_ali"] = str(uuid.uuid4())
    ids["click_other"] = str(uuid.uuid4())
    for click, slug in ((ids["click_ali"], "t0128-ali"), (ids["click_other"], "t0128-other")):
        owner.execute(
            "INSERT INTO click (id, session_id, offer_id, channel)"
            " VALUES (%s, 'test0128', %s, 'web')",
            (click, offers[slug]),
        )
    owner.execute(
        """INSERT INTO fx_rate (source, base, quote, rate, rate_kind, effective_date, bulletin)
           VALUES ('tcmb', 'USD', 'TRY', 40.00, 'forex_buying', '2026-10-09', 'test0128')"""
    )
    try:
        yield owner, app, ids
    finally:
        app.rollback()
        app.close()
        cleanup()
        owner.close()


def conversions(owner: psycopg.Connection, merchant_id: int) -> list[tuple]:
    return owner.execute(
        """SELECT external_order_id, order_value, commission, status, click_id::text
             FROM conversion WHERE merchant_id = %s ORDER BY external_order_id""",
        (merchant_id,),
    ).fetchall()


@pytest.mark.integration
def test_donusum_yazimi_idempotent_ve_durum_guncellenir(db) -> None:  # type: ignore[no-untyped-def]
    owner, app, ids = db
    batch = [
        parse_action(raw(action_id=1, subid=ids["click_ali"])),
        # Baska merchant'in tiklamasi: attribution baglanmaz.
        parse_action(raw(action_id=2, subid=ids["click_other"])),
        parse_action(raw(action_id=3, currency="TRY", cart="100", payment=None)),
        parse_action(raw(action_id=4, advcampaign_id=999)),  # bilinmeyen program
        parse_action(raw(action_id=5, advcampaign_id=900)),  # iki merchant'a bagli
        parse_action(raw(action_id=6, action_date="2026-09-01 00:00:00")),  # kur yok
        parse_action(raw(action_id=7, status="baska")),
        None,
    ]
    first = store_actions(app, batch)
    app.commit()
    assert first.detail() == {
        "fetched": 8,
        "inserted": 3,
        "updated": 0,
        "unchanged": 0,
        "click_linked": 1,
        "skipped_ambiguous_program": 1,
        "skipped_fx_missing": 1,
        "skipped_unknown_program": 1,
        "skipped_unknown_status": 1,
        "skipped_unparsed": 1,
    }
    assert conversions(owner, ids["t0128-ali"]) == [
        ("admitad:1", 50000, 3000, "pending", ids["click_ali"]),
        ("admitad:2", 50000, 3000, "pending", None),
        ("admitad:3", 10000, None, "pending", None),
    ]

    again = store_actions(app, batch)
    app.commit()
    assert (again.inserted, again.updated, again.unchanged) == (0, 0, 3)

    approved = store_actions(app, [parse_action(raw(action_id=1, status="approved", paid=1))])
    app.commit()
    assert (approved.inserted, approved.updated) == (0, 1)
    row = conversions(owner, ids["t0128-ali"])[0]
    # Durum guncellenir; onceki attribution korunur (subid sonraki yanitta yoksa bile).
    assert row == ("admitad:1", 50000, 3000, "paid", ids["click_ali"])
    reconciled = owner.execute(
        "SELECT reconciled_at IS NOT NULL FROM conversion WHERE external_order_id = 'admitad:1'"
    ).fetchone()
    assert reconciled == (True,)
