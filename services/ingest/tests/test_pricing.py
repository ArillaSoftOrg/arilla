"""Kur ve bagimsiz fiyat dogrulama (karar 0113). Gercek aga cikilmaz."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import date, timedelta
from decimal import Decimal

import httpx
import psycopg
import pytest

from collect.link.robots import RobotsCache
from db.connection import database_url
from pricing.fx import FxUnavailable, parse_tcmb, store
from pricing.providers import OfferContext, Outcome, ProviderStop, ShopifyProductJs
from pricing.worker import enqueue_stale, process

TCMB_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<Tarih_Date Tarih="14.10.2026" Date="10/14/2026" Bulten_No="2026/194">
  <Currency CrossOrder="0" Kod="USD" CurrencyCode="USD">
    <Unit>1</Unit><ForexBuying>49.3041</ForexBuying><ForexSelling>49.3929</ForexSelling>
  </Currency>
  <Currency CrossOrder="9" Kod="JPY" CurrencyCode="JPY">
    <Unit>100</Unit><ForexBuying>32.0100</ForexBuying><ForexSelling>32.2200</ForexSelling>
  </Currency>
  <Currency CrossOrder="10" Kod="XDR" CurrencyCode="XDR">
    <Unit>1</Unit><ForexBuying>66.0</ForexBuying><ForexSelling></ForexSelling>
  </Currency>
  <Currency CrossOrder="11" Kod="ABC" CurrencyCode="ABC">
    <Unit>1</Unit><ForexBuying></ForexBuying><ForexSelling>0</ForexSelling>
  </Currency>
</Tarih_Date>"""


def test_tcmb_ayristirma_birim_ve_bos_degerler() -> None:
    rates = {(r.base, r.kind): r for r in parse_tcmb(TCMB_XML)}
    usd = rates[("USD", "forex_selling")]
    assert (usd.rate, usd.effective_date, usd.bulletin) == (
        Decimal("49.39290000"),
        date(2026, 10, 14),
        "2026/194",
    )
    assert rates[("JPY", "forex_selling")].rate == Decimal("0.32220000")  # Unit 100
    assert not any(base in ("XDR", "ABC") for base, _ in rates)  # bos/sifir kur uydurulmaz


@pytest.mark.parametrize(
    "xml", [b"<bozuk", b'<Tarih_Date Tarih="x"/>', b'<Tarih_Date Tarih="14.10.2026"/>']
)
def test_tcmb_gecersiz_icerik(xml: bytes) -> None:
    with pytest.raises(FxUnavailable):
        parse_tcmb(xml)


# --------------------------------------------------------------------------
# Shopify vitrin saglayicisi
# --------------------------------------------------------------------------


