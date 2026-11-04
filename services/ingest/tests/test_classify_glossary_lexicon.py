"""Glossary -> lexicon kopru satirlari (karar 0172, Faz 3)."""

from __future__ import annotations

from pathlib import Path

import psycopg
import pytest

from classify.glossary_lexicon import (
    GROUP_PREFIX,
    GlossaryEntry,
    SynonymRow,
    inflected_family,
    plan,
    read_glossary,
    read_manifest,
    write_manifest,
)
from db.connection import database_url


def g(stem: str, *phrases: str) -> GlossaryEntry:
    return GlossaryEntry(stem, tuple(phrases))


def surfaces(rows: list[SynonymRow], group: str) -> set[str]:
    return {r.surface for r in rows if r.normalized == group}


def test_inflected_family_keeps_only_inflections() -> None:
    words = ["kablo", "kablolar", "kablosu", "kablosuz", "kablolu"]
    assert inflected_family(words) == ["kablo", "kablolar", "kablosu"]
    assert inflected_family(["ayakkabi", "ayakkabilik", "ayakkabilari"]) == [
        "ayakkabi",
        "ayakkabilari",
    ]


def test_antonym_derivation_never_joins_the_wireless_group() -> None:
    # "kablosuz" (wireless) govdeyi paylasir ama yapim ekidir: kablo -> wireless olmamali.
    existing = {"kablosuz": "kablosuz", "wireless": "kablosuz"}
    result = plan(
        [g("kablo", "cable", "wire")], ["Kablolar", "Kablosuz Kulaklık", "Kablo"], existing
    )
    assert all(r.normalized != "kablosuz" for r in result.rows)
    assert surfaces(result.rows, f"{GROUP_PREFIX}kablo") == {"kablo", "kablolar", "cable", "wire"}


def test_joins_existing_group_only_through_a_turkish_anchor() -> None:
    existing = {"kilif": "kilif", "case": "kilif", "cover": "kilif"}
    result = plan(
        [g("kilif", "case", "cover", "sleeve"), g("kapak", "cover", "cap", "lid")],
        ["Telefon Kılıfı", "Kılıf", "Kılıfları", "Kapak", "Kapakları"],
        existing,
    )
    # Inflected form joins the existing group via the Turkish word.
    assert "kılıfları" in surfaces(result.rows, "kilif")
    # kapak must NOT reach kilif through the English word "cover".
    assert not any(r.surface.startswith("kapak") and r.normalized == "kilif" for r in result.rows)
    assert surfaces(result.rows, f"{GROUP_PREFIX}kapak") == {"kapak", "kapakları", "cap", "lid"}


def test_english_word_under_two_stems_is_dropped() -> None:
    result = plan(
        [g("ayakk", "shoe", "boot"), g("botla", "boot")],
        ["Ayakkabı", "Botlar"],
        {},
    )
    assert "boot" not in {r.surface for r in result.rows}
    assert surfaces(result.rows, f"{GROUP_PREFIX}ayakk") == {"ayakkabı", "shoe"}


def test_generic_and_unmatched_stems_are_skipped() -> None:
    result = plan([g("seti", "~"), g("zzzzz", "nothing")], ["Kahve Seti"], {})
    assert result.rows == []
    assert result.stats["generic_skipped"] == 1
    assert result.stats["no_turkish_word"] == 1


def test_existing_surfaces_are_never_rewritten_and_plan_is_idempotent() -> None:
    first = plan([g("panto", "trouser", "pants")], ["Pantolon", "Pantolonu"], {})
    existing = {r.surface.lower(): r.normalized for r in first.rows}
    second = plan([g("panto", "trouser", "pants")], ["Pantolon", "Pantolonu"], existing)
    assert second.rows == []


def test_turkish_words_in_two_groups_skip_the_stem() -> None:
    # Govde = ilk 5 harf: "kalem" ve "kalemi" ayni govdede, ama iki ayri gruptalar.
    result = plan([g("kalem", "pen")], ["Kalem", "Kalemi"], {"kalem": "a", "kalemi": "b"})
    assert result.rows == []
    assert result.stats["multi_group_skipped"] == 1


def test_manifest_round_trip(tmp_path: Path) -> None:
    rows = [SynonymRow("pantolon", "glossary:panto"), SynonymRow("trousers", "glossary:panto")]
    path = tmp_path / "manifest.tsv"
    write_manifest(path, rows)
    assert read_manifest(path) == rows


def test_repository_glossary_parses() -> None:
    entries = read_glossary()
    assert len(entries) > 500
    assert all(e.stem and e.phrases for e in entries)


@pytest.mark.integration
def test_dry_run_against_local_database_writes_nothing() -> None:
    from classify import glossary_lexicon

    try:
        conn = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM lexicon")
            before = cur.fetchone()[0]  # type: ignore[index]
        report = glossary_lexicon.apply(conn, write=False)
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM lexicon")
            after = cur.fetchone()[0]  # type: ignore[index]
    assert before == after
    assert report.inserted == []
    assert all(r.normalized for r in report.rows)
