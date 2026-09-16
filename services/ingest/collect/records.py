"""Katmanlar arasi sozlesme.

Tasima katmani `RawRecord` uretir (alan adlari KAYNAGA aittir), normalizasyon
katmani `NormalizedOffer` uretir (alan adlari BIZE ait, sema ile ortusur).
Ikisini ayirmak, ayni normalizasyonun uc farkli tasima uzerinde calismasini
saglar.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field


@dataclass(frozen=True)
class RawRecord:
    """Kaynaktan gelen tek kayit, hic dokunulmamis haliyle."""

    fields: Mapping[str, str]
    #: Hangi sayfa / dosya / satir. Hata ayiklamada tek izimiz bu.
    source_ref: str
    #: Tekrarli ic ice yapilar — bedenler gibi. Duz `fields` bunlari
    #: tasiyamaz: bir teklifin bes bedeni varsa bes ayri alt kayit vardir.
    #: CSV gibi duz kaynaklarda bos kalir.
    groups: Mapping[str, tuple[Mapping[str, str], ...]] = field(default_factory=dict)


@dataclass(frozen=True)
class NormalizedVariant:
    """Bir teklifin beden satiri. Stok bu duzeyde takip edilir."""

    external_id: str
    size_label: str | None
    size_norm: str | None
    in_stock: bool
    #: nadir. NULL ise offer.current_price gecerli (docs/decisions/0005).
    price_override: int | None = None
    sku: str | None = None


@dataclass(frozen=True)
class NormalizedOffer:
    """`offer` tablosuna yazilabilir hale gelmis kayit.

    `product_id` YOKTUR: eslestirme B4'un isidir, toplama katmani urun
    baglamaz. Eslesmemis offer sistemde yasayabilir.
    """

    external_id: str
    url: str
    title_raw: str
    #: Kurus cinsinden tamsayi. Asla float.
    current_price: int | None
    list_price: int | None
    in_stock: bool
    brand_raw: str | None = None
    category_raw: str | None = None
    image_url: str | None = None
    gtin: str | None = None
    currency: str = "TRY"
    shipping_days: int | None = None
    shipping_cost: int | None = None
    free_shipping_threshold: int | None = None
    attributes_raw: dict[str, str] = field(default_factory=dict)
    variants: tuple[NormalizedVariant, ...] = ()


class RecordRejected(Exception):
    """Tek bir kayit normalize edilemedi.

    Kosuyu durdurmaz: kayit sayilir, kosu `partial` biter. Bir feed'deki tek
    bozuk satir yuzunden 10.000 urunu birakmak dogru davranis degil.
    """
