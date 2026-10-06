"""Fiyat istatistikleri ve sahte indirim tespiti. Veritabani gerektirmez.

Sahte indirim tespiti `docs/search.md` tarafindan dogrudan kullaniliyor:
bayrakli urunler "En iyi firsatlar" sekmesinden dusuruluyor. Yanlis pozitif
gercek bir firsati gizler, yanlis negatif sahte indirimi firsat diye sunar —
bu yuzden her iki yon de test ediliyor.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from similarity.prices import Observation, compute, detect_inflated_list_price

START = datetime(2026, 7, 1, tzinfo=UTC)


def series(entries: list[tuple[int, int, int | None]]) -> list[Observation]:
    """(gun, fiyat, liste_fiyati) uclulerinden gozlem listesi."""
    return [
        Observation(observed_at=START + timedelta(days=day), price=price, list_price=listed)
        for day, price, listed in entries
    ]


def one_offer(entries: list[tuple[int, int, int | None]]) -> dict[int, list[Observation]]:
    """Tek teklifli urun. `compute` teklif basina gruplanmis gozlem bekler."""
    return {1: series(entries)}


# --- temel istatistikler ----------------------------------------------------


def test_min_median_max() -> None:
    stats = compute(one_offer([(0, 300, None), (1, 100, None), (2, 200, None)]), current_price=200)
    assert stats.min_90d == 100
    assert stats.max_90d == 300
    assert stats.median_90d == 200


def test_percentile_zero_when_current_is_the_lowest() -> None:
    stats = compute(one_offer([(0, 300, None), (1, 200, None), (2, 100, None)]), current_price=100)
    assert stats.current_percentile == 0


def test_percentile_high_when_current_is_the_highest() -> None:
    stats = compute(one_offer([(0, 100, None), (1, 200, None), (2, 300, None)]), current_price=300)
    assert stats.current_percentile is not None
    assert stats.current_percentile >= 66


def test_thirty_day_window_excludes_older_prices() -> None:
    # En dusuk fiyat 60 gun once; 30 gunluk pencereye girmemeli.
    stats = compute(
        one_offer([(0, 100, None), (45, 500, None), (60, 400, None)]), current_price=400
    )
    assert stats.min_90d == 100
    assert stats.min_30d == 400


def test_drops_are_counted_with_their_last_date() -> None:
    stats = compute(
        one_offer([(0, 500, None), (1, 400, None), (2, 400, None), (3, 300, None)]),
        current_price=300,
    )
    assert stats.drop_count_90d == 2
    assert stats.last_drop_at == START + timedelta(days=3)


def test_empty_history_is_not_an_error() -> None:
    stats = compute({}, current_price=None)
    assert stats.min_90d is None
    assert stats.drop_count_90d == 0
    assert stats.list_price_inflated is False


# --- sahte indirim ----------------------------------------------------------


def test_genuine_discount_is_not_flagged() -> None:
    """Liste fiyati sabit, satis fiyati dusuyor: bu gercek bir indirim."""
    observations = series([(0, 1000, 1100), (5, 1000, 1100), (10, 700, 1100), (15, 700, 1100)])
    inflated, raised_at = detect_inflated_list_price(observations)
    assert inflated is False
    assert raised_at is None


def test_list_price_rise_without_a_drop_is_not_flagged() -> None:
    """Sezon zammi: liste de satis da yukseliyor, indirim yok."""
    observations = series([(0, 1000, 1100), (5, 1000, 1100), (10, 1200, 1500), (20, 1200, 1500)])
    inflated, _ = detect_inflated_list_price(observations)
    assert inflated is False


def test_inflated_list_price_before_a_drop_is_flagged() -> None:
    """Klasik sahte indirim.

    Once liste 1100 (gercek indirim %9), sonra liste 1600'e cikiyor ve fiyat
    dusuyor: vitrinde %44 indirim gorunuyor ama urun 1000'den 900'e inmis.
    """
    observations = series([(0, 1000, 1100), (5, 1000, 1100), (10, 1000, 1600), (15, 900, 1600)])
    inflated, raised_at = detect_inflated_list_price(observations)
    assert inflated is True
    assert raised_at == START + timedelta(days=10)


def test_drop_long_after_the_rise_is_not_flagged() -> None:
    """Yukselisten cok sonra gelen indirim ayri bir olaydir."""
    observations = series([(0, 1000, 1100), (5, 1000, 1600), (60, 900, 1600), (61, 900, 1600)])
    inflated, _ = detect_inflated_list_price(observations)
    assert inflated is False


def test_small_rise_is_not_enough() -> None:
    """%15'in altindaki yukselis normal dalgalanma sayilir."""
    observations = series([(0, 1000, 1100), (5, 1000, 1180), (10, 950, 1180)])
    inflated, _ = detect_inflated_list_price(observations)
    assert inflated is False


def test_compute_surfaces_the_flag_and_the_date() -> None:
    observations = series([(0, 1000, 1100), (5, 1000, 1100), (10, 1000, 1600), (15, 900, 1600)])
    stats = compute({1: observations}, current_price=900)
    assert stats.list_price_inflated is True
    assert stats.list_price_raised_at == START + timedelta(days=10)


def test_too_few_observations_cannot_be_judged() -> None:
    inflated, _ = detect_inflated_list_price(series([(0, 1000, 1100), (1, 900, 1600)]))
    assert inflated is False


# --- teklif basina ayrim ----------------------------------------------------


