"""Elle indirilen model dizininin sabit revizyonla ayni oldugunu dogrular (karar 0184).

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
