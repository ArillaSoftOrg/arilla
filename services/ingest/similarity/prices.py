"""`product_price_stats` hesabi ve sahte indirim tespiti.

Istek yolu fiyat gecmisini ASLA taramaz (`architecture.md` §3b); yalnizca bu
tabloyu okur. Gece toplu isi tabloyu doldurur.

Bu modulun en hassas parcasi `list_price_inflated`. `docs/search.md` o bayragi
tasiyan urunleri "En iyi firsatlar" sekmesinden **dusuruyor** — yani yanlis
pozitif gercek bir firsati gizler, yanlis negatif sahte indirimi firsat diye
sunar. Ikisi de pahali, o yuzden esikler sabit ve belgelenmis.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

#: Liste fiyati bu orandan fazla yukseldiyse "belirgin yukselis" sayilir.
LIST_PRICE_JUMP_RATIO = 1.15

#: Yukselisten sonra satis fiyatinin dusmesi icin taninan pencere.
DROP_WINDOW = timedelta(days=21)

#: Gorunen indirim, yukselis oncesi gercek indirimden bu kadar puan buyukse
#: sisirme sayilir. Kucuk dalgalanmalari sahte indirim ilan etmemek icin var.
APPARENT_DISCOUNT_GAIN = 0.10


@dataclass(frozen=True)
class Observation:
    observed_at: datetime
    price: int
    list_price: int | None


@dataclass(frozen=True)
class PriceStats:
    min_30d: int | None
    min_90d: int | None
    max_90d: int | None
    median_90d: int | None
    current_percentile: int | None
    drop_count_90d: int
    last_drop_at: datetime | None
    list_price_inflated: bool
    list_price_raised_at: datetime | None


def _median(values: list[int]) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) // 2


def _percentile_of(current: int, values: list[int]) -> int | None:
    """Guncel fiyatin dagilimdaki yeri. 0 = son 90 gunun en dusugu."""
    if not values:
        return None
    below = sum(1 for value in values if value < current)
    return round(100 * below / len(values))


def detect_inflated_list_price(
    observations: list[Observation],
) -> tuple[bool, datetime | None]:
    """Liste fiyati indirimden hemen once yukseltilmis mi?

    Aranan orunt: liste fiyati belirgin bicimde yukseliyor, kisa sure sonra
    satis fiyati dusuyor ve GORUNEN indirim, yukselisten onceki gercek
    indirimden belirgin bicimde buyuyor.

    Yalnizca liste fiyatinin yukselmesi yetmez (sezon zammi olabilir), ve
    yalnizca fiyatin dusmesi de yetmez (gercek indirim). Sahte indirimi
    tanimlayan sey ikisinin ARDISIKLIGIDIR.
    """
    with_list = [item for item in observations if item.list_price and item.price]
    if len(with_list) < 3:
        return False, None

    for index in range(1, len(with_list)):
        previous, current = with_list[index - 1], with_list[index]
        assert previous.list_price and current.list_price

        if current.list_price < previous.list_price * LIST_PRICE_JUMP_RATIO:
            continue

        # Yukselisten ONCEKI gercek indirim.
        before = 1 - (previous.price / previous.list_price)

        deadline = current.observed_at + DROP_WINDOW
        for later in with_list[index:]:
            if later.observed_at > deadline:
                break
            if later.price >= current.price:
                continue
            assert later.list_price
            apparent = 1 - (later.price / later.list_price)
            if apparent - before >= APPARENT_DISCOUNT_GAIN:
                return True, current.observed_at

    return False, None


def count_drops(observations: list[Observation]) -> tuple[int, datetime | None]:
    """TEK BIR TEKLIFIN serisindeki fiyat dususleri."""
    drops = 0
    last_drop: datetime | None = None
    for index in range(1, len(observations)):
        if observations[index].price < observations[index - 1].price:
            drops += 1
            last_drop = observations[index].observed_at
    return drops, last_drop


def compute(by_offer: dict[int, list[Observation]], current_price: int | None) -> PriceStats:
    """Bir urunun istatistikleri, TEKLIF BASINA gruplanmis gozlemlerden.

    **Neden teklif basina.** Bir urunun birden fazla magazada teklifi olur ve
    her magazanin kendi fiyat/liste serisi vardir. Hepsini tek bir zaman
    serisine karistirmak hayali sicramalar uretir: A magazasinin liste fiyati
    57.300, B'ninki 73.100 ise, aralarindaki gecis %27'lik bir "liste zammi"
    gibi gorunur ve ardindan gelen herhangi bir dusus sahte indirim ilan
    edilir. Ilk surum bunu yapiyordu ve 200 urunun 75'ini isaretliyordu.

    Sirasiz istatistikler (min/medyan/max/yuzdelik) tum teklifler uzerinden
    hesaplanir — "bu urun en ucuz ne zaman kacti" sorusu magazadan bagimsiz.
    SIRAYA BAGLI olanlar (dusus sayisi, sahte indirim) teklif basina hesaplanip
    urune toplanir.
    """
    series = [items for items in by_offer.values() if items]
    if not series:
        return PriceStats(None, None, None, None, None, 0, None, False, None)

    observations = sorted(
        (item for items in series for item in items), key=lambda item: item.observed_at
    )
    newest = observations[-1].observed_at
    window_30 = newest - timedelta(days=30)

    prices = [item.price for item in observations]
    prices_30 = [item.price for item in observations if item.observed_at >= window_30]

    # Dusus sayisi tekliflerin EN COK dusenidir, toplami degil: uc magaza
    # ayni gun indirim yapinca "3 kez dustu" demek yaniltici olur.
    drops = 0
    last_drop: datetime | None = None
    inflated = False
    raised_at: datetime | None = None

    for items in series:
        offer_drops, offer_last = count_drops(items)
        if offer_drops > drops:
            drops = offer_drops
        if offer_last and (last_drop is None or offer_last > last_drop):
            last_drop = offer_last

        offer_inflated, offer_raised = detect_inflated_list_price(items)
        if offer_inflated:
            # Bir teklifte bile sahte indirim varsa urun isaretlenir:
            # kullanici o teklifi gorecek.
            inflated = True
            if raised_at is None or (offer_raised and offer_raised > raised_at):
                raised_at = offer_raised

    reference = current_price if current_price is not None else prices[-1]

    return PriceStats(
        min_30d=min(prices_30) if prices_30 else None,
        min_90d=min(prices),
        max_90d=max(prices),
        median_90d=_median(prices),
        current_percentile=_percentile_of(reference, prices),
        # SMALLINT; teorik olarak tasabilir, kirpiyoruz.
        drop_count_90d=min(drops, 32000),
        last_drop_at=last_drop,
        list_price_inflated=inflated,
        list_price_raised_at=raised_at,
    )