def shopify(product: dict | None, *, status: int = 200, robots: str = "User-agent: *\nAllow: /\n"):
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text=robots)
        return (
            httpx.Response(status, json=product) if product is not None else httpx.Response(status)
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    provider = ShopifyProductJs(
        client=client, robots=RobotsCache(client=client), sleep=lambda _s: None
    )
    return provider, calls


def ctx(**kw: object) -> OfferContext:
    base: dict[str, object] = {
        "offer_id": 1,
        "merchant_id": 1,
        "merchant_slug": "m",
        "source_type": "shopify",
        "url": "https://shop.test/products/elbise",
        "currency": "TRY",
        "feed_price_minor": 129_990,
        "feed_list_price_minor": None,
        "currency_verified": True,
        "variant_external_ids": ("11", "12"),
    }
    base.update(kw)
    return OfferContext(**base)  # type: ignore[arg-type]


PRODUCT = {
    "variants": [
        {"id": 11, "price": 129_990, "compare_at_price": 159_990, "available": True},
        {"id": 12, "price": 139_990, "available": False},
        # Baska renk grubu: daha ucuz ama BU offer'in varyanti degil.
        {"id": 99, "price": 99_990, "available": True},
    ]
}


def test_shopify_yalnizca_offer_varyantlari_ile_karsilastirir() -> None:
    provider, calls = shopify(PRODUCT)
    outcome = provider.verify(ctx())
    assert outcome == Outcome(
        "match",
        currency="TRY",
        observed_price_minor=129_990,
        list_price_minor=159_990,
        in_stock=True,
    )
    assert "/products/elbise.js" in calls
    assert provider.verify(ctx(feed_price_minor=119_990)).result == "mismatch"


def test_shopify_desteklemedigi_durumlar() -> None:
    provider, _ = shopify(PRODUCT)
    assert not provider.supports(ctx(currency_verified=False))  # para birimi dogrulanmamis
    assert not provider.supports(ctx(source_type="affiliate_network"))  # AliExpress
    assert not provider.supports(ctx(url="https://shop.test/collections/x"))
    assert provider.supports(ctx())


def test_shopify_erisim_reddi_ve_robots_durdurur() -> None:
    provider, calls = shopify(None, status=429)
    with pytest.raises(ProviderStop):
        provider.verify(ctx())
    with pytest.raises(ProviderStop):
        provider.verify(ctx())  # ayni hosta ikinci istek gonderilmez
    assert calls.count("/products/elbise.js") == 1

    blocked, calls = shopify(PRODUCT, robots="User-agent: *\nDisallow: /products/\n")
    with pytest.raises(ProviderStop):
        blocked.verify(ctx())
    assert "/products/elbise.js" not in calls


def test_shopify_bulunamayan_ve_varyanti_kalmayan() -> None:
    provider, _ = shopify(None, status=404)
    assert provider.verify(ctx()).result == "unavailable"
    provider, _ = shopify({"variants": [{"id": 5, "price": 10, "available": True}]})
    out = provider.verify(ctx())
    assert (out.result, out.error_code) == ("unavailable", "variant_missing")


# --------------------------------------------------------------------------
# Kuyruk (veritabani)
# --------------------------------------------------------------------------

DOMAIN = "t0113.test.invalid"


@pytest.fixture
def db() -> Iterator[tuple[psycopg.Connection, psycopg.Connection, dict[str, int]]]:
    try:
        owner = psycopg.connect(database_url("DATABASE_URL_OWNER"), autocommit=True)
        app = psycopg.connect(database_url("DATABASE_URL"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    def cleanup() -> None:
        offers = (
            "SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id"
            " WHERE m.domain LIKE %s"
        )
        owner.execute(
            f"DELETE FROM price_verification_request WHERE offer_id IN ({offers})", (f"%{DOMAIN}",)
        )
        owner.execute(
            f"DELETE FROM price_verification WHERE offer_id IN ({offers})", (f"%{DOMAIN}",)
        )
        owner.execute(f"DELETE FROM offer WHERE id IN ({offers})", (f"%{DOMAIN}",))
        owner.execute("DELETE FROM merchant WHERE domain LIKE %s", (f"%{DOMAIN}",))
        owner.execute("DELETE FROM fx_rate WHERE bulletin = 'test0113'")

    cleanup()
    ids: dict[str, int] = {}
    for slug, source, verified in (
        ("t0113-shop", "shopify", True),
        ("t0113-ali", "affiliate_network", False),
    ):
        row = owner.execute(
            """INSERT INTO merchant (slug, name, domain, source_type, feed_config)
               VALUES (%s, %s, %s, %s, %s::jsonb) RETURNING id""",
            (
                slug,
                slug,
                f"{slug}.{DOMAIN}",
                source,
                json.dumps({"currency_verified": verified}),
            ),
        ).fetchone()
        assert row
        url = (
            f"https://{slug}.{DOMAIN}/products/x"
            if source == "shopify"
            else "https://www.aliexpress.com/item/1.html"
        )
        offer = owner.execute(
            """INSERT INTO offer (merchant_id, external_id, url, title_raw, current_price, currency)
               VALUES (%s, '1', %s, 't', 1000, %s) RETURNING id""",
            (row[0], url, "TRY" if source == "shopify" else "USD"),
        ).fetchone()
        assert offer
        ids[slug] = int(offer[0])
    try:
        yield owner, app, ids
    finally:
        app.rollback()
        app.close()
        cleanup()
        owner.close()


class FakeProvider:
    name = "test_provider"
    source_kind = "merchant_storefront"
    reliability = 80

    def __init__(self, outcome: Outcome) -> None:
        self.outcome = outcome
        self.calls = 0

    def supports(self, offer: OfferContext) -> bool:
        return offer.source_type == "shopify"

    def verify(self, offer: OfferContext) -> Outcome:
        self.calls += 1
        return self.outcome


@pytest.mark.integration
def test_kuyruk_dogrulama_ayri_saklanir_kaynaksiz_sahte_sonuc_yok(db) -> None:  # type: ignore[no-untyped-def]
    owner, app, ids = db
    added = enqueue_stale(app, merchant=None, limit=10_000, older_than=timedelta(hours=1))
    app.commit()
    assert added >= 2
    # Offer basina tek acik istek.
    assert enqueue_stale(app, merchant="t0113-shop", limit=10, older_than=timedelta(hours=1)) == 0
    app.commit()
    provider = FakeProvider(
        Outcome("mismatch", currency="TRY", observed_price_minor=900, in_stock=True)
    )
    report = process(app, [provider], limit=10_000)
    assert report.mismatch >= 1 and report.unsupported >= 1
    rows = owner.execute(
        """SELECT offer_id, result, observed_price_minor, feed_price_minor, provider,
                  source_reliability
             FROM price_verification WHERE offer_id = ANY(%s)""",
        ([ids["t0113-shop"], ids["t0113-ali"]],),
    ).fetchall()
    assert rows == [(ids["t0113-shop"], "mismatch", 900, 1000, "test_provider", 80)]
    # Offer fiyati DEGISMEZ; AliExpress icin sonuc yazilmadi, istek 'unsupported'.
    assert owner.execute(
        "SELECT current_price FROM offer WHERE id = %s", (ids["t0113-shop"],)
    ).fetchone() == (1000,)
    status = owner.execute(
        "SELECT status, last_error FROM price_verification_request WHERE offer_id = %s",
        (ids["t0113-ali"],),
    ).fetchone()
    assert status == ("unsupported", "no_provider")


@pytest.mark.integration
def test_gecici_hata_yeniden_denenir_kur_tekrarlanmaz(db) -> None:  # type: ignore[no-untyped-def]
    owner, app, ids = db
    enqueue_stale(app, merchant="t0113-shop", limit=10, older_than=timedelta(hours=1))
    app.commit()
    report = process(app, [FakeProvider(Outcome("error", error_code="network"))], limit=10_000)
    assert report.errors >= 1
    row = owner.execute(
        "SELECT status, attempts, next_attempt_at > now() FROM price_verification_request"
        " WHERE offer_id = %s",
        (ids["t0113-shop"],),
    ).fetchone()
    assert row == ("pending", 1, True)
    assert owner.execute(
        "SELECT count(*) FROM price_verification WHERE offer_id = %s", (ids["t0113-shop"],)
    ).fetchone() == (0,)

    rates = [r for r in parse_tcmb(TCMB_XML)]
    rates = [type(r)(r.base, r.rate, r.kind, r.effective_date, "test0113") for r in rates]
    first = store(app, rates)
    second = store(app, rates)
    app.commit()
    assert first == second  # ayni bulten ikinci kez yazilmaz
