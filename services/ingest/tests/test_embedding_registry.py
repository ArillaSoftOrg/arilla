"""Model kayit defteri (karar 0180): sema, secim kurallari, boyut izolasyonu, uyumluluk."""

from __future__ import annotations

import copy
import json

import pytest

from classify.suggest import model as e5
from enrich import client as clip_client
from enrich import product_text, products
from enrich.registry import (
    REGISTRY_PATH,
    RegistryError,
    parse_registry,
    registry,
    require_writable,
    select_model,
)


def _raw() -> dict:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def _model(raw: dict, model_id: str) -> dict:
    return next(m for m in raw["models"] if m["id"] == model_id)


# --- Uyumluluk: kayit defteri mevcut davranisi birebir tasir --------------------------------


def test_product_text_default_matches_production_constants() -> None:
    spec = registry().default("product_text")
    assert spec.id == "jina-embeddings-v3" == products.MODEL
    assert spec.task("passage") == "retrieval.passage" == products.PASSAGE_TASK
    assert spec.task("query") == "retrieval.query"
    assert spec.dimensions == 768 == products.DIMENSIONS
    assert spec.chars_per_token == 2.75 == products.CHARS_PER_TOKEN
    assert spec.preprocessing_version == f"product-text-v{product_text.TEXT_VERSION}"
    assert registry().family(spec).table == "product_text_embedding"


def test_offer_model_matches_clip_client() -> None:
    spec = registry().get(clip_client.MODEL)
    assert spec.dimensions == clip_client.DIMENSIONS
    assert spec.preprocessing_version == "img512-v1"
    assert registry().family(spec).table == "embedding"
    assert set(spec.modalities) == {"image", "text"}


def test_local_e5_entry_matches_verified_onnx_model() -> None:
    spec = registry().get("e5-small-int8-0bcc8ca76950")
    assert spec.id == f"e5-small-int8-{e5.EXPECTED_SHA256[e5.MODEL_FILE][:12]}"
    assert spec.dimensions == e5.DIM
    assert spec.max_input_tokens == e5.MAX_LENGTH
    assert spec.prefix("passage") == e5.PASSAGE_PREFIX
    assert spec.prefix("query") == e5.QUERY_PREFIX
    assert spec.source["revision"] == e5.SOURCE_REVISION


# --- Secim kurallari -----------------------------------------------------------------------


def test_select_defaults_and_env_override() -> None:
    assert select_model("product_text", env={}).id == "jina-embeddings-v3"
    env = {"ENRICH_PRODUCT_TEXT_MODEL": " jina-embeddings-v3 "}
    assert select_model("product_text", env=env).id == "jina-embeddings-v3"


def test_pilot_and_unverified_models_rejected_in_production() -> None:
    with pytest.raises(RegistryError, match="uretimde secilemez"):
        select_model("product_text", requested="e5-small-int8-0bcc8ca76950", env={})
    env = {"ENRICH_PRODUCT_TEXT_MODEL": "e5-small-int8-0bcc8ca76950"}
    with pytest.raises(RegistryError):
        select_model("product_text", env=env)
    assert (
        select_model(
            "product_text", requested="e5-small-int8-0bcc8ca76950", env={}, allow_pilot=True
        ).dimensions
        == 384
    )


def test_disabled_model_never_selectable() -> None:
    with pytest.raises(RegistryError, match="devre disi"):
        select_model("product_text", requested="bge-m3-5617a9f6", env={}, allow_pilot=True)


def test_unknown_model_and_wrong_role_rejected() -> None:
    with pytest.raises(RegistryError, match="kayit defterinde yok"):
        select_model("product_text", requested="qwen3-embedding", env={})
    with pytest.raises(RegistryError, match="rolu icin"):
        select_model("product_text", requested="jina-clip-v2", env={})


# --- Boyut/uzay izolasyonu -----------------------------------------------------------------


@pytest.mark.parametrize(
    "model_id", ["e5-small-int8-0bcc8ca76950", "bge-m3-5617a9f6", "jina-clip-v2"]
)
def test_other_spaces_cannot_write_product_text_table(model_id: str) -> None:
    with pytest.raises(RegistryError):
        require_writable(registry().get(model_id), products.INDEX_FAMILY)


def test_family_without_table_is_not_writable() -> None:
    # Tablosu olmayan bir aile (ornek: migration'i henuz gelmemis yeni boyut) yazilamaz.
    raw = _raw()
    raw["index_families"]["product_text_halfvec1024"]["table"] = None
    reg = parse_registry(raw)
    spec = reg.get("bge-m3-5617a9f6")
    with pytest.raises(RegistryError, match="migration gerekli"):
        require_writable(spec, spec.index_family, reg=reg)


def test_1024_family_writes_its_own_table() -> None:
    # Migration 0114 (karar 0195): BGE-M3 ve Qwen3 ayni 1024 tablosuna, `model_version` ile
    # ayrilarak yazar.
    for model_id in ("bge-m3-5617a9f6", "qwen3-embedding-0.6b-97b0c614"):
        spec = registry().get(model_id)
        require_writable(spec, spec.index_family)
        assert registry().family(spec).table == "product_text_embedding_d1024"


def test_384_family_writes_its_own_table() -> None:
    spec = registry().get("e5-small-int8-0bcc8ca76950")
    require_writable(spec, spec.index_family)
    assert registry().family(spec).table == "product_text_embedding_d384"


def test_production_model_writable() -> None:
    require_writable(registry().default("product_text"), products.INDEX_FAMILY)


def test_fake_suffix_maps_to_base_spec() -> None:
    assert registry().spec_for_version("jina-embeddings-v3-fake").id == "jina-embeddings-v3"
    assert registry().spec_for_version("something-else") is None


# --- Sema dogrulamasi ----------------------------------------------------------------------


def test_unknown_field_rejected() -> None:
    raw = _raw()
    _model(raw, "bge-m3-5617a9f6")["gpu"] = True
    with pytest.raises(RegistryError, match="bilinmeyen alan"):
        parse_registry(raw)


def test_missing_field_rejected() -> None:
    raw = _raw()
    del _model(raw, "bge-m3-5617a9f6")["normalization"]
    with pytest.raises(RegistryError, match="eksik alan"):
        parse_registry(raw)


def test_dimension_must_match_family() -> None:
    raw = _raw()
    _model(raw, "bge-m3-5617a9f6")["dimensions"] = 768
    with pytest.raises(RegistryError, match="boyut"):
        parse_registry(raw)


def test_duplicate_id_rejected() -> None:
    raw = _raw()
    raw["models"].append(copy.deepcopy(_model(raw, "bge-m3-5617a9f6")))
    with pytest.raises(RegistryError, match="cift kimlik"):
        parse_registry(raw)


def test_default_must_be_production_ready() -> None:
    raw = _raw()
    raw["defaults"]["product_text"] = "e5-small-int8-0bcc8ca76950"
    with pytest.raises(RegistryError, match="uretime hazir"):
        parse_registry(raw)


def test_two_families_cannot_share_a_table() -> None:
    raw = _raw()
    raw["index_families"]["copy"] = dict(raw["index_families"]["product_text_halfvec768"])
    with pytest.raises(RegistryError, match="ayni tabloyu"):
        parse_registry(raw)


def test_fake_suffix_reserved() -> None:
    raw = _raw()
    _model(raw, "bge-m3-5617a9f6")["id"] = "bge-m3-fake"
    with pytest.raises(RegistryError, match="gecersiz kimlik"):
        parse_registry(raw)


def test_parse_is_deterministic() -> None:
    assert parse_registry(_raw()) == parse_registry(_raw())
