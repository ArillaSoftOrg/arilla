"""Elle indirilen model dizininin sabit revizyonla ayni oldugunu dogrular (karar 0186).

CPU cikarim servisi (TEI) modeli INDIRMEZ; operator dizini bir kez, sabit revizyonla indirir:

    hf download <repo> --revision <source.revision> --local-dir /opt/arilla/models/<dizin>

`huggingface_hub` her dosya icin `.cache/huggingface/download/<dosya>.metadata` yazar:
1. satir commit (revizyon), 2. satir etag. Buyuk (LFS) dosyalarda etag dosyanin SHA-256'sidir.
Bu modul:
- her meta kaydin revizyonunun kayit defterindekiyle AYNI oldugunu,
- LFS dosyalarinin SHA-256'sinin etag ile ayni oldugunu (bozuk/degistirilmis agirlik yok),
- metasi olmayan agirlik dosyasi bulunmadigini denetler.

Ag ya da agir bagimlilik yoktur; ingest imajinda da calisir:

    python -m enrich.model_files --model qwen3-embedding-0.6b-97b0c614 --dir /opt/arilla/models/...

Turetilmis dizin (E4): kaynak yalniz pickle agirlik verdiginde (`pytorch_model.bin`) dizin
`enrich.convert_safetensors` ile uretilir ve `derived-manifest.json` tasir. O zaman HF meta kaydi
yoktur; dogrulama manifestledir (`verify_derived`):
- manifestin model kimligi, kaynak revizyonu ve kaynak agirlik SHA-256'si kayit defteriyle ayni,
- dizindeki HER dosya manifestte ve SHA-256'si ayni (fazla ya da eksik dosya yok),
- pickle bicimli agirlik (`.bin`, `.pt`, `.pth`, `.pkl`, `.ckpt`) YOK, en az bir `.safetensors` var.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

from enrich.registry import RegistryError, load_registry

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_WEIGHT_SUFFIXES = (".safetensors", ".bin", ".onnx", ".onnx_data", ".pt")
#: Yuklenirken kod calistirabilen (pickle) bicimler: turetilmis dizinde bulunamaz.
_PICKLE_SUFFIXES = (".bin", ".pt", ".pth", ".pkl", ".ckpt")
DERIVED_MANIFEST = "derived-manifest.json"


class ModelFilesError(RuntimeError):
    """Model dizini sabit revizyonla dogrulanamadi."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_snapshot(directory: Path, revision: str) -> dict[str, str]:
    """Dosya -> dogrulama ozeti ('rev' ya da 'rev+sha256'). Herhangi bir sorun -> hata."""
    meta_root = directory / ".cache" / "huggingface" / "download"
    if not meta_root.is_dir():
        raise ModelFilesError(f"{directory}: indirme meta verisi yok (hf download --local-dir?)")
    checked: dict[str, str] = {}
    for meta in sorted(meta_root.rglob("*.metadata")):
        relative = meta.relative_to(meta_root).as_posix().removesuffix(".metadata")
        lines = meta.read_text(encoding="utf-8").splitlines()
        if len(lines) < 2:
            raise ModelFilesError(f"{relative}: meta kaydi bozuk")
        commit, etag = lines[0].strip(), lines[1].strip()
        if commit != revision:
            raise ModelFilesError(f"{relative}: revizyon {commit[:12]}, beklenen {revision[:12]}")
        target = directory / relative
        if not target.is_file():
            raise ModelFilesError(f"{relative}: meta var, dosya yok")
        if _SHA256.match(etag):
            actual = _sha256(target)
            if actual != etag:
                raise ModelFilesError(f"{relative}: SHA-256 {actual[:12]} != {etag[:12]}")
            checked[relative] = "rev+sha256"
        else:
            checked[relative] = "rev"
    weights = [
        p.relative_to(directory).as_posix()
        for p in directory.rglob("*")
        if p.is_file() and p.suffix in _WEIGHT_SUFFIXES and ".cache" not in p.parts
    ]
    if not weights:
        raise ModelFilesError(f"{directory}: agirlik dosyasi yok")
    unverified = [w for w in weights if checked.get(w) != "rev+sha256"]
    if unverified:
        raise ModelFilesError(f"SHA-256 ile dogrulanmamis agirlik: {unverified}")
    return checked


