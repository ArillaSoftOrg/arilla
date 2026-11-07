"""Shopify pilotunun gercek kardes urunleri ASLA otomatik birlesmez (karar 0119).

7 Kasim pilotunda (Termos Dunyasi, 250 urun) ayni modelin renk/hacim kardesleri
basligin yalnizca son kelimesinde ayrisiyordu; sozlukte olmayan renkler ("Eflatun",
"Krem", "Hot Coral", "Rose Quartz") renk vetosunu tetiklemiyor ve metin skoru 1,0'a
cikiyordu. Barkod olmadigindan eslestirme yalnizca metin yontemiyle olur ve metin
yontemi otomatik kabul edilmez. Bu set o guvenligi sabitler.
"""

from __future__ import annotations

import pytest

from resolve.normalize import ProductKey
from resolve.score import auto_eligible, combine

MADELEINE = "Stanley The All Day Madeleine Midi Sırt Tipi Termos Çanta – 14L"

SIBLINGS = [
    (f"{MADELEINE} Eflatun", f"{MADELEINE} Krem"),
    (f"{MADELEINE} Hot Coral", f"{MADELEINE} Rose Quartz"),
    (f"{MADELEINE} Siyah", f"{MADELEINE} Krem"),
    ("Fellow Carter Move Mug Sienna 12 oz", "Fellow Carter Move Mug Sienna 16 oz"),
    (
        "Stanley The IceFlow Twist Flip Termos 0.47L Violet",
        "Stanley The IceFlow Twist Flip Termos 0.7L Violet",
    ),
]


@pytest.mark.parametrize(("left", "right"), SIBLINGS)
def test_barcodeless_siblings_are_never_auto_merged(left: str, right: str) -> None:
    brand = left.split()[0]
    a, b = ProductKey.build(left, brand), ProductKey.build(right, brand)
    assert not auto_eligible(combine(a, b), a, b)


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ("Fellow Carter Move Mug Sienna 12 oz", "Fellow Carter Move Mug Sienna 16 oz"),
        (
            "Stanley The IceFlow Twist Flip Termos 0.47L Violet",
            "Stanley The IceFlow Twist Flip Termos 0.7L Violet",
        ),
        (f"{MADELEINE} Siyah", f"{MADELEINE} Lacivert"),
    ],
)
def test_capacity_and_known_colour_differences_are_vetoed(left: str, right: str) -> None:
    brand = left.split()[0]
    assert combine(ProductKey.build(left, brand), ProductKey.build(right, brand)).veto
