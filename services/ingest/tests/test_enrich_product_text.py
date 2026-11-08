"""Urun metin embedding'i: kanonik metin, ozetler, sonuc sozlesmesi ve CLI dogrulamasi (karar 0177).

Veritabani gerektirmez; veritabanli akis `test_enrich_products_db.py`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from enrich import products
from enrich.product_text import (
    MAX_TEXT_CHARS,
    TEXT_VERSION,
    build_product_text,
    content_hash,
    is_placeholder_brand,
    source_hash,
)

# --- kanonik metin --------------------------------------------------------------------------


def test_case_is_preserved_for_english_titles() -> None:
    """`enrich/text.py`'deki I -> ı donusumu Ingilizce basligi bozardi ("IPhone" -> "ıphone")."""
    assert build_product_text("IPhone 15 Silicone Case") == "IPhone 15 Silicone Case"


def test_brand_is_prefixed_only_when_missing_from_title() -> None:
    assert build_product_text("Wireless Mouse", "Logitech") == "Logitech Wireless Mouse"
    assert build_product_text("Logitech M185 Wireless Mouse", "logitech") == (
        "Logitech M185 Wireless Mouse"
    )


def test_turkish_dotted_capital_brand_matches_title() -> None:
    """`İ`.casefold() birlesik nokta birakir; marka basligin icinde oldugu halde eklenmemeli."""
    assert build_product_text("İpek Şal Desenli", "İPEK") == "İpek Şal Desenli"


@pytest.mark.parametrize("brand", ["NoEnName_Null", "OEM", "Generic", "No Brand", "Diğer", "-"])
def test_placeholder_brands_are_not_added(brand: str) -> None:
    assert is_placeholder_brand(brand)
    assert build_product_text("Phone Holder", brand) == "Phone Holder"


def test_real_brand_is_not_placeholder() -> None:
    assert not is_placeholder_brand("Otherland")
    assert not is_placeholder_brand("Nonee")


def test_noise_and_whitespace_are_removed_without_touching_meaningful_words() -> None:
    title = "  2024 New   Gaming Mouse\tFree Shipping  Hot Sale "
    assert build_product_text(title) == "2024 New Gaming Mouse"
    assert build_product_text("Erkek Ayakkabı Ücretsiz Kargo") == "Erkek Ayakkabı"


def test_control_characters_and_compatibility_forms_are_normalized() -> None:
    assert build_product_text("Ｗｉｒｅｌｅｓｓ\u0000Mouse​") == "Wireless Mouse"


def test_empty_inputs_produce_empty_text() -> None:
    assert build_product_text("") == ""
    assert build_product_text("   ", "Logitech") == ""
    assert build_product_text("Free Shipping") == ""


def test_long_titles_are_truncated_on_a_word_boundary() -> None:
    text = build_product_text("word " * 200)
    assert len(text) <= MAX_TEXT_CHARS
    assert text.endswith("word")


def test_content_hash_depends_on_model_version_and_text() -> None:
    base = content_hash("jina-embeddings-v3", "Wireless Mouse")
    assert len(base) == 16
    assert base == content_hash("jina-embeddings-v3", "Wireless Mouse")
    assert base != content_hash("jina-embeddings-v3", "Wireless Mouse ")
    assert base != content_hash("jina-embeddings-v4", "Wireless Mouse")
    assert base != content_hash("jina-embeddings-v3", "Wireless Mouse", TEXT_VERSION + 1)


def test_source_hash_separates_title_and_brand() -> None:
    assert source_hash("ab", "c") != source_hash("a", "bc")
    assert source_hash("x", None) == source_hash("x", "")
    assert len(source_hash("x", None)) == 16


# --- sonuc sozlesmesi (karar 0174) -----------------------------------------------------------


def _counts(**kwargs: object) -> products.ProductCounts:
    counts = products.ProductCounts()
    for key, value in kwargs.items():
        setattr(counts, key, value)
    return counts


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({"locked": True, "candidates": 5}, ("skipped_locked", "lock_busy")),
        ({"aborted": True, "written": 0, "candidates": 5}, ("failed", "provider_errors")),
        ({"aborted": True, "written": 3, "candidates": 5}, ("partial", "provider_errors")),
        ({"wal_stopped": "arsiv", "candidates": 5}, ("partial", "wal_backpressure")),
        ({"interrupted": True, "candidates": 5}, ("partial", "interrupted")),
        ({"rejected": 1, "candidates": 5}, ("partial", "item_errors")),
        ({"failed": 2, "candidates": 5}, ("partial", "item_errors")),
        ({"candidates": 0}, ("no_input", "up_to_date")),
        ({"budget_stopped": True, "candidates": 5}, ("completed", "token_budget_reached")),
        ({"limit_reached": True, "candidates": 5}, ("completed", "limit_reached")),
        ({"candidates": 5, "written": 5}, ("completed", None)),
    ],
)
def test_outcome_priority(kwargs: dict, expected: tuple[str, str | None]) -> None:
    assert products.decide_outcome(_counts(**kwargs)) == expected


def test_every_outcome_is_part_of_the_contract() -> None:
    from db import job_run

    for name in ("skipped_locked", "failed", "partial", "no_input", "completed"):
        assert name in job_run.OUTCOMES


# --- yardimcilar ve CLI --------------------------------------------------------------------


def test_vector_literal_is_compact_and_parsable() -> None:
    literal = products.vector_literal([0.123456789, -1e-06, 0.5])
    assert literal == "[0.12346,-1e-06,0.5]"


def test_estimate_tokens_uses_measured_ratio() -> None:
    assert products.estimate_tokens("x" * 130) == 48
    assert products.estimate_tokens("") == 1


def test_read_ids_skips_comments_and_rejects_garbage(tmp_path: Path) -> None:
    good = tmp_path / "ids.txt"
    good.write_text("# pilot A\n12\n\n7  # yorum\n12\n", encoding="utf-8")
    assert products.read_ids(good) == [12, 7, 12]

    bad = tmp_path / "bad.txt"
    bad.write_text("12\nabc\n", encoding="utf-8")
    with pytest.raises(ValueError, match="bad.txt:2"):
        products.read_ids(bad)


def test_real_execution_requires_token_ceiling(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("JINA_API_KEY", "test-key")
    assert products.main(["--execute"]) == 2
    assert "--max-tokens" in capsys.readouterr().err


def test_real_execution_requires_api_key(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("JINA_API_KEY", raising=False)
    assert products.main(["--execute", "--max-tokens", "1000"]) == 2
    assert "JINA_API_KEY" in capsys.readouterr().err


@pytest.mark.parametrize(
    "argv",
    [
        ["--limit", "0"],
        ["--batch-size", "0"],
        ["--batch-size", "4096"],
        ["--after-id", "10", "--until-id", "5"],
        ["--max-tokens", "0"],
    ],
)
def test_invalid_arguments_are_rejected_before_touching_the_database(argv: list[str]) -> None:
    assert products.main(argv) == 2


def test_fake_client_refuses_remote_database(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@db.example.com:5432/x")
    assert products.main(["--fake-client", "--execute"]) == 2
