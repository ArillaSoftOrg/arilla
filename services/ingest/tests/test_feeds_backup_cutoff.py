"""Gunluk beslemenin yedek penceresi kesmesi (karar 0188): saf zaman hesabi, veritabani yok."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from catalog_build import auto
from feeds import daily
from feeds.daily import DEFAULT_BACKUP_MARGIN, seconds_until_backup_cutoff

IST = ZoneInfo("Europe/Istanbul")
MARGIN = DEFAULT_BACKUP_MARGIN


def at(hh: int, mm: int, day: int = 12) -> datetime:
    return datetime(2026, 11, day, hh, mm, tzinfo=UTC)


def test_pencere_katalog_hattiyla_ayni() -> None:
    # Iki is ayni yedek penceresini korur; biri degisip digeri unutulmasin.
    assert daily.BACKUP_WINDOW_UTC == auto.BACKUP_WINDOW_UTC


@pytest.mark.parametrize(
    ("now", "expected_min"),
    [
        (at(21, 30), 140),  # gece kosusu 00:30 TR -> kesme 23:50 UTC (02:50 TR)
        (at(22, 15), 95),  # alternatif 01:15 TR
        (at(18, 30), 320),  # eski aksam kosusu: 4 sa butce zaten kisa, etkisiz
        (at(6, 30), 1040),  # sabah kosusu: kesme ertesi 23:50, butce (240 dk) gecerli
        (at(2, 5), 1305),  # pencere bitti: bir sonraki kesme bu gece 23:50
    ],
)
def test_kesmeye_kalan_sure(now: datetime, expected_min: int) -> None:
    assert seconds_until_backup_cutoff(now, MARGIN) == expected_min * 60


@pytest.mark.parametrize(
    "now", [at(23, 50), at(23, 59), at(0, 30, 13), at(1, 20, 13), at(2, 4, 13)]
)
def test_kesme_ile_pencere_sonu_arasi_yeni_besleme_yok(now: datetime) -> None:
    # Gecikmis ya da Persistent yakalama kosusu yedekle cakismaz: hicbir yeni besleme baslamaz.
    assert seconds_until_backup_cutoff(now, MARGIN) == 0.0


def test_turkiye_saati_girdisi_utc_ile_ayni() -> None:
    tr = datetime(2026, 11, 13, 0, 30, tzinfo=IST)  # 00:30 TR = 12 Kasim 21:30 UTC
    utc = seconds_until_backup_cutoff(at(21, 30), MARGIN)
    assert seconds_until_backup_cutoff(tr, MARGIN) == utc


def test_pay_sifir_ise_kesme_pencere_baslangici() -> None:
    assert seconds_until_backup_cutoff(at(1, 0), timedelta(0)) == 20 * 60
    assert seconds_until_backup_cutoff(at(1, 20), timedelta(0)) == 0.0


def test_ay_ve_yil_devri() -> None:
    new_year_eve = datetime(2026, 12, 31, 21, 30, tzinfo=UTC)
    assert seconds_until_backup_cutoff(new_year_eve, MARGIN) == 140 * 60
    new_year = datetime(2027, 1, 1, 0, 10, tzinfo=UTC)
    assert seconds_until_backup_cutoff(new_year, MARGIN) == 0.0


def test_en_kotu_durum_gece_kosusu_yedege_tasmaz() -> None:
    # Gece kosusu 21:30 UTC + en fazla 5 dk rastgele gecikme. Kesmeden hemen once baslayan en
    # buyuk besleme (feed 7: 14 gunde en uzun 75 dk) bitse bile yedek penceresi (01:20)
    # acilmamis olur.
    latest_start = at(21, 35)
    cutoff = latest_start + timedelta(seconds=seconds_until_backup_cutoff(latest_start, MARGIN))
    worst_end = cutoff + timedelta(minutes=75)
    assert worst_end < at(1, 20, 13), worst_end


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        (at(21, 30), at(1, 20, 13)),  # gece kosusu: ertesi 01:20
        (at(1, 0, 13), at(1, 20, 13)),  # pencereden once
        (at(1, 30, 13), at(1, 20, 13)),  # pencere icinde: icinde bulunulan pencere
        (at(2, 5, 13), at(1, 20, 14)),  # pencere bitti: ertesi gun
        (at(6, 30, 13), at(1, 20, 14)),  # sabah kosusu
    ],
)
def test_sonraki_yedek_penceresi(now: datetime, expected: datetime) -> None:
    assert daily.next_backup_window_start(now) == expected


def test_sert_durak_kesmeden_sonra_pencereden_once() -> None:
    # Kesme (23:50) yeni besleme acmayi durdurur; sert durak (01:15) baslamis birlestirmeyi
    # parca sinirinda birakir; yedek 01:20'de pencereyi bos bulur.
    window = daily.next_backup_window_start(at(21, 30))
    stop = window - daily.BACKUP_HARD_STOP
    cutoff = at(21, 30) + timedelta(seconds=seconds_until_backup_cutoff(at(21, 30), MARGIN))
    assert cutoff < stop < window
    assert stop == at(1, 15, 13)


def test_duraklatilan_besleme_hata_sayilmaz_ertelenir() -> None:
    from feeds.runner import FeedOutcome

    final = {
        7: FeedOutcome(7, "failed", error_code=daily.PAUSED_CODE),
        14: FeedOutcome(14, "success"),
        17: FeedOutcome(17, "failed", error_code="download_failed"),
    }
    assert daily.pop_paused(final) == [7]
    assert sorted(final) == [14, 17]  # gercek hata (17) sonuclarda kalir
