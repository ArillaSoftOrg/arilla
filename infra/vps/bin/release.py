#!/usr/bin/env python3
"""Surum (release) yonetimi: sha etiketi + digest sabitleme ve geri alma (karar 0109).

build-push iş akışı her main commit'i için `release-manifest.json` üretir:
{sha, tag, images: {web|migrate|ingest|cron: {image, tag, digest}}, complete}.
Bu araç manifesti VPS'te `compose.env`e uygular (ARILLA_TAG + her imaj için
ARILLA_*_DIGEST) ve geçmişi tutar; böylece bir önceki sürüme dönmek tek komuttur.
Yalnızca dosya yazar: docker/compose ÇAĞIRMAZ, ağa çıkmaz, sır içermez.

    release.py validate <manifest.json> [--sha SHA] [--image-prefix ghcr.io/arillasoftorg/]
    release.py apply <manifest.json> [--dir /opt/arilla] [--image-prefix ghcr.io/arillasoftorg/]
    release.py rollback              [--dir /opt/arilla]
    release.py current               [--dir /opt/arilla]
    release.py list                  [--dir /opt/arilla]

Düzen (--dir altında):
    compose.env              ARILLA_TAG ve *_DIGEST satırları güncellenir (diğer satırlara dokunulmaz)
    releases/<sha>.json      uygulanan her manifestin kopyası (değişmez)
    releases/current         şu an uygulanan sha
    releases/previous        bir önceki sha (rollback hedefi)
    releases/history.log     "<UTC zaman> apply|rollback <sha>"

Doğrulama (uygulamadan önce, başarısızsa HİÇBİR ŞEY değişmez):
    - complete=true, dört imajın dördü de var
    - sha 40 onaltılık, tag == "sha-<sha>"
    - her digest "sha256:<64 onaltılık>"
    - image adı `ghcr.io/<sahip>/arilla-<ad>` biçiminde; `--image-prefix` verilirse tam olarak
      `<önek>arilla-<ad>` (dağıtım motoru yalnızca kendi kuruluşunun GHCR önekini kabul eder)
    - `--sha` verilirse manifestin sha'sı onunla aynı olmalı
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import sys
from pathlib import Path

NAMES = ("web", "migrate", "ingest", "cron")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
IMAGE_RE = re.compile(r"^ghcr\.io/[a-z0-9][a-z0-9._-]*/arilla-(web|migrate|ingest|cron)$")
IMAGE_VAR = {
    "web": "ARILLA_WEB_IMAGE",
    "migrate": "ARILLA_MIGRATE_IMAGE",
    "ingest": "ARILLA_INGEST_IMAGE",
    "cron": "ARILLA_CRON_IMAGE",
}
DIGEST_VAR = {n: f"ARILLA_{n.upper()}_DIGEST" for n in NAMES}


class ReleaseError(Exception):
    pass


def validate(manifest: dict, image_prefix: str | None = None, expect_sha: str | None = None) -> str:
    """Manifesti doğrular, sha'yı döndürür."""
    sha = manifest.get("sha", "")
    if not isinstance(sha, str) or not SHA_RE.match(sha):
        raise ReleaseError("sha 40 haneli onaltılık olmalı")
    if expect_sha is not None and sha != expect_sha:
        raise ReleaseError("manifest sha'sı beklenen sha ile uyuşmuyor")
    if manifest.get("tag") != f"sha-{sha}":
        raise ReleaseError("tag 'sha-<sha>' olmalı (hareketli etiket kabul edilmez)")
    if manifest.get("complete") is not True:
        raise ReleaseError("manifest eksik (complete=false): dört imaj da yayınlanmamış")
    images = manifest.get("images")
    if not isinstance(images, dict) or set(images) != set(NAMES):
        raise ReleaseError(f"images tam olarak {', '.join(NAMES)} içermeli")
    for name in NAMES:
        entry = images[name]
        image = entry.get("image", "")
        if image_prefix is not None:
            if image != f"{image_prefix}arilla-{name}":
                raise ReleaseError(f"{name}: image adı {image_prefix}arilla-{name} olmalı")
        elif not IMAGE_RE.match(image) or not image.endswith(f"arilla-{name}"):
            raise ReleaseError(f"{name}: image adı ghcr.io/<sahip>/arilla-{name} olmalı")
        if entry.get("tag") != f"sha-{sha}":
            raise ReleaseError(f"{name}: tag sha ile uyuşmuyor")
        if not DIGEST_RE.match(entry.get("digest", "")):
            raise ReleaseError(f"{name}: digest sha256:<64 onaltılık> olmalı")
    return sha


