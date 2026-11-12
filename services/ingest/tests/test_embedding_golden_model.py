"""Karar 0186: altin vektor kanaryasi CANLI model sunucusuna karsi (normal CI'da calismaz).

Gercek model/TEI ister; sahte basari gostermemek icin ortam yoksa ATLANIR (gecti sayilmaz):

    EMBED_CANARY_LIVE=1 EMBED_QWEN3_06B_URL=http://127.0.0.1:18080 \
        python -m pytest -m model tests/test_embedding_golden_model.py
"""

from __future__ import annotations

import os

import pytest

from enrich.canary import golden_path, load_golden, require_canary, threshold_of
from enrich.providers import build_text_provider
from enrich.registry import registry

pytestmark = pytest.mark.model

LIVE = os.environ.get("EMBED_CANARY_LIVE") == "1"
REMOTE = sorted(s.id for s in registry().models.values() if s.provider == "remote_http")


@pytest.mark.parametrize("model_id", REMOTE)
def test_live_server_matches_official_reference(model_id: str) -> None:
    spec = registry().get(model_id)
    assert spec.endpoint is not None
    url_env = spec.endpoint["url_env"]
    if not LIVE or not os.environ.get(url_env):
        pytest.skip(f"canli sunucu yok (EMBED_CANARY_LIVE=1 ve {url_env} gerekli)")
    if not golden_path(model_id).is_file():
        pytest.fail(f"{model_id}: altin dosya yok; once enrich.golden_build")
    threshold_of(load_golden(model_id))  # olculmemis esik -> CanaryFailed (fail-closed)
    result = require_canary(spec, lambda purpose: build_text_provider(spec, purpose=purpose))
    assert result.passed and result.min_cosine is not None
