"""Metin hazirlama v2 (karar 0180): determinizm, kaynak izi, butce, parcalama."""

from __future__ import annotations

import pytest

from enrich import product_text
from enrich.text_prep import (
    PREP_VERSION,
    ProductFields,
    chunk_text,
    estimate_counter,
    prepare_product_text,
    text_hash,
)

WORDS = estimate_counter(1.0)  # 1 karakter = 1 token: sinirlar elle hesaplanabilir


def _count_words(text: str) -> int:
    return len(text.split()) if text else 0


FIELDS = ProductFields(
    title="Kablosuz Mouse M185",
    brand="Logitech",
    model="910-002238",
    category_path=("Bilgisayar", "Çevre Birimleri", "Mouse"),
    attributes={"renk": "Gri", "Bağlantı": ["USB", "2.4 GHz"], "boş": ""},
    description="Uzun ömürlü pil. Kompakt tasarım.",
)


def test_field_order_and_spans_point_at_sources() -> None:
    prepared = prepare_product_text(FIELDS, model="m", max_tokens=10_000, count=WORDS)
    assert prepared.text == (
        "Logitech. Kablosuz Mouse M185. 910-002238. Bilgisayar > Çevre Birimleri > Mouse. "
        "Bağlantı: USB, 2.4 GHz; renk: Gri. Uzun ömürlü pil. Kompakt tasarım."
    )
    assert [s.field for s in prepared.spans] == [
        "brand",
        "title",
        "model",
        "category",
        "attributes",
        "description",
    ]
    by_field = {s.field: prepared.text[s.start : s.end] for s in prepared.spans}
    assert by_field["title"] == "Kablosuz Mouse M185"
    assert by_field["attributes"] == "Bağlantı: USB, 2.4 GHz; renk: Gri"
    assert not prepared.truncated and prepared.version == PREP_VERSION


def test_deterministic_regardless_of_attribute_order() -> None:
    other = ProductFields(
        **{**FIELDS.__dict__, "attributes": {"Bağlantı": ["USB", "2.4 GHz"], "renk": "Gri"}}
    )
    a = prepare_product_text(FIELDS, model="m", max_tokens=500, count=WORDS)
    b = prepare_product_text(other, model="m", max_tokens=500, count=WORDS)
    assert a == b


def test_hash_depends_on_model_version_and_text() -> None:
    assert text_hash("m", "x") == text_hash("m", "x")
    assert (
        len(
            {
                text_hash("m", "x"),
                text_hash("n", "x"),
                text_hash("m", "y"),
                text_hash("m", "x", version=3),
            }
        )
        == 4
    )


def test_placeholder_brand_and_duplicate_model_dropped() -> None:
    fields = ProductFields(title="Apple iPhone 15 MTP03", brand="OEM", model="MTP03")
    prepared = prepare_product_text(fields, model="m", max_tokens=100, count=WORDS)
    assert prepared.text == "Apple iPhone 15 MTP03"


def test_budget_cuts_last_field_at_word_boundary() -> None:
    fields = ProductFields(title="Kablosuz Mouse", description="bir iki üç dört beş altı")
    prepared = prepare_product_text(fields, model="m", max_tokens=3, count=_count_words)
    assert prepared.text == "Kablosuz Mouse. bir"
    assert prepared.truncated and prepared.tokens <= 3
    assert prepared.spans[-1].field == "description"


def test_include_limits_fields() -> None:
    prepared = prepare_product_text(
        FIELDS, model="m", max_tokens=500, count=WORDS, include=("brand", "title")
    )
    assert prepared.text == "Logitech. Kablosuz Mouse M185"


def test_control_characters_and_nfkc() -> None:
    fields = ProductFields(title="Ｍｏｕｓｅ\x00\tKablosuz")
    assert prepare_product_text(fields, model="m", max_tokens=99, count=WORDS).text == (
        "Mouse Kablosuz"
    )


def test_chunks_overlap_and_cover_everything() -> None:
    text = " ".join(f"w{i}" for i in range(10))
    chunks = chunk_text(text, model="m", max_tokens=4, overlap_tokens=1, count=_count_words)
    assert [c.text for c in chunks] == ["w0 w1 w2 w3", "w3 w4 w5 w6", "w6 w7 w8 w9"]
    assert [c.index for c in chunks] == [0, 1, 2]
    assert all(c.tokens <= 4 for c in chunks)
    assert chunks == chunk_text(text, model="m", max_tokens=4, overlap_tokens=1, count=_count_words)
    assert len({c.content_hash for c in chunks}) == 3


def test_chunk_without_overlap_and_oversized_word() -> None:
    chunks = chunk_text("aaaaaa b c", model="m", max_tokens=3, overlap_tokens=0, count=WORDS)
    assert [c.text for c in chunks] == ["aaaaaa", "b c"]


def test_chunk_empty_and_invalid_args() -> None:
    assert chunk_text("   ", model="m", max_tokens=4, overlap_tokens=0, count=WORDS) == []
    with pytest.raises(ValueError):
        chunk_text("x", model="m", max_tokens=4, overlap_tokens=4, count=WORDS)


def test_production_v1_text_unchanged() -> None:
    # Uretim yolu hala v1'dir; bu modul onun ciktisini ve surumunu degistirmez.
    assert product_text.TEXT_VERSION == 1
    assert product_text.build_product_text("Kablosuz Mouse", "Logitech") == (
        "Logitech Kablosuz Mouse"
    )
