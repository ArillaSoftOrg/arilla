"""URL normalizasyonu — Katman 2'nin idempotentligi buna dayanir."""

from __future__ import annotations

import pytest

from collect.link.urls import InvalidUrl, normalize


def test_tracking_parameters_do_not_change_identity() -> None:
    """Ayni urun, farkli izleme parametreleri -> AYNI external_id.

    Bu tutmazsa ayni urun her paylasimda kataloga yeniden girer.
    """
    variants = [
        "https://magaza.example/urun/deri-canta",
        "https://www.magaza.example/urun/deri-canta?utm_source=instagram&utm_medium=story",
        "https://magaza.example/urun/deri-canta?fbclid=abc123",
        "https://magaza.example/urun/deri-canta/#yorumlar",
        "https://magaza.example/urun/deri-canta?ref=partner&gclid=xyz",
    ]
    identities = {normalize(url).external_id for url in variants}
    assert identities == {"/urun/deri-canta"}

    domains = {normalize(url).domain for url in variants}
    assert domains == {"magaza.example"}


def test_meaningful_parameters_are_kept_and_sorted() -> None:
    """Varyant secen parametreler kimligin parcasidir, atilamaz."""
    a = normalize("https://magaza.example/p?renk=siyah&beden=38")
    b = normalize("https://magaza.example/p?beden=38&renk=siyah")
    assert a.external_id == b.external_id == "/p?beden=38&renk=siyah"

    farkli = normalize("https://magaza.example/p?beden=40&renk=siyah")
    assert farkli.external_id != a.external_id


def test_tracking_prefixes_are_dropped_but_similar_names_kept() -> None:
    result = normalize("https://magaza.example/p?utm_campaign=x&utmostcare=1")
    assert result.external_id == "/p?utmostcare=1"


def test_normalized_url_is_fetchable() -> None:
    # `www.` kimlikten duser ama getirilen adreste kalir: apeks alan adi
    # cozulmeyen magazalar var (docs/decisions/0035).
    result = normalize("https://WWW.Magaza.Example/urun/canta?utm_source=x#alt")
    assert result.url == "https://www.magaza.example/urun/canta"
    assert result.domain == "magaza.example"
    assert result.external_id == "/urun/canta"


@pytest.mark.parametrize(
    "raw",
    ["ftp://magaza.example/x", "magaza.example/x", "https:///urun", "https://localhost/x"],
)
def test_invalid_urls_are_rejected(raw: str) -> None:
    with pytest.raises(InvalidUrl):
        normalize(raw)


def test_non_default_port_is_preserved() -> None:
    """Standart disi portta servis edilen sayfa, portsuz adreste YOKTUR.

    Bu, sahte istemcili testlerin yakalayamadigi, gercek bir kosuda ortaya
    cikan bir hataydi: port dusunce hem robots.txt hem sayfa yanlis adresten
    isteniyordu.
    """
    result = normalize("http://127.0.0.1:8099/urun/deri-canta?utm_source=x")
    assert result.url == "http://127.0.0.1:8099/urun/deri-canta"
    assert result.origin == "http://127.0.0.1:8099"
    # merchant.domain porta bagli degildir: ayni magaza, ayni alan adi.
    assert result.domain == "127.0.0.1"
    assert result.external_id == "/urun/deri-canta"


def test_default_ports_are_not_written_out() -> None:
    assert normalize("https://magaza.example:443/p").origin == "https://magaza.example"
    assert normalize("http://magaza.example:80/p").origin == "http://magaza.example"
