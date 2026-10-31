"""Kaynak bazli lisans, veri saklama ve guncelleme kisitlari (karar 0162).

Kisit kod icinde `if platform == ...` olarak degil, kaynagin kaydinda tasinir. Saf
veri + saf fonksiyonlar: ag, veritabani ve saat yok (saat parametre).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Literal

DataLicense = Literal[
    "affiliate_terms",  # ag/program sartlari (Admitad vb.)
    "partner_api",  # imzali API sozlesmesi
    "public_feed",  # herkese acik, yeniden kullanima izin veren besleme
    "operator_collected",  # yonetici tarayicisiyla toplanan (karar 0115/0118); en kisitli
    "unknown",  # belgelenmemis: en kisitli varsayilan
]


@dataclass(frozen=True)
class UpdateLimits:
    #: Iki kosu arasi en kisa sure. Kaynagi daha sik yoklamak yasak.
    min_refresh_interval: timedelta = timedelta(hours=6)
    #: Bir fiyat bu kadar eskiyse gosterilmez / yayina alinmaz (karar 0156/0160).
    max_price_age: timedelta = timedelta(days=2)
    requests_per_minute: int = 30
    #: Gunluk toplam istek butcesi; None = sinirsiz (yalniz dosya indirmede anlamli).
    daily_request_budget: int | None = None
    max_concurrency: int = 2
    batch_size: int = 1_000
    #: Ardisik hata sayisi; asilirsa kaynak o kosuda durur (hata izolasyonu).
    max_consecutive_errors: int = 25

    def __post_init__(self) -> None:
        if self.requests_per_minute < 1 or self.max_concurrency < 1 or self.batch_size < 1:
            raise ValueError("limitler en az 1 olmali")
        if self.max_consecutive_errors < 1:
            raise ValueError("max_consecutive_errors en az 1 olmali")
        if self.min_refresh_interval <= timedelta(0) or self.max_price_age <= timedelta(0):
            raise ValueError("sureler pozitif olmali")


@dataclass(frozen=True)
class RetentionPolicy:
    #: price_point gecmisi bu kadar gun tutulur; None = sinirsiz (kural 4: yalnizca INSERT,
    #: silme elde degil toplu bir bakim isiyle ve acik onayla yapilir).
    price_history_days: int | None = None
    #: Ham yuk (indirilen dosya/yanit) en fazla bu kadar gun.
    raw_payload_days: int = 30
    #: Kaynaktan kaybolan ilanin satiri bu kadar gun sonra pasif kalir; silinmez.
    gone_listing_grace_days: int = 30

    def __post_init__(self) -> None:
        if self.price_history_days is not None and self.price_history_days < 1:
            raise ValueError("price_history_days en az 1 olmali")
        if self.raw_payload_days < 0 or self.gone_listing_grace_days < 0:
            raise ValueError("saklama gunleri negatif olamaz")


@dataclass(frozen=True)
class UsageRights:
    data_license: DataLicense = "unknown"
    may_store_prices: bool = False
    may_display_prices: bool = False
    #: URL olarak referans vermek serbest mi (gorsel kopyalanmaz; yalniz baglanti).
    may_hotlink_images: bool = False
    #: Gorseli kendi depomuza kopyalamak (aynalama).
    may_mirror_images: bool = False
    may_track_clicks: bool = True
    #: Bu kaynaktan gelen urun/fiyat arayuzde kaynak belirtmeyi ister.
    attribution_required: bool = False
    #: Yurt disi (TRY disi) fiyatin gosterimi icin acik urun karari gerekir (karar 0113).
    foreign_currency_display: bool = False


@dataclass(frozen=True)
class SourceConstraints:
    rights: UsageRights = field(default_factory=UsageRights)
    retention: RetentionPolicy = field(default_factory=RetentionPolicy)
    update: UpdateLimits = field(default_factory=UpdateLimits)

    def __post_init__(self) -> None:
        if self.rights.may_display_prices and not self.rights.may_store_prices:
            raise ValueError("fiyat gosterimi icin fiyat saklama hakki gerekir")
        if self.rights.may_mirror_images and not self.rights.may_hotlink_images:
            raise ValueError("gorsel aynalama, gorsele baglanti hakkini da gerektirir")


def refresh_due(
    constraints: SourceConstraints, last_run_at: datetime | None, now: datetime
) -> bool:
    """Kaynak yeniden calistirilabilir mi (en kisa aralik)."""
    if last_run_at is None:
        return True
    return now - last_run_at >= constraints.update.min_refresh_interval


def next_refresh_at(
    constraints: SourceConstraints, last_run_at: datetime | None, now: datetime
) -> datetime:
    if last_run_at is None:
        return now
    return max(now, last_run_at + constraints.update.min_refresh_interval)


def price_displayable(
    constraints: SourceConstraints,
    *,
    currency: str,
    observed_at: datetime,
    now: datetime,
    foreign_display_approved: bool = False,
) -> tuple[bool, str | None]:
    """(gosterilebilir, neden). Neden sabit kod; gosterilebiliyorsa None."""
    rights = constraints.rights
    if not (rights.may_store_prices and rights.may_display_prices):
        return False, "license_forbids_price"
    if now - observed_at > constraints.update.max_price_age:
        return False, "price_stale"
    if currency != "TRY" and not (rights.foreign_currency_display and foreign_display_approved):
        return False, "foreign_currency_not_approved"
    return True, None


def price_history_cutoff(constraints: SourceConstraints, now: datetime) -> datetime | None:
    """Bu tarihten eski price_point satirlari bakim isiyle temizlenebilir; None = hic."""
    days = constraints.retention.price_history_days
    return None if days is None else now - timedelta(days=days)
