"""Katalog ve kullanici yuklemesi ayni on isleme sozlesmesini kullanir (0034).

Tek kaynak `packages/core/src/embedding/image-preprocess-contract.json`.
TypeScript onu dogrudan import eder; Python sabitleri burada karsilastirilir.
Biri degisip digeri degismezse bu test kirilir.
"""

from __future__ import annotations

import json
from pathlib import Path

from enrich import images

CONTRACT = (
    Path(__file__).resolve().parents[3]
    / "packages/core/src/embedding/image-preprocess-contract.json"
)


def test_enrich_constants_match_shared_contract() -> None:
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    assert contract["version"] == images.PREPROCESS_VERSION
    assert contract["target_long_edge"] == images.TARGET_LONG_EDGE
    assert contract["max_source_pixels"] == images.MAX_SOURCE_PIXELS
    assert contract["jpeg_quality"] == images.JPEG_QUALITY
    assert contract["tile_edge"] == images.TILE_EDGE
    assert contract["tokens_per_tile"] == images.TOKENS_PER_TILE
    assert {fmt.lower() for fmt in images.ALLOWED_FORMATS} == set(contract["allowed_formats"])
