"""Pickle agirligi dogrulanmis kaynaktan safetensors'a donusturur (E4, karar 0191 taslagi).

Neden: BGE-M3'un sabit revizyonunda (5617a9f6) yalniz `pytorch_model.bin` (pickle) vardir. Pickle
yuklemek kod calistirabilir; uretimdeki cikarim servisine yalniz safetensors (tensor, kod yok)
verilir. HF'deki topluluk donusum PR'lari (SFconvertbot) depo sahibince birlestirilmedigi icin
KULLANILMAZ; donusumu kendimiz, yalitilmis ortamda yapariz.

    docker run --rm --network none --read-only --tmpfs /tmp \
      -v <snapshot>:/src:ro -v <cikti>:/out -v <services/ingest>:/code:ro -e PYTHONPATH=/code \
      e4-convert python -m enrich.convert_safetensors \
        --model bge-m3-5617a9f6 --src /src --out /out --hf-tree /src-tree/tree.json

Fail-closed adimlar:
1. Kaynak agirligin SHA-256'si kayit defterindeki `source.weights_sha256` ile ayni olmali.
2. `--hf-tree` (HF API agac listesi; operator sabit revizyon icin indirir) verilirse her kopyalanan
   kucuk dosya git blob ozetiyle, LFS dosyasi SHA-256 ile dogrulanir.
3. `torch.load(weights_only=True)`: kisitli unpickler, rastgele kod calistirmaz.
4. Yazilan safetensors yeniden okunur; her tensor ad, sekil, tip ve BIT DUZEYINDE esit olmali.
5. `derived-manifest.json`: kaynak (depo, revizyon, dosya, SHA-256), cikti dosyalarinin SHA-256'si,
   tensor sayisi ve arac surumleri. Uretimde `python -m enrich.model_files` bunu dogrular.

torch yalniz bu komutta gerekir (tembel ice aktarim); ingest imajinda yoktur ve gerekmez.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from enrich.registry import RegistryError, load_registry

MANIFEST = "derived-manifest.json"
MANIFEST_FORMAT = 1
OUTPUT_WEIGHTS = "model.safetensors"
#: Cikarim icin gereken pickle-disi dosyalar (TEI + sentence-transformers duzeni). Yoksa atlanir.
COPY_FILES = (
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "sentencepiece.bpe.model",
    "modules.json",
    "sentence_bert_config.json",
    "config_sentence_transformers.json",
    "1_Pooling/config.json",
)


class ConversionError(RuntimeError):
    """Donusum ya da dogrulama basarisiz; cikti kullanilmaz."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_blob_sha1(path: Path) -> str:
    data = path.read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data, usedforsecurity=False).hexdigest()


