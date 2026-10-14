"""Kimlik duzey kurallari ve otomatik birlestirme politikasi (karar 0111)."""

from __future__ import annotations

import pytest

from resolve.identity_policy import (
    GtinInfo,
    KnownIdentity,
    OfferIdentity,
    classify_gtin,
    decide_link,
    mpn_norm,
    normalize_options,
    option_key,
)


def with_check(body: str) -> str:
    """GS1 kontrol basamagini ekler (test verisi uretmek icin)."""
    digits = [int(ch) for ch in body]
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(digits)))
    return body + str((10 - total % 10) % 10)


EAN13 = with_check("869123456789")  # Turkiye oneki, gecerli
UPC12 = with_check("03600029145")  # number system 0


# --------------------------------------------------------------------------
# GTIN
# --------------------------------------------------------------------------


def test_gecerli_ean13_ve_upc_14_haneye_tamamlanir() -> None:
    assert classify_gtin(EAN13) == GtinInfo("0" + EAN13, "valid")
    assert classify_gtin(UPC12) == GtinInfo("00" + UPC12, "valid")
    # Ayni urunun UPC ve EAN-13 yazimi ayni 14 haneli degere iner.
    assert classify_gtin("0" + UPC12).value == classify_gtin(UPC12).value


@pytest.mark.parametrize(
    "body",
    [
        "200123456789",  # 200-299 magaza ici
        "250000000001",
        "021234567890",  # 020-029 kisitli dolasim
        "041234567890",  # 040-049
        "051234567890",  # 050-059 kupon
        "977123456789",  # ISSN
        "978605123456",  # ISBN
        "979123456789",  # ISMN/ISBN
        "981234567890",  # kupon
        "991234567890",
    ],
)
def test_kisitli_onekler_kimlik_degildir(body: str) -> None:
    info = classify_gtin(with_check(body))
    assert info.status == "restricted"
    assert info.value is None


def test_upc_kisitli_number_system_2_4_5() -> None:
    for system in "245":
        assert classify_gtin(with_check(system + "1234567890")).status == "restricted"


def test_gtin8_rcn_kisitli_digerleri_gecerli() -> None:
    assert classify_gtin(with_check("0123456")).status == "restricted"
    assert classify_gtin(with_check("2123456")).status == "restricted"
    valid = classify_gtin(with_check("5012345"))
    assert valid.status == "valid" and valid.value == "000000" + with_check("5012345")


def test_gtin14_paket_gostergesi_ayri_varyant_9_degisken_olcu() -> None:
    pack = classify_gtin(with_check("1869123456789"))
    assert pack.status == "valid" and pack.package_level is True
    assert classify_gtin(with_check("9869123456789")).status == "restricted"
    assert classify_gtin(EAN13).package_level is False


WRONG_CHECK = EAN13[:-1] + str((int(EAN13[-1]) + 1) % 10)


@pytest.mark.parametrize(
    "raw", [None, "", "abc", "0000000000000", with_check("111111111111"), WRONG_CHECK]
)
def test_gecersiz_ve_cop_degerler(raw: str | None) -> None:
    assert classify_gtin(raw).status == "invalid"


# --------------------------------------------------------------------------
# MPN ve varyant anahtari
# --------------------------------------------------------------------------


def test_mpn_normalizasyonu() -> None:
    assert mpn_norm(" sm-a556b/ds ") == "SMA556BDS"
    assert mpn_norm("SM A556B.DS") == "SMA556BDS"
    assert mpn_norm("yok") is None
    assert mpn_norm("12") is None


def test_option_key_sira_ve_yazimdan_bagimsiz() -> None:
    a = option_key({"Renk": "Siyah", "Kapasite": "256 GB"})
    b = option_key({"capacity": "256GB", "Color": "SİYAH"})
    assert a == b == "kapasite=256gb;renk=siyah"
    assert option_key({}) == ""
    assert option_key({"Beden": "", "Numara": "42"}) == "beden=42"


def test_bilinmeyen_eksen_uydurulmaz_korunur() -> None:
    assert normalize_options({"Kumaş Tipi": "Pamuk"}) == {"kumas_tipi": "pamuk"}


# --------------------------------------------------------------------------
# Otomatik birlestirme
# --------------------------------------------------------------------------

G = classify_gtin(EAN13)


def offer(**kw: object) -> OfferIdentity:
    base: dict[str, object] = {
        "gtin": None,
        "mpn": None,
        "brand_id": 1,
        "category_root": "elektronik",
        "options": {},
    }
    base.update(kw)
    return OfferIdentity(**base)  # type: ignore[arg-type]


def known(**kw: object) -> KnownIdentity:
    base: dict[str, object] = {
        "kind": "gtin",
        "status": "active",
        "product_id": 10,
        "canonical_variant_id": 100,
        "brand_id": 1,
        "category_root": "elektronik",
        "options": {"kapasite": "256gb"},
    }
    base.update(kw)
    return KnownIdentity(**base)  # type: ignore[arg-type]


def test_ayni_gtin_farkli_satici_ayni_varyanta_baglanir() -> None:
    d = decide_link(offer(gtin=G, options={"Kapasite": "256 GB"}), [known()])
    assert (d.decision, d.basis, d.product_id, d.canonical_variant_id) == ("link", "gtin", 10, 100)


def test_ayni_gtin_farkli_kapasite_birlestirilmez_celiski() -> None:
    d = decide_link(offer(gtin=G, options={"kapasite": "128GB"}), [known()])
    assert d.decision == "hold" and d.basis == "gtin_variant_mismatch" and d.mark_conflict


def test_ayni_gtin_farkli_marka_ya_da_kategori_birlestirilmez() -> None:
    assert decide_link(offer(gtin=G, brand_id=2), [known()]).basis == "gtin_brand_mismatch"
    assert (
        decide_link(offer(gtin=G, category_root="moda"), [known()]).basis
        == "gtin_category_mismatch"
    )


def test_celiskili_kimlik_otomatik_bag_kurmaz() -> None:
    d = decide_link(offer(gtin=G), [known(status="conflict")])
    assert d.decision == "hold" and not d.mark_conflict


def test_kisitli_gtin_kimlik_sayilmaz() -> None:
    restricted = classify_gtin(with_check("200123456789"))
    assert decide_link(offer(gtin=restricted), [known()]).decision == "unmatched"


def test_mpn_marka_ile_urun_duzeyinde_baglar() -> None:
    k = known(kind="mpn", canonical_variant_id=None, options={})
    d = decide_link(offer(mpn="SMA556B"), [k])
    assert (d.decision, d.basis, d.product_id, d.canonical_variant_id) == ("link", "mpn", 10, None)


def test_markasiz_mpn_ve_baska_markanin_mpn_si_baglamaz() -> None:
    k = known(kind="mpn", canonical_variant_id=None, options={})
    assert decide_link(offer(mpn="SMA556B", brand_id=None), [k]).decision == "unmatched"
    assert decide_link(offer(mpn="SMA556B", brand_id=7), [k]).decision == "unmatched"


def test_model_ipucu_ve_kimliksiz_kayit_otomatik_birlestirilmez() -> None:
    hint = known(kind="model_hint", canonical_variant_id=None, options={})
    assert decide_link(offer(), [hint]).decision == "unmatched"
    assert decide_link(offer(), []).basis == "no_verified_identity"


def test_birden_fazla_aktif_hedef_belirsizdir() -> None:
    d = decide_link(offer(gtin=G), [known(), known(product_id=11, canonical_variant_id=101)])
    assert d.decision == "hold" and d.basis == "gtin_ambiguous"
