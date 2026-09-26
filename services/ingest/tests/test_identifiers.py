"""Barkod zenginlestirmesi: GS1 dogrulamasi, varyant duzeyi eslemesi (0034, 0036)."""

from __future__ import annotations

from collect.identifiers import (
    group_variants,
    gtin_valid,
    map_variant_barcodes,
    offer_barcode,
)

#: Gercek degerler: Dr. Althea Rapid Hypochlorous Acid Rescue Mist, Korendy
#: /products/<handle>.js (60 ml ve 100 ml ayri barkod) — Vionine'de ayri listeler.
HOCL_60 = "8809447257433"
HOCL_100 = "8809447257440"


def test_gtin_check_digit() -> None:
    assert gtin_valid(HOCL_60) and gtin_valid(HOCL_100)
    assert gtin_valid("1210001906631")  # Stanley Transit 0.47 Rose Quartz
    assert not gtin_valid("8809447257441")  # son basamak bozuk
    assert not gtin_valid("KRNDY3004")  # magaza ic kodu
    assert not gtin_valid("12345")
    assert not gtin_valid(None)


def _hocl() -> dict:
    return {
        "options": ["Size"],
        "variants": [
            {"id": 101, "option1": "60ml", "sku": "KRNDY3003", "barcode": HOCL_60},
            {"id": 102, "option1": "100ml", "sku": "KRNDY3183", "barcode": HOCL_100},
        ],
    }


def test_one_offer_with_two_sizes_has_no_offer_level_barcode() -> None:
    """0036: iki farkli boyut tek offer'da -> offer duzeyi barkod YOK."""
    assert offer_barcode(_hocl()["variants"]) is None


def test_barcodeless_size_does_not_let_the_other_size_claim_the_offer() -> None:
    """0034 hatasi: barkodsuz boyut yok sayiliyor, 100 ml barkodu tum offer'a
    yaziliyordu."""
    variants = [
        {"id": 101, "option1": "60ml", "barcode": ""},
        {"id": 102, "option1": "100ml", "barcode": HOCL_100},
    ]
    assert offer_barcode(variants) is None


def test_single_commercial_variant_gets_offer_level_barcode() -> None:
    assert offer_barcode([{"id": 1, "barcode": HOCL_100}]) == HOCL_100
    # Ayni barkodu tasiyan renk kardesi varyantlari (ayni ticari varyant): tek kimlik.
    assert offer_barcode([{"barcode": HOCL_100}, {"barcode": HOCL_100}]) == HOCL_100


def test_each_size_row_gets_its_own_barcode_by_variant_id() -> None:
    rows = [(11, "101", "KRNDY3003", "60ml"), (12, "102", "KRNDY3183", "100ml")]
    assert map_variant_barcodes(rows, _hocl()["variants"], 1) == {11: HOCL_60, 12: HOCL_100}


def test_mapping_falls_back_to_sku_then_size_but_never_array_position() -> None:
    variants = _hocl()["variants"]
    # Varyant kimligi degismis (farkli id), SKU tutuyor.
    assert map_variant_barcodes([(11, "999", "KRNDY3183", None)], variants, 1) == {11: HOCL_100}
    # Kimlik ve SKU yok, beden secenegi tutuyor.
    assert map_variant_barcodes([(11, "999", None, "60ml")], variants, 1) == {11: HOCL_60}
    # Hicbir anahtar tutmuyor: dizi sirasina gore TAHMIN edilmez.
    assert map_variant_barcodes([(11, "999", None, "30ml")], variants, 1) == {}


def test_ambiguous_weak_key_is_not_used() -> None:
    variants = [
        {"id": 1, "option1": "60ml", "sku": "AYNI", "barcode": HOCL_60},
        {"id": 2, "option1": "60ml", "sku": "AYNI", "barcode": HOCL_100},
    ]
    assert map_variant_barcodes([(11, "999", "AYNI", "60ml")], variants, 1) == {}


def test_invalid_barcode_is_never_stored() -> None:
    variants = [{"id": 1, "option1": "60ml", "barcode": "8809447257441"}]
    assert offer_barcode(variants) is None
    assert map_variant_barcodes([(11, "1", None, "60ml")], variants, 1) == {}


def test_color_group_selects_its_own_variants() -> None:
    product = {
        "options": [{"name": "Renk"}, {"name": "Hacim"}],
        "variants": [
            {"option1": "Ash", "option2": "0.47L", "barcode": "1210001906631"},
            {"option1": "Rose Quartz", "option2": "0.47L", "barcode": HOCL_60},
        ],
    }
    ash = group_variants(product, "Ash", ["Renk"])
    assert offer_barcode(ash) == "1210001906631"
    assert len(group_variants(product, None, ["Renk"])) == 2
