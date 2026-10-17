"""Hepsiburada kaynak ilani politikasi ve uc durumlu stok (karar 0129). Veritabani yok."""

from __future__ import annotations

from datetime import UTC, datetime

from catalog_build.discovery import DiscoveryRow, evaluate_discovery
from catalog_build.policy import (
    POLICIES,
    SOURCE_LISTING_MERCHANTS,
    SourceOffer,
    evaluate,
    hepsiburada_code_kind,
)
from feeds.intake import stock_state, to_feed_row

HB = POLICIES["hepsiburada"]
IMG = "https://productimages.hepsiburada.net/s/1/a.jpg"


def offer(url: str, ext: str, price: int | None = 129900) -> SourceOffer:
    return SourceOffer(
        offer_id=1,
        external_id=ext,
        url=url,
        title_raw="Apple iPhone 15 128 GB Siyah",
        image_url=IMG,
        current_price=price,
        currency="TRY",
        is_active=True,
    )


def test_kod_turu_adresten_okunur() -> None:
    assert hepsiburada_code_kind("https://www.hepsiburada.com/a-b-p-HBCV00001") == "p"
    assert hepsiburada_code_kind("https://www.hepsiburada.com/a-b-pm-HBC00001") == "pm"
    assert hepsiburada_code_kind("https://www.hepsiburada.com/kampanya") is None


def test_teklif_politikasi_kod_ve_adres_ayni_olmali() -> None:
    ok = evaluate(offer("https://www.hepsiburada.com/iphone-15-p-HBCV00001", "HBCV00001"), HB)
    assert ok.draft is not None and ok.draft.slug.endswith("-HBCV00001")
    other = evaluate(offer("https://www.hepsiburada.com/iphone-15-p-HBCV00002", "HBCV00001"), HB)
    assert other.skip == "source_id_url_mismatch"
    foreign = evaluate(offer("https://www.hepsiburada.com.tr/x-p-HBCV00001", "HBCV00001"), HB)
    assert foreign.skip == "source_id_url_mismatch"
    query = evaluate(offer("https://www.hepsiburada.com/x-p-HBCV00001?magaza=y", "HBCV00001"), HB)
    assert query.skip == "source_id_url_mismatch"


def test_fiyatsiz_teklif_urun_olmaz() -> None:
    verdict = evaluate(offer("https://www.hepsiburada.com/x-p-HBCV00001", "HBCV00001", None), HB)
    assert verdict.skip == "no_price"


def test_kaynak_ilani_magazalari_cozumleyiciden_ayrilir() -> None:
    assert {"hepsiburada", "aliexpress"} <= SOURCE_LISTING_MERCHANTS


def disc(**kw: object) -> DiscoveryRow:
    base: dict[str, object] = {
        "external_id": "HBC0000KHSC74",
        "code_kind": "pm",
        "url": "https://www.hepsiburada.com/okuma-standi-pm-HBC0000KHSC74",
        "title": "Store Kitap Okuma Standi",
        "image_url": IMG,
    }
    base.update(kw)
    return DiscoveryRow(**base)  # type: ignore[arg-type]


def test_kesif_satiri_fiyatsiz_taslak_olur() -> None:
    verdict = evaluate_discovery(disc(), HB)
    assert verdict.draft is not None
    assert verdict.draft.offer_id is None  # teklif yok, uydurulmaz


def test_kesif_satiri_adsiz_gorselsiz_ya_da_tur_uyusmazsa_reddedilir() -> None:
    assert evaluate_discovery(disc(title=None), HB).skip == "no_title"
    assert evaluate_discovery(disc(title="   "), HB).skip == "no_title"
    assert evaluate_discovery(disc(image_url=None), HB).skip == "no_image"
    assert evaluate_discovery(disc(code_kind="p"), HB).skip == "source_id_url_mismatch"
    assert evaluate_discovery(disc(external_id="BASKA1"), HB).skip == "source_id_url_mismatch"


def test_stok_uc_durumlu() -> None:
    assert stock_state(True) == "available"
    assert stock_state(False) == "unavailable"
    assert stock_state(None) == "unknown"


def _row(in_stock: bool | None) -> tuple[object, ...]:
    return (
        1,
        "HBCV1",
        "Urun",
        "https://www.hepsiburada.com/u-p-HBCV1",
        12990,
        None,
        "TRY",
        in_stock,
        None,
        None,
        None,
        None,
        None,
        None,
        datetime.now(UTC),
        None,
        None,
    )


def test_besleme_satiri_stok_durumunu_her_zaman_yazar() -> None:
    # FeedSync attributes_raw'i `||` ile birlestirir: anahtar eksik kalsa eski deger yasardi.
    for value, state, available in (
        (True, "available", "true"),
        (False, "unavailable", "false"),
        (None, "unknown", "false"),
    ):
        record = to_feed_row(_row(value))
        assert record["param"]["stock_state"] == state
        assert record["available"] == available
