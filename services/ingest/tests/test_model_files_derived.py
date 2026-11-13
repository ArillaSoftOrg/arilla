"""Turetilmis (safetensors) model dizini dogrulamasi ve donusturucunun torch'suz parcalari (E4)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from enrich import convert_safetensors as conv
from enrich.model_files import DERIVED_MANIFEST, ModelFilesError, verify_derived

SOURCE = {
    "repo": "BAAI/bge-m3",
    "revision": "5617a9f61b028005a4858fdac845db406aefb181",
    "weights_file": "pytorch_model.bin",
    "weights_sha256": "b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38",
}
MODEL = "bge-m3-5617a9f6"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_dir(tmp_path: Path, **override) -> Path:
    files = {
        "model.safetensors": b"\x08" * 64,
        "config.json": b"{}",
        "1_Pooling/config.json": b"{}",
    }
    for name, data in files.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_bytes(data)
    manifest = {
        "format": 1,
        "model_id": MODEL,
        "source": {
            "revision": SOURCE["revision"],
            "file": SOURCE["weights_file"],
            "sha256": SOURCE["weights_sha256"],
        },
        "files": {name: sha(data) for name, data in files.items()},
    }
    manifest.update(override)
    (tmp_path / DERIVED_MANIFEST).write_text(json.dumps(manifest))
    return tmp_path


def test_valid_derived_dir_passes(tmp_path: Path) -> None:
    checked = verify_derived(make_dir(tmp_path), MODEL, SOURCE)
    assert set(checked) == {"model.safetensors", "config.json", "1_Pooling/config.json"}


def test_registry_pins_source_weights() -> None:
    from enrich.registry import registry

    source = registry().get(MODEL).source
    assert source["weights_sha256"] == SOURCE["weights_sha256"]
    assert source["revision"] == SOURCE["revision"]


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda d: (d / "extra.txt").write_text("x"), "manifest disi"),
        (lambda d: (d / "config.json").write_bytes(b"[1]"), "SHA-256 manifestle"),
        (lambda d: (d / "config.json").unlink(), "eksik dosya"),
    ],
)
def test_tampered_dir_fails(tmp_path: Path, mutate, message) -> None:
    directory = make_dir(tmp_path)
    mutate(directory)
    with pytest.raises(ModelFilesError, match=message):
        verify_derived(directory, MODEL, SOURCE)


def test_pickle_weights_rejected_even_if_listed(tmp_path: Path) -> None:
    directory = make_dir(tmp_path)
    (directory / "pytorch_model.bin").write_bytes(b"pickle")
    manifest = json.loads((directory / DERIVED_MANIFEST).read_text())
    manifest["files"]["pytorch_model.bin"] = sha(b"pickle")
    (directory / DERIVED_MANIFEST).write_text(json.dumps(manifest))
    with pytest.raises(ModelFilesError, match="pickle"):
        verify_derived(directory, MODEL, SOURCE)


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"model_id": "bge-m3"}, "manifest modeli"),
        ({"source": {"revision": "x", "file": "pytorch_model.bin", "sha256": "y"}}, "revision"),
        ({"format": 2}, "bicim"),
    ],
)
def test_manifest_must_match_registry(tmp_path: Path, override, message) -> None:
    with pytest.raises(ModelFilesError, match=message):
        verify_derived(make_dir(tmp_path, **override), MODEL, SOURCE)


def test_safetensors_header_is_aligned_with_contiguous_offsets() -> None:
    header = conv.safetensors_header(
        [("a", "F32", [2, 3], 24), ("b", "I64", [1], 8)], {"format": "pt"}
    )
    length = int.from_bytes(header[:8], "little")
    assert length % 8 == 0 and len(header) == 8 + length
    parsed = json.loads(header[8:].decode().rstrip())
    assert parsed["a"]["data_offsets"] == [0, 24] and parsed["b"]["data_offsets"] == [24, 32]
    assert parsed["__metadata__"] == {"format": "pt"}


def test_tree_verification_uses_git_blob_and_lfs(tmp_path: Path) -> None:
    small = tmp_path / "config.json"
    small.write_bytes(b"{}")
    big = tmp_path / "w.bin"
    big.write_bytes(b"abc")
    tree = {
        "config.json": {"size": 2, "oid": hashlib.sha1(b"blob 2\0{}").hexdigest()},
        "w.bin": {"size": 3, "oid": "x", "lfs": {"oid": sha(b"abc")}},
    }
    assert conv.verify_against_tree(small, "config.json", tree) == "git-sha1"
    assert conv.verify_against_tree(big, "w.bin", tree) == "lfs-sha256"
    big.write_bytes(b"abd")
    with pytest.raises(conv.ConversionError, match="LFS"):
        conv.verify_against_tree(big, "w.bin", tree)
