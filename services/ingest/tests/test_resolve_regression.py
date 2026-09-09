"""B4 regresyon seti — `CLAUDE.md` bunu ZORUNLU kiliyor.

    "Eslestirme mantigi icin regresyon test seti zorunludur — esik
     degistiginde neyin bozuldugu baska turlu gorulemez."

60 cift: 30 eslesme, 30 eslesmeme. Veritabani gerektirmez; dogrudan saf
skorlama fonksiyonlarini surer.

En pahali hata yanlis pozitiftir: `architecture.md` "yanlis 'ayni urun'
iddiasi kullanici guvenini bir kerede yok eder" diyor. O yuzden en sert
iddia `test_no_non_match_reaches_auto_accept`.
"""

from __future__ import annotations

import pytest

from resolve.calibrate import distributions, load_pairs, score_group
from resolve.score import auto_accept_threshold, queue_threshold

MATCHES, NON_MATCHES = distributions()


def test_the_set_is_the_required_size() -> None:
    data = load_pairs()
    assert len(data["should_match"]) == 30
    assert len(data["should_not_match"]) == 30


@pytest.mark.parametrize("scored", MATCHES.scores, ids=lambda s: s.case)
def test_every_true_match_reaches_the_queue(scored) -> None:
    """Hicbir gercek eslesme kuyruk esiginin altina dusmemeli."""
    assert scored.score >= queue_threshold(), (
        f"{scored.case}: {scored.score:.3f} < {queue_threshold()}"
        f"{f' [veto: {scored.veto}]' if scored.veto else ''}"
    )


@pytest.mark.parametrize("scored", NON_MATCHES.scores, ids=lambda s: s.case)
def test_no_non_match_reaches_the_queue(scored) -> None:
    """Hicbir yanlis eslesme insan kuyruguna bile girmemeli."""
    assert scored.score < queue_threshold(), (
        f"{scored.case}: {scored.score:.3f} >= {queue_threshold()}"
    )


@pytest.mark.parametrize("scored", NON_MATCHES.scores, ids=lambda s: s.case)
def test_no_non_match_reaches_auto_accept(scored) -> None:
    """En pahali hata: yanlis bir eslesmenin insan gormeden baglanmasi.

    Bu iddia digerlerinden once bakilir; kuyruk esigi gevsetilse bile bu
    tutmalidir.
    """
    assert scored.score < auto_accept_threshold(), (
        f"YANLIS POZITIF: {scored.case} otomatik kabul edilirdi ({scored.score:.3f})"
    )


def test_thresholds_are_ordered_and_separated() -> None:
    assert queue_threshold() < auto_accept_threshold()
    # Iki grup arasinda gercek bir bosluk olmali; esikler o bosluktan secildi.
    assert NON_MATCHES.maximum < MATCHES.minimum
    assert NON_MATCHES.maximum < queue_threshold() <= MATCHES.minimum


def test_color_mismatch_is_vetoed_not_merely_penalised() -> None:
    """Renk vetosu bu gorevin en kritik kurali.

    `docs/schema.sql`: "product renk duzeyinde kanoniktir: siyah ve bej ayri
    urundur." Skoru dusurmek yetmez — baslik neredeyse ayni oldugu icin
    dusurulmus skor bile esigi gecerdi.
    """
    color_cases = [
        item for item in NON_MATCHES.scores if item.veto and item.veto.startswith("renk")
    ]
    assert len(color_cases) >= 5, "renk vetosu ornekleri sette azalmis"
    assert all(item.score == 0.0 for item in color_cases)


def test_same_gtin_with_different_colour_is_not_a_certain_match() -> None:
    """Magazalar varyantlari tek barkodla yayinlayabiliyor.

    gtin normalde kesin sonuctur ve akis orada durur; renk catisirsa
    durmamali.
    """
    data = load_pairs()
    pair = next(
        item for item in data["should_not_match"] if "gtin ayni renk farkli" in item["case"]
    )
    scored = score_group([pair])[0]
    assert scored.score == 0.0
    assert scored.veto is not None
