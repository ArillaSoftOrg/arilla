"""Besleme tazeligi siniflandirmasi (karar 0145). Veritabani gerekmez."""

from __future__ import annotations

import re
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from feeds.freshness import (
    MAX_FX_AGE_DAYS,
    FeedFreshness,
    FeedState,
    Freshness,
    FxFreshness,
    classify,
)

NOW = datetime(2026, 10, 22, 12, 0, tzinfo=UTC)
WEEK = timedelta(days=7)


def state(source: datetime | None, success: datetime | None) -> FeedState:
    return classify(now=NOW, source_updated_at=source, last_success_at=success, max_source_age=WEEK)


def test_hic_yazilmamis_besleme_bayattir() -> None:
    assert state(NOW - timedelta(hours=1), None) is FeedState.NEVER_SYNCED
    assert state(None, None) is FeedState.NEVER_SYNCED


def test_kaynak_yazimdan_yeniyse_geride_kalinmistir() -> None:
    # Kaynak dun gece guncellendi, son yazim iki gun once: son surumu yazmadik.
    assert state(NOW - timedelta(hours=10), NOW - timedelta(days=2)) is FeedState.BEHIND


def test_kaynak_yazimdan_eski_veya_esitse_guncel() -> None:
    assert state(NOW - timedelta(days=1), NOW - timedelta(hours=2)) is FeedState.CURRENT
    same = NOW - timedelta(hours=3)
    assert state(same, same) is FeedState.CURRENT


def test_kaynagin_kendisi_eskiyse_kaynak_bayat() -> None:
    # Biz yazdik (yazim kaynaktan yeni) ama kaynak 9 gundur guncellenmemis: fiyat eski.
    assert state(NOW - timedelta(days=9), NOW - timedelta(hours=1)) is FeedState.SOURCE_STALE


def test_sinir_degeri_tam_hafta_hala_guncel() -> None:
    assert state(NOW - WEEK, NOW - timedelta(hours=1)) is FeedState.CURRENT
    assert state(NOW - WEEK - timedelta(seconds=1), NOW) is FeedState.SOURCE_STALE


def test_gelecek_tarihli_kaynak_guvenilmez() -> None:
    assert state(NOW + timedelta(days=2), NOW) is FeedState.SOURCE_DATE_INVALID
    # Kucuk saat sapmasi hosgorulur.
    assert state(NOW + timedelta(hours=1), NOW + timedelta(hours=2)) is FeedState.CURRENT


def test_kaynak_tarih_vermiyorsa_yalniz_yazim_yasina_bakilir() -> None:
    assert state(None, NOW - timedelta(days=1)) is FeedState.CURRENT
    assert state(None, NOW - timedelta(days=8)) is FeedState.BEHIND


@pytest.mark.parametrize(
    ("age", "usable"),
    [(0, True), (MAX_FX_AGE_DAYS, True), (MAX_FX_AGE_DAYS + 1, False), (-1, False)],
)
def test_kur_kullanilabilirligi_okuma_yoluyla_ayni_kural(age: int, usable: bool) -> None:
    fx = FxFreshness(date(2026, 10, 22) - timedelta(days=age), age)
    assert fx.usable is usable


def test_kur_yoksa_kullanilamaz() -> None:
    assert FxFreshness(None, None).usable is False


def test_python_kur_siniri_ts_ile_ayni() -> None:
    """Python tarafi 4 gunluk siniri ayri tasir; TS'teki deger degisirse bu test kirilir."""
    ts = Path(__file__).resolve().parents[3] / "packages/core/src/pricing/fx.ts"
    match = re.search(r"export const MAX_RATE_AGE_DAYS = (\d+);", ts.read_text(encoding="utf-8"))
    assert match, "fx.ts icinde MAX_RATE_AGE_DAYS bulunamadi"
    assert int(match.group(1)) == MAX_FX_AGE_DAYS


def test_detail_yalniz_duz_deger_ve_sirsiz() -> None:
    report = Freshness(merchant="aliexpress", now=NOW)
    report.feeds = [
        FeedFreshness(
            1,
            "6115:14267",
            "active",
            FeedState.CURRENT,
            NOW - timedelta(hours=5),
            NOW - timedelta(hours=1),
            None,
            100,
        ),
        FeedFreshness(
            2,
            "6115:14268",
            "active",
            FeedState.BEHIND,
            NOW - timedelta(hours=2),
            NOW - timedelta(days=2),
            "http_5xx",
            50,
        ),
    ]
    report.offers_active, report.offers_fresh, report.offers_stale = 150, 100, 50
    report.fx = FxFreshness(date(2026, 10, 21), 1)
    detail = report.detail()
    assert detail["feeds_active"] == 2
    assert detail["feeds_current"] == 1
    assert detail["feeds_problem"] == 1
    assert detail["feeds_behind"] == 1
    assert (detail["offers_fresh"], detail["offers_stale"]) == (100, 50)
    assert detail["fx_ok"] is True and detail["fx_age_days"] == 1
    assert detail["source_age_hours"] == 2.0
    assert detail["oldest_source_age_hours"] == 5.0
    assert all(isinstance(v, str | int | float | bool) for v in detail.values())
    # Besleme adresi/kimligi taşınmaz.
    assert not any("http" in str(v) for v in detail.values())
