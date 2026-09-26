"""Toplama kapisi: bir merchant'tan veri cekilmeden ONCE verilen karar.

`run_ingest` connector'u kurmadan once bunu sorar. Kapi kapaliysa kosu
`ingest_run` satirina `failed` + `refused:<kod>` olarak yazilir ve biter:
magazaya tek istek gitmez, tek offer ya da `price_point` yazilmaz.

Kurallar (docs/decisions/0031):

- Her kaynak: `merchant.is_active` TRUE olmali.
- Shopify: `/products.json` para birimi tasimaz. Merchant duzeyinde kanit
  sarttir: `feed_config.currency_verified` tam olarak JSON `true` ve
  `feed_config.currency` tam olarak `"TRY"`. Eksik, `false`, `"true"` gibi
  metin ya da baska bir para birimi — hepsi ret. Doviz cevrimi yok; TRY
  disindaki Shopify magazalari desteklenmez.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

#: Shopify merchant'lari icin kabul edilen TEK para birimi.
SHOPIFY_CURRENCY = "TRY"


@dataclass(frozen=True)
class Refusal:
    #: Makine tarafindan okunur kod; `ingest_run.error_text` bununla baslar.
    code: str
    message: str

    @property
    def error_text(self) -> str:
        return f"refused:{self.code}: {self.message}"


def ingest_refusal(merchant: Mapping[str, Any]) -> Refusal | None:
    """Kapi aciksa `None`, degilse ret gerekcesi."""
    if merchant.get("is_active") is not True:
        return Refusal("merchant_inactive", "merchant.is_active = false; toplama baslamadi")

    if merchant.get("source_type") != "shopify":
        return None

    config = merchant.get("feed_config")
    if not isinstance(config, Mapping):
        return Refusal("feed_config_invalid", "feed_config bir JSON nesnesi degil")
    if config.get("currency_verified") is not True:
        return Refusal(
            "currency_unverified",
            "Shopify merchant'i icin feed_config.currency_verified = true degil "
            f"(deger: {config.get('currency_verified')!r})",
        )
    if config.get("currency") != SHOPIFY_CURRENCY:
        return Refusal(
            "currency_not_try",
            f"Shopify yalnizca {SHOPIFY_CURRENCY} ile toplanir "
            f"(feed_config.currency: {config.get('currency')!r})",
        )
    return None