def test_two_merchants_do_not_fake_a_list_price_jump() -> None:
    """Regresyon: farkli magazalarin serileri karistirilmamali.

    Ilk surum tum tekliflerin gozlemlerini tek bir zaman serisine
    karistiriyordu. A magazasinin liste fiyati 57.300, B'ninki 73.100 olunca
    aradaki gecis %27'lik bir "liste zammi" gibi gorunuyor, ardindan gelen
    herhangi bir dusus sahte indirim ilan ediliyordu. Tohum verisinde 200
    urunun 75'i boyle isaretlenmisti.

    Iki teklif de kendi icinde tamamen durgun; hicbir sahte indirim yok.
    """
    ucuz = series([(0, 54600, 57300), (1, 54800, 57300), (2, 54500, 57300), (3, 45300, 57300)])
    pahali = series([(0, 69600, 73100), (1, 69600, 73100), (2, 69600, 73100), (3, 69600, 73100)])

    stats = compute({1: ucuz, 2: pahali}, current_price=45300)
    assert stats.list_price_inflated is False


def test_inflation_in_one_offer_flags_the_product() -> None:
    """Bir teklifte bile sahte indirim varsa urun isaretlenir.

    Kullanici o teklifi gorecek; urunu temiz gostermek yaniltici olur.
    """
    temiz = series([(0, 1000, 1100), (5, 1000, 1100), (10, 950, 1100)])
    sisirilmis = series([(0, 2000, 2200), (5, 2000, 2200), (10, 2000, 3200), (15, 1800, 3200)])

    stats = compute({1: temiz, 2: sisirilmis}, current_price=950)
    assert stats.list_price_inflated is True


def test_drop_count_is_the_deepest_offer_not_the_sum() -> None:
    """Uc magaza ayni gun indirim yapinca "3 kez dustu" demek yaniltici."""
    a = series([(0, 500, None), (1, 400, None)])
    b = series([(0, 900, None), (1, 800, None)])
    c = series([(0, 700, None), (1, 600, None), (2, 500, None)])

    stats = compute({1: a, 2: b, 3: c}, current_price=400)
    # Toplam 4 olurdu; en cok dusen teklif 2 dusus yapti.
    assert stats.drop_count_90d == 2


def test_unordered_offers_still_produce_ordered_statistics() -> None:
    """min/medyan/max tum teklifler uzerinden, magazadan bagimsiz."""
    a = series([(0, 300, None), (1, 100, None)])
    b = series([(0, 900, None), (1, 500, None)])

    stats = compute({1: a, 2: b}, current_price=100)
    assert stats.min_90d == 100
    assert stats.max_90d == 900
    assert stats.current_percentile == 0


# --- degisim olayi modeli (karar 0065) ---------------------------------------------


NOW = datetime(2026, 10, 1, tzinfo=UTC)
WINDOW_START = NOW - timedelta(days=90)


def events(entries: list[tuple[int, int]]) -> list[Observation]:
    """(NOW'dan kac gun once, fiyat) -> yalnizca DEGISIM olaylari."""
    return [
        Observation(observed_at=NOW - timedelta(days=ago), price=price, list_price=None)
        for ago, price in entries
    ]


def test_median_is_duration_weighted_not_event_weighted() -> None:
    """80 gun 100 TL, son 10 gun 200 TL: medyan 100'dur. Olaylar esit sayilsaydi
    (100 ve 200) medyan 150 cikardi."""
    by_offer = {1: events([(80, 100), (10, 200)])}

    stats = compute(by_offer, 200, seen_until={1: NOW}, since=WINDOW_START)

    assert stats.median_90d == 100
    assert stats.min_90d == 100
    assert stats.max_90d == 200


def test_unchanged_price_without_new_events_is_still_in_the_window() -> None:
    """Tek olay 80 gun once: teklif hala goruluyor; fiyat pencerenin her gununde gecerli."""
    by_offer = {1: events([(80, 500)])}

    stats = compute(by_offer, 500, seen_until={1: NOW}, since=WINDOW_START)

    assert (stats.min_30d, stats.min_90d, stats.median_90d, stats.max_90d) == (500, 500, 500, 500)


def test_series_ends_at_last_seen_so_a_vanished_offer_is_not_carried_forever() -> None:
    cheap_vanished = events([(60, 50)])
    live = events([(60, 300)])

    stats = compute(
        {1: cheap_vanished, 2: live},
        300,
        # 1. teklif 40 gun once son kez goruldu; 2. teklif bugun goruldu.
        seen_until={1: NOW - timedelta(days=40), 2: NOW},
        since=WINDOW_START,
    )

    # Ucuz teklif yalnizca goruldugu ~20 gunde var; son 30 gunun cogunda yok.
    assert stats.min_90d == 50
    assert stats.min_30d == 300


def test_drops_use_real_event_times_not_daily_samples() -> None:
    by_offer = {1: events([(40, 300), (20, 200), (5, 250)])}

    stats = compute(by_offer, 250, seen_until={1: NOW}, since=WINDOW_START)

    assert stats.drop_count_90d == 1
    assert stats.last_drop_at == NOW - timedelta(days=20)


def test_without_seen_until_every_observation_counts_equally() -> None:
    """Geriye uyum: seen_until verilmezse eski (gunluk gozlem) davranisi."""
    stats = compute({1: events([(80, 100), (10, 200)])}, 200)
    assert stats.median_90d == 150
