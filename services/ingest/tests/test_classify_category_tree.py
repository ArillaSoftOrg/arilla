"""Trendyol kategori agaci entegrasyonu (karar 0153, migration 0102) siniflandiriciyi DEGISTIRMEZ.

Siniflandirici V5 yalniz `taxonomy.RULES`teki yollara yazar. Entegrasyonla eklenen ~3.862 dugumun
hicbirine kural yoktur: otomatik siniflandirmaya kapalidir. Kuralin tek bir yeni dugume
baglanmasi ayri bir karar ve kural surumu (`RULE_VERSION`) gerektirir.
"""

from __future__ import annotations

from pathlib import Path

import psycopg
import pytest

from classify.taxonomy import RULE_VERSION, all_paths
from db.connection import database_url

BASELINE = (
    Path(__file__).resolve().parents[3] / "docs/reference/categories/manicepte-baseline-158.tsv"
)


def baseline_paths() -> set[str]:
    lines = BASELINE.read_text(encoding="utf-8").splitlines()[1:]
    return {line.split("\t")[0] for line in lines if line.strip()}


def test_siniflandirici_kurallari_yalniz_entegrasyon_oncesi_dugumlere_yazar() -> None:
    """Birim: her kural hedefi, entegrasyondan ONCEKI 158 dugumden biridir."""
    base = baseline_paths()
    assert len(base) == 158
    unknown = sorted(p for p in all_paths() if p not in base)
    # Tohum yollari (test/dev) ve eklenen dugumler olmamali: kural yolu = uretim agaci.
    assert unknown == [], f"kural, tabanda olmayan yola yaziyor: {unknown}"


def test_kural_surumu_degismedi() -> None:
    """Bu PR siniflandirici davranisini degistirmez (kural surumu V5)."""
    assert RULE_VERSION == 5


@pytest.mark.integration
def test_kural_yollari_tabandaki_dugumlere_cozulur_hicbiri_trendyol_ile_olusturulan_degil() -> None:
    from classify.run import Catalog

    try:
        conn = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with conn:
        catalog = Catalog(conn)
        base = baseline_paths()
        # Tum agac yuklenir (kosu basina bir kez, ~4 bin satir) ve yol -> kimlik tektir.
        assert len(catalog.path_by_id) >= 4020
        assert len(catalog.id_by_path) == len({p for p in catalog.path_by_id.values()})
        with conn.cursor() as cur:
            cur.execute(
                """SELECT category_id FROM external_category_map
                    WHERE source = 'trendyol' AND note = 'created'"""
            )
            created = {int(r[0]) for r in cur.fetchall()}
        assert len(created) == 3862
        for path in all_paths():
            category_id = catalog.id_by_path.get(path)
            assert category_id is not None, f"kural yolu agacta yok: {path}"
            assert path in base
            assert category_id not in created, f"kural yeni (olusturulan) dugume yaziyor: {path}"


@pytest.mark.integration
def test_sozluk_kategori_yollari_eksik_degil() -> None:
    from classify import lexicon

    try:
        conn = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with conn:
        report = lexicon.apply(conn, write=False)
    assert report.missing_paths == []