def verify_derived(directory: Path, spec_id: str, source: dict[str, object]) -> dict[str, str]:
    """`derived-manifest.json` ile dogrulama. Donus: dosya -> 'sha256'. Sorun -> hata."""
    import json

    path = directory / DERIVED_MANIFEST
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ModelFilesError(f"{path.name}: okunamadi ({type(error).__name__})") from error
    if not isinstance(manifest, dict) or manifest.get("format") != 1:
        raise ModelFilesError(f"{path.name}: bicim 1 degil")
    if manifest.get("model_id") != spec_id:
        raise ModelFilesError(f"manifest modeli {manifest.get('model_id')!r}, beklenen {spec_id!r}")
    origin = manifest.get("source") or {}
    if not isinstance(origin, dict):
        raise ModelFilesError("manifest source nesne degil")
    for key, expected in (
        ("revision", source.get("revision")),
        ("file", source.get("weights_file")),
        ("sha256", source.get("weights_sha256")),
    ):
        if not expected:
            raise ModelFilesError(f"kayit defterinde source.{key} karsiligi yok")
        if origin.get(key) != expected:
            raise ModelFilesError(f"manifest source.{key} kayit defteriyle uyusmuyor")
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        raise ModelFilesError("manifestte dosya listesi yok")
    present = {
        p.relative_to(directory).as_posix()
        for p in directory.rglob("*")
        if p.is_file() and p.name != DERIVED_MANIFEST
    }
    extra = sorted(present - set(files))
    missing = sorted(set(files) - present)
    if extra or missing:
        raise ModelFilesError(f"manifest disi dosya {extra}, eksik dosya {missing}")
    pickles = sorted(f for f in present if f.endswith(_PICKLE_SUFFIXES))
    if pickles:
        raise ModelFilesError(f"turetilmis dizinde pickle agirlik var: {pickles}")
    if not any(f.endswith(".safetensors") for f in present):
        raise ModelFilesError("turetilmis dizinde safetensors agirlik yok")
    checked: dict[str, str] = {}
    for relative, digest in sorted(files.items()):
        if not isinstance(digest, str) or not _SHA256.match(digest):
            raise ModelFilesError(f"{relative}: manifest ozeti gecersiz")
        if _sha256(directory / relative) != digest:
            raise ModelFilesError(f"{relative}: SHA-256 manifestle uyusmuyor")
        checked[relative] = "sha256"
    return checked


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m enrich.model_files")
    parser.add_argument("--model", required=True)
    parser.add_argument("--dir", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        spec = load_registry().get(args.model)
        revision = spec.source.get("revision")
        if not revision:
            raise ModelFilesError(f"{spec.id}: kayit defterinde revizyon yok (API modeli?)")
        if (args.dir / DERIVED_MANIFEST).is_file():
            checked = verify_derived(args.dir, spec.id, dict(spec.source))
            print(
                f"{spec.id}: turetilmis dizin, {len(checked)} dosya manifestle dogrulandi "
                f"(kaynak revizyon {str(revision)[:12]}, pickle yok)"
            )
            return 0
        checked = verify_snapshot(args.dir, str(revision))
    except (ModelFilesError, RegistryError) as error:
        print(f"HATA: {error}", file=sys.stderr)
        return 1
    strong = sum(1 for v in checked.values() if v == "rev+sha256")
    print(
        f"{spec.id}: {len(checked)} dosya revizyon {str(revision)[:12]} ile dogrulandi "
        f"({strong} agirlik dosyasi SHA-256 ile)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