def load_hf_tree(path: Path) -> dict[str, dict[str, Any]]:
    """HF `api/models/<repo>/tree/<rev>?recursive=true` listesi -> yol -> oge."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ConversionError("hf agac listesi JSON dizi olmali")
    return {str(item["path"]): item for item in raw if isinstance(item, dict) and "path" in item}


def verify_against_tree(path: Path, relative: str, tree: Mapping[str, Mapping[str, Any]]) -> str:
    """Dosya HF agacindaki kayitla ayni mi? Donus: 'lfs-sha256' ya da 'git-sha1'."""
    item = tree.get(relative)
    if item is None:
        raise ConversionError(f"{relative}: HF agacinda yok")
    size = path.stat().st_size
    if int(item.get("size", -1)) != size:
        raise ConversionError(f"{relative}: boyut {size}, HF {item.get('size')}")
    lfs = item.get("lfs")
    if isinstance(lfs, dict) and lfs.get("oid"):
        if sha256_file(path) != lfs["oid"]:
            raise ConversionError(f"{relative}: SHA-256 HF LFS kaydiyla uyusmuyor")
        return "lfs-sha256"
    if git_blob_sha1(path) != item.get("oid"):
        raise ConversionError(f"{relative}: git blob ozeti HF kaydiyla uyusmuyor")
    return "git-sha1"


def output_hashes(out: Path) -> dict[str, str]:
    files: dict[str, str] = {}
    for path in sorted(p for p in out.rglob("*") if p.is_file()):
        relative = path.relative_to(out).as_posix()
        if relative == MANIFEST or relative.endswith(".tmp"):
            continue
        files[relative] = sha256_file(path)
    return files


#: torch tipi -> safetensors tip kodu (yalniz bu modellerde gorulenler; bilinmeyen tip reddedilir).
SAFETENSORS_DTYPES = {
    "torch.float32": "F32",
    "torch.float16": "F16",
    "torch.bfloat16": "BF16",
    "torch.int64": "I64",
    "torch.int32": "I32",
    "torch.uint8": "U8",
    "torch.bool": "BOOL",
}


def safetensors_header(
    items: list[tuple[str, str, list[int], int]], metadata: Mapping[str, str]
) -> bytes:
    """(ad, tip kodu, sekil, bayt) listesinden 8 bayta hizali baslik (uzunluk oneki dahil)."""
    header: dict[str, Any] = {"__metadata__": dict(metadata)}
    offset = 0
    for name, dtype, shape, nbytes in items:
        header[name] = {"dtype": dtype, "shape": shape, "data_offsets": [offset, offset + nbytes]}
        offset += nbytes
    raw = json.dumps(header, separators=(",", ":")).encode("utf-8")
    raw += b" " * ((8 - len(raw) % 8) % 8)
    return len(raw).to_bytes(8, "little") + raw


def write_safetensors(path: Path, state: Mapping[str, Any], metadata: Mapping[str, str]) -> None:
    """Akisli yazici: once baslik, sonra tensorler sirayla. Bellek tepesi tek tensor kadar.

    `safetensors.torch.save_file` tum tensorlerin bayt kopyasini ayni anda tutar (2,3 GB model
    icin ~2,3 GB ek bellek); kucuk dizustu VM'de OOM. Bicim resmi okuyucuyla ayrica dogrulanir.
    """
    import torch  # tembel: yalniz donusum ortaminda

    names = sorted(str(k) for k in state)
    items = []
    for name in names:
        tensor = state[name]
        dtype = SAFETENSORS_DTYPES.get(str(tensor.dtype))
        if dtype is None:
            raise ConversionError(f"{name}: desteklenmeyen tip {tensor.dtype}")
        items.append((name, dtype, list(tensor.shape), tensor.numel() * tensor.element_size()))
    with path.open("wb") as f:
        f.write(safetensors_header(items, metadata))
        for name, _, _, nbytes in items:
            tensor = state[name].detach().contiguous()
            data = tensor.reshape(-1).view(torch.uint8).numpy().tobytes()
            if len(data) != nbytes:
                raise ConversionError(f"{name}: {len(data)} bayt, beklenen {nbytes}")
            f.write(data)
            del data
        f.flush()
        os.fsync(f.fileno())


def convert(model_id: str, src: Path, out: Path, *, hf_tree: Path | None = None) -> dict[str, Any]:
    spec = load_registry().get(model_id)
    source = dict(spec.source)
    weights_file = source.get("weights_file")
    expected = source.get("weights_sha256")
    revision = source.get("revision")
    if not weights_file or not expected or not revision:
        raise ConversionError(
            f"{model_id}: kayit defterinde weights_file/weights_sha256/revision yok"
        )
    weights = src / str(weights_file)
    if not weights.is_file():
        raise ConversionError(f"{weights}: kaynak agirlik yok")
    actual = sha256_file(weights)
    if actual != expected:
        raise ConversionError(f"kaynak SHA-256 {actual[:12]} != kayit {str(expected)[:12]}")
    tree = load_hf_tree(hf_tree) if hf_tree is not None else None
    if tree is not None:
        verify_against_tree(weights, str(weights_file), tree)

    if out.exists() and any(out.iterdir()):
        raise ConversionError(f"{out}: cikti dizini bos degil (uzerine yazilmaz)")
    out.mkdir(parents=True, exist_ok=True)

    import safetensors  # tembel: yalniz donusum ortaminda
    import torch
    from safetensors import safe_open

    # mmap: tensorler dosyaya bagli kalir; bellek tepesi en buyuk tek tensor kadardir.
    state = torch.load(weights, map_location="cpu", weights_only=True, mmap=True)
    if not isinstance(state, Mapping) or not state:
        raise ConversionError("kaynak bir tensor sozlugu degil")
    for name, value in state.items():
        if not isinstance(value, torch.Tensor):
            raise ConversionError(f"{name}: tensor degil ({type(value).__name__})")
    target = out / OUTPUT_WEIGHTS
    tmp = out / (OUTPUT_WEIGHTS + ".tmp")
    write_safetensors(tmp, state, metadata={"format": "pt", "source_sha256": actual})
    os.replace(tmp, target)

    # Dogrulama RESMI okuyucuyla (bicim hatasini da yakalar), tensor tensor.
    params = 0
    dtypes: dict[str, int] = {}
    with safe_open(str(target), framework="pt") as reader:
        if set(reader.keys()) != {str(k) for k in state}:
            raise ConversionError("yeniden okunan tensor adlari kaynakla ayni degil")
        for name, original in state.items():
            copy = reader.get_tensor(str(name))
            if copy.dtype != original.dtype or tuple(copy.shape) != tuple(original.shape):
                raise ConversionError(f"{name}: tip/sekil farkli")
            if not torch.equal(copy, original):
                raise ConversionError(f"{name}: degerler bit duzeyinde esit degil")
            params += original.numel()
            dtypes[str(original.dtype)] = dtypes.get(str(original.dtype), 0) + 1
            del copy
    tensors = state

    copied: dict[str, str] = {}
    for relative in COPY_FILES:
        path = src / relative
        if not path.is_file():
            continue
        if tree is not None:
            copied[relative] = verify_against_tree(path, relative, tree)
        else:
            copied[relative] = "unverified"
        destination = out / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)

    manifest = {
        "format": MANIFEST_FORMAT,
        "model_id": spec.id,
        "source": {
            "repo": source.get("repo"),
            "revision": revision,
            "file": weights_file,
            "sha256": actual,
            "files_verified": copied,
        },
        "outputs": {"weights": OUTPUT_WEIGHTS},
        "files": output_hashes(out),
        "tensors": {"count": len(tensors), "parameters": params, "dtypes": dtypes},
        "equality": "bitwise",
        "converter": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "safetensors": safetensors.__version__,
            "load": "torch.load(weights_only=True)",
        },
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    (out / MANIFEST).write_text(json.dumps(manifest, indent=1, sort_keys=True), encoding="utf-8")
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m enrich.convert_safetensors")
    parser.add_argument("--model", required=True)
    parser.add_argument("--src", type=Path, required=True, help="sabit revizyon dizini")
    parser.add_argument("--out", type=Path, required=True, help="bos cikti dizini")
    parser.add_argument("--hf-tree", type=Path, default=None, help="HF agac listesi (JSON)")
    args = parser.parse_args(argv)
    try:
        manifest = convert(args.model, args.src, args.out, hf_tree=args.hf_tree)
    except (ConversionError, RegistryError) as error:
        print(f"HATA: {error}", file=sys.stderr)
        return 1
    print(
        f"{manifest['model_id']}: {manifest['tensors']['count']} tensor, "
        f"{manifest['tensors']['parameters']} parametre, bit duzeyinde esit; "
        f"{len(manifest['files'])} dosya manifestte"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
