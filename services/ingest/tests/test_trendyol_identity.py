"""Trendyol kimlik kurali (karar 0118 §5, 0221): kayitli GERCEK orneklerle regresyon.

Ornekler `packages/core/src/catalog-collection/fixtures` altindadir: gercek Chrome'da tek normal
ziyaretle okunan alanlardan kuruldu (toplayicinin TS testleri de ayni dosyalari kullanir). Bu
test Trendyol'a istek ATMAZ; yalniz dosya okur.

Neden onemli: kayit defteri Trendyol'u satici basina (`listing_seller`) tanimliyordu ve
`listing_only` degildi. Toplama acilsaydi cozumleyici Trendyol tekliflerinden kapisiz urun
acabilirdi ve teklif anahtari (`<contentId>~<satici>`) toplayicinin yazdigi `external_id`
(yalniz contentId) ile celisirdi.
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from catalog_build.policy import POLICIES, SOURCE_LISTING_MERCHANTS, SourceOffer, evaluate
from platforms import registry

FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "core"
    / "src"
    / "catalog-collection"
    / "fixtures"
)
PRODUCT_KEY = 'window["__envoy__SHARED_PROPS"]='
LISTING_KEY = 'window["__single-search-result__PROPS"]='


def _window_json(fixture: dict, marker: str) -> dict:
    for text in fixture["scriptTexts"]:
        if marker in text:
            return json.loads(text.split(marker, 1)[1].strip().rstrip(";"))
    raise AssertionError(f"{marker} yok")


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _canonical(url: str) -> str:
    parts = urlsplit(url if url.startswith("http") else f"https://www.trendyol.com{url}")
    return f"https://{parts.netloc}{parts.path}"


def test_registry_trendyol_is_product_keyed_and_gated() -> None:
    ty = registry.TRENDYOL
    assert ty.status == "verified"
    assert ty.offer_key_scheme == "listing"  # urun basina tek teklif (0118 §5)
    assert ty.listing_only is True
    assert ty.currency == "TRY"
    assert registry.onboarding_problems(ty) == []
    assert "trendyol" in POLICIES
    # Cozumleyici Trendyol tekliflerinden urun ACMAZ; urun yalniz kapi -> yayin hattindan gelir.
    assert "trendyol" in SOURCE_LISTING_MERCHANTS


@pytest.mark.parametrize("name", ["iphone-857296094.json", "samba-813659620.json"])
def test_product_page_url_id_equals_embedded_product_id(name: str) -> None:
    fixture = _load(name)
    product = _window_json(fixture, PRODUCT_KEY)["product"]
    match = registry.TRENDYOL_URL.match(fixture["url"])
    assert match is not None
    assert match.group(1) == str(product["id"])
    assert registry.TRENDYOL.identity.id_pattern.match(str(product["id"]))
    for text in fixture["jsonLdTexts"]:
        node = json.loads(text)
        if isinstance(node, dict) and node.get("@id"):
            assert registry.TRENDYOL_URL.match(node["@id"]).group(1) == str(product["id"])


def test_listing_cards_canonical_url_carries_content_id() -> None:
    cards = _window_json(_load("listing-cat1.json"), LISTING_KEY)["data"]["products"]
    assert cards
    for card in cards:
        match = registry.TRENDYOL_URL.match(_canonical(card["url"]))
        assert match is not None, card["url"]
        content_id = str(card.get("contentId") or card.get("id"))
        assert match.group(1) == content_id


def _offer(external_id: str, url: str) -> SourceOffer:
    return SourceOffer(
        offer_id=1,
        external_id=external_id,
        url=url,
        title_raw="Apple iPhone 16 Pro 128GB Col Titanyum",
        image_url="https://cdn.dsmcdn.com/ty1/prod/1_org_zoom.jpg",
        current_price=12_499_900,
        currency="TRY",
        is_active=True,
    )


URL = "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094"


def test_gate_accepts_product_keyed_offer() -> None:
    verdict = evaluate(_offer("857296094", URL), POLICIES["trendyol"])
    assert verdict.skip is None and verdict.draft is not None
    assert verdict.draft.slug.endswith("-857296094")


@pytest.mark.parametrize(
    ("external_id", "url", "reason"),
    [
        # Eski (yanlis) satici anahtari: kapidan gecemez.
        ("857296094~724838", URL, "source_id_invalid"),
        # Adres baska urune ait.
        ("857296095", URL, "source_id_url_mismatch"),
        # Kanonik olmayan adres (sorgu, satici parametresi).
        ("857296094", f"{URL}?merchantId=724838", "source_id_url_mismatch"),
        ("857296094", "https://trendyol.com/apple/x-p-857296094", "source_id_url_mismatch"),
    ],
)
def test_gate_rejects_non_canonical_identity(external_id: str, url: str, reason: str) -> None:
    assert evaluate(_offer(external_id, url), POLICIES["trendyol"]).skip == reason