def set_env(path: Path, updates: dict[str, str]) -> None:
    """compose.env içinde yalnızca verilen anahtarları günceller/ekler."""
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
        if key in updates:
            if key not in seen:
                out.append(f"{key}={updates[key]}")
                seen.add(key)
            continue  # tekrarlayan satırı at
        out.append(line)
    for key, value in updates.items():
        if key not in seen:
            out.append(f"{key}={value}")
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text("\n".join(out) + "\n", encoding="utf-8")
    shutil.copymode(path, tmp) if path.exists() else tmp.chmod(0o640)
    tmp.replace(path)


def read_pointer(releases: Path, name: str) -> str | None:
    p = releases / name
    return p.read_text(encoding="utf-8").strip() if p.exists() else None


def apply_manifest(root: Path, manifest: dict, action: str, image_prefix: str | None = None) -> str:
    sha = validate(manifest, image_prefix)
    releases = root / "releases"
    releases.mkdir(parents=True, exist_ok=True)

    stored = releases / f"{sha}.json"
    if stored.exists():
        if json.loads(stored.read_text(encoding="utf-8")) != manifest:
            raise ReleaseError(f"{sha}: kayıtlı manifest farklı (değişmez); uygulanmadı")
    else:
        stored.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    updates = {"ARILLA_TAG": f"sha-{sha}"}
    for name in NAMES:
        updates[DIGEST_VAR[name]] = manifest["images"][name]["digest"]
        updates[IMAGE_VAR[name]] = manifest["images"][name]["image"]
    set_env(root / "compose.env", updates)

    current = read_pointer(releases, "current")
    if current != sha:
        if current:
            (releases / "previous").write_text(current + "\n", encoding="utf-8")
        (releases / "current").write_text(sha + "\n", encoding="utf-8")
    with (releases / "history.log").open("a", encoding="utf-8") as log:
        log.write(f"{dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} {action} {sha}\n")
    return sha


def cmd_validate(manifest_path: Path, image_prefix: str | None, expect_sha: str | None) -> int:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    sha = validate(manifest, image_prefix, expect_sha)
    print(f"geçerli: sha-{sha}")
    return 0


def cmd_apply(root: Path, manifest_path: Path, image_prefix: str | None = None) -> int:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    sha = apply_manifest(root, manifest, "apply", image_prefix)
    print(f"uygulandı: sha-{sha}")
    return 0


def cmd_rollback(root: Path) -> int:
    releases = root / "releases"
    current = read_pointer(releases, "current")
    previous = read_pointer(releases, "previous")
    if not previous:
        raise ReleaseError("geri dönülecek önceki sürüm yok")
    manifest = json.loads((releases / f"{previous}.json").read_text(encoding="utf-8"))
    apply_manifest(root, manifest, "rollback")
    # Swap: rollback'in rollback'i (ileri) mümkün olsun.
    if current:
        (releases / "previous").write_text(current + "\n", encoding="utf-8")
    print(f"geri alındı: sha-{previous} (önceki: sha-{current})")
    return 0


def cmd_current(root: Path) -> int:
    releases = root / "releases"
    print(f"current={read_pointer(releases, 'current') or '-'}")
    print(f"previous={read_pointer(releases, 'previous') or '-'}")
    return 0


def cmd_list(root: Path) -> int:
    log = root / "releases" / "history.log"
    print(log.read_text(encoding="utf-8") if log.exists() else "(geçmiş yok)")
    return 0


def main(argv: list[str]) -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--dir", default="/opt/arilla", help="compose.env ve releases/ dizini")
    prefix = argparse.ArgumentParser(add_help=False)
    prefix.add_argument("--image-prefix", default=None, help="izinli imaj öneki, örn. ghcr.io/arillasoftorg/")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("apply", parents=[common, prefix]).add_argument("manifest")
    val = sub.add_parser("validate", parents=[prefix])
    val.add_argument("manifest")
    val.add_argument("--sha", default=None)
    for name in ("rollback", "current", "list"):
        sub.add_parser(name, parents=[common])
    args = parser.parse_args(argv)
    try:
        if args.cmd == "validate":
            return cmd_validate(Path(args.manifest), args.image_prefix, args.sha)
        root = Path(args.dir)
        if args.cmd == "apply":
            return cmd_apply(root, Path(args.manifest), args.image_prefix)
        if args.cmd == "rollback":
            return cmd_rollback(root)
        if args.cmd == "current":
            return cmd_current(root)
        return cmd_list(root)
    except ReleaseError as error:
        print(f"HATA: {error}", file=sys.stderr)
        return 1
    except (OSError, json.JSONDecodeError) as error:
        print(f"HATA: {error.__class__.__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
