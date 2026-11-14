#!/usr/bin/env python3
"""Migration oncesi dokumlerin (pre-migrate-*.dump) yasam dongusu (karar 0187). Yalniz stdlib; ROOT ile.

    pre_migrate_dumps.py capacity --db-bytes N            # migration oncesi disk denetimi (0 yeter / 2 yetmez)
    pre_migrate_dumps.py begin  --dump P --deploy-id ID --sha SHA --migrations-file F
    pre_migrate_dumps.py finish --dump P                  # boyut + SHA-256 + icindekiler (TOC) dogrulamasi
    pre_migrate_dumps.py set-status --dump P --status S   # migrated | success | failed
    pre_migrate_dumps.py verify (--newest | --file AD) [--full] [--state]
    pre_migrate_dumps.py report [--json]                  # koruma / silme adayi raporu (SILMEZ)
    pre_migrate_dumps.py adopt [--confirm]                # metadatasi olmayan eski dokumlere metadata (gunlukten)
    pre_migrate_dumps.py prune [--confirm] [--only AD ...]
    pre_migrate_dumps.py auto-prune --dump P              # yalniz arilla-deploy, basarili migration'dan sonra

Kurallar (kullanici karari, 12 Kasim 2026; otomatik silme 14 Kasim 2026, karar 0194):
- Basarili deploy'un dogrulanmis (SHA-256 + tam veri okumasi) en yeni 2 dokumu KORUNUR.
- Basarisiz, yarim kalmis ya da metadatasi olmayan dokum ASLA silme adayi olmaz.
- Elle silme: `prune --confirm`; once her adayin ve korunan iki dokumun SHA-256'sini yeniden hesaplar ve
  tam veri okumasi yapar, dosya degismisse durur.
- Otomatik silme (karar 0194): YALNIZ basarili migration deploy'unun sonunda, deploy kilidi altinda
  `auto-prune`. Once yeni dokum tam okunur; okunamazsa hicbir sey silinmez. Korunanlar tam okunur, adaylarin
  boyutu ve SHA-256'si denetlenir. Kapatmak icin: `state/dump-auto-prune.off` dosyasi.
- Tablo sayisinin azalmasi bozulma sayilmaz (mesru sema degisikligi); TOC'ta veri olmasi ve
  `schema_migration` verisinin bulunmasi aranir.
- "Tam veri okumasi" (`pg_restore -f /dev/null`) arsivin her veri blogunu acar; GERCEK bir
  PostgreSQL'e geri yukleme KANITI DEGILDIR.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

NAME_RE = re.compile(r"^pre-migrate-(\d{8})-(\d{6})-([0-9a-f]{12})\.dump$")
KEEP = 2
GiB = 1 << 30
#: Disk tabani: yedekleme provasiyla ayni (karar 0183); gunluk besleme indirmesi 20 GiB ister.
DEFAULT_RESERVE = 30 * GiB
#: Tahmin payi: son dokumun boyutu x 1,15 (veritabani buyur); hic dokum yoksa veritabaninin %20'si.
GROWTH = 1.15
FIRST_RATIO = 0.20
#: Otomatik katalog hattinin baslangic esigi (GiB; catalog-auto-guard START_FREE_GB, karar 0164).
#: Dokumden sonra bos alan bunun altina dusecekse migration deploy'u DURUR (karar 0188): yayin sessizce
#: durmasin, karar deploy aninda verilsin. Bilincli istisna: ARILLA_DEPLOY_ALLOW_BELOW_CATALOG_GATE=1.
CATALOG_GATE_GIB = 70
STATUSES = ("dumping", "created", "migrated", "success", "failed", "dump_failed")

Runner = Callable[..., tuple[int, str]]


def default_runner(cmd: list[str], stdin_path: Path | None = None, timeout: int = 7200) -> tuple[int, str]:
    try:
        if stdin_path is None:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        else:
            with open(stdin_path, "rb") as fh:
                p = subprocess.run(cmd, stdin=fh, capture_output=True, text=True, timeout=timeout, check=False)
        return p.returncode, p.stdout + p.stderr
    except (OSError, subprocess.TimeoutExpired) as error:
        return 127, str(error)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Dumps:
    def __init__(self, root: Path, run: Runner = default_runner, disk_usage=shutil.disk_usage):
        self.root = root
        self.dir = root / "backups"
        self.state = root / "state"
        self.run = run
        self.disk_usage = disk_usage

    # ------------------------------------------------------------------ yollar ve metadata
    def safe_path(self, name: str) -> Path:
        """Yalniz backups/ altindaki duzenli `pre-migrate-*.dump`; sembolik baglanti ve tasan yol reddedilir."""
        if not NAME_RE.fullmatch(name):
            raise ValueError(f"gecersiz dokum adi: {name!r}")
        path = self.dir / name
        if path.is_symlink() or Path(str(path) + ".meta.json").is_symlink():
            raise ValueError(f"sembolik baglanti reddedildi: {name}")
        if self.dir.is_symlink():
            raise ValueError("backups dizini sembolik baglanti olamaz")
        real = Path(os.path.realpath(path))
        if real.parent != Path(os.path.realpath(self.dir)):
            raise ValueError(f"backups disina tasan yol: {name}")
        if path.exists() and not stat.S_ISREG(os.lstat(path).st_mode):
            raise ValueError(f"duzenli dosya degil: {name}")
        return path

    @staticmethod
    def meta_path(path: Path) -> Path:
        return Path(str(path) + ".meta.json")

    def read_meta(self, path: Path) -> dict | None:
        try:
            return json.loads(self.meta_path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def write_meta(self, path: Path, meta: dict) -> None:
        mp = self.meta_path(path)
        if mp.is_symlink():
            raise ValueError("metadata sembolik baglanti olamaz")
        tmp = Path(str(mp) + ".tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(mp)

    def files(self) -> list[Path]:
        if not self.dir.is_dir():
            return []
        return sorted(p for p in self.dir.iterdir() if NAME_RE.fullmatch(p.name) and not p.is_symlink())

    # ------------------------------------------------------------------ olcum
    @staticmethod
    def sha256(path: Path) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for block in iter(lambda: fh.read(4 << 20), b""):
                h.update(block)
        return h.hexdigest()

    def postgres_image(self) -> str | None:
        rc, out = self.run(["docker", "compose", "--env-file", str(self.root / "compose.env"), "-f",
                            str(self.root / "compose.prod.yml"), "ps", "-q", "postgres"], None, 60)
        cid = out.strip().splitlines()[0] if rc == 0 and out.strip() else ""
        if not cid:
            return None
        rc, out = self.run(["docker", "inspect", "-f", "{{.Config.Image}}", cid], None, 60)
        return out.strip() if rc == 0 and out.strip() else None

    def pg_restore(self, path: Path, *args: str, timeout: int = 7200) -> tuple[int, str]:
        """Yalitilmis tek seferlik konteyner (ag yok, 1 CPU, 512 MB, salt okunur); dokum STDIN'den."""
        image = self.postgres_image()
        if not image:
            return 127, "postgres imaji bulunamadi"
        return self.run(["docker", "run", "--rm", "-i", "--network", "none", "--cpus", "1", "-m", "512m",
                         "--read-only", "--entrypoint", "pg_restore", image, *args], path, timeout)

    @staticmethod
    def parse_toc(text: str) -> dict:
        lines = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith(";")]
        data = [ln for ln in lines if " TABLE DATA " in ln]
        return {"entries": len(lines), "table_data": len(data),
                "has_schema_migration": any(re.search(r"TABLE DATA \S+ schema_migration\b", ln) for ln in data)}

    @staticmethod
    def toc_problem(toc: dict) -> str | None:
        """Bozulma isareti: TOC bos, veri yok ya da migration defteri yok. Tablo sayisi KIYASLANMAZ."""
        if toc["entries"] == 0:
            return "icindekiler bos"
        if toc["table_data"] == 0:
            return "tablo verisi yok"
        if not toc["has_schema_migration"]:
            return "schema_migration verisi yok"
        return None

    # ------------------------------------------------------------------ kapasite
    def estimate(self, db_bytes: int) -> int:
        sizes = [p.stat().st_size for p in self.files()[-KEEP:]]
        return int(max(sizes) * GROWTH) if sizes else int(db_bytes * FIRST_RATIO)

    def capacity(self, db_bytes: int, reserve: int = DEFAULT_RESERVE, catalog_gate: int | None = None,
                 allow_below_gate: bool = False) -> dict:
        self.dir.mkdir(parents=True, exist_ok=True)
        free = self.disk_usage(str(self.dir)).free
        est = self.estimate(db_bytes)
        need = est + reserve
        gate = CATALOG_GATE_GIB * GiB if catalog_gate is None else catalog_gate
        gate_ok = free - est >= gate
        return {"free": free, "estimate": est, "reserve": reserve, "need": need,
                "catalog_gate": gate, "catalog_gate_ok": gate_ok, "allow_below_gate": allow_below_gate,
                "ok": free >= need and (gate_ok or allow_below_gate)}

    # ------------------------------------------------------------------ yasam dongusu
    def begin(self, path: Path, deploy_id: str, sha: str, migrations: list[str]) -> dict:
        meta = {"version": 1, "file": path.name, "deploy_id": deploy_id, "sha": sha,
                "migrations": migrations, "created_at": now_iso(), "size": None, "sha256": None,
                "toc": None, "status": "dumping", "verify": {"full_read": None}, "legacy": False,
                "history": [{"at": now_iso(), "status": "dumping"}]}
        self.write_meta(path, meta)
        return meta

    def finish(self, path: Path) -> tuple[bool, dict]:
        meta = self.read_meta(path) or {}
        if not path.exists() or path.stat().st_size == 0:
            return False, self._status(path, meta, "dump_failed", reason="dokum bos ya da yok")
        rc, out = self.pg_restore(path, "-l", timeout=1800)
        toc = self.parse_toc(out) if rc == 0 else {"entries": 0, "table_data": 0, "has_schema_migration": False}
        problem = "pg_restore -l basarisiz" if rc != 0 else self.toc_problem(toc)
        meta.update({"size": path.stat().st_size, "sha256": self.sha256(path), "toc": toc})
        if problem:
            return False, self._status(path, meta, "dump_failed", reason=problem)
        return True, self._status(path, meta, "created")

    def _status(self, path: Path, meta: dict, status: str, reason: str | None = None) -> dict:
        if status not in STATUSES:
            raise ValueError(status)
        meta["status"] = status
        meta["status_at"] = now_iso()
        meta.setdefault("history", []).append({"at": now_iso(), "status": status, **({"reason": reason} if reason else {})})
        if reason:
            meta["reason"] = reason
        self.write_meta(path, meta)
        return meta

    def set_status(self, path: Path, status: str) -> dict:
        meta = self.read_meta(path)
        if meta is None:
            raise ValueError(f"metadata yok: {path.name}")
        # Geri alma yolundaki "failed", daha bilgili durumu ezmez (dump_failed nedeni, tamamlanan success).
        if status == "failed" and meta.get("status") in ("dump_failed", "success"):
            return meta
        return self._status(path, meta, status)

    def verify(self, path: Path, full: bool) -> dict:
        """SHA-256 metadatayla ayni mi + (istenirse) tum veri bloklarini ac. Metadataya yazar."""
        meta = self.read_meta(path)
        if meta is None:
            return {"file": path.name, "ok": False, "reason": "metadata yok"}
        result: dict = {"file": path.name, "at": now_iso(), "size_ok": path.stat().st_size == meta.get("size")}
        result["sha256_ok"] = bool(meta.get("sha256")) and self.sha256(path) == meta.get("sha256")
        if full:
            started = time.monotonic()
            rc, out = self.pg_restore(path, "-f", "/dev/null")
            result["full_read"] = {"ok": rc == 0, "at": now_iso(), "seconds": round(time.monotonic() - started, 1),
                                   **({} if rc == 0 else {"error": out.strip()[-300:]})}
            meta.setdefault("verify", {})["full_read"] = result["full_read"]
        meta.setdefault("verify", {})["sha256_ok"] = result["sha256_ok"]
        meta["verify"]["sha256_at"] = result["at"]
        self.write_meta(path, meta)
        result["ok"] = result["size_ok"] and result["sha256_ok"] and (not full or result["full_read"]["ok"])
        return result

    # ------------------------------------------------------------------ siniflandirma
    def classify(self) -> list[dict]:
        """Her dokum: korunur mu, aday mi, neden. Saf karar (dosyaya yazmaz)."""
        rows = []
        for p in self.files():
            meta = self.read_meta(p)
            full = ((meta or {}).get("verify") or {}).get("full_read") or {}
            valid = bool(meta and meta.get("status") == "success" and meta.get("sha256") and full.get("ok"))
            rows.append({"file": p.name, "size": p.stat().st_size, "status": (meta or {}).get("status"),
                         "verified": bool(full.get("ok")), "full_read_ok": full.get("ok") if full else None,
                         "created_at": (meta or {}).get("created_at"), "valid": valid, "meta": meta is not None})
        valid = [r for r in rows if r["valid"]]
        keep = {r["file"] for r in valid[-KEEP:]}
        for r in rows:
            if r["file"] in keep:
                r.update(candidate=False, reason="en yeni 2 dogrulanmis basarili dokumden")
            elif not r["meta"]:
                r.update(candidate=False, reason="metadata yok (adopt)")
            elif r["status"] != "success":
                r.update(candidate=False, reason=f"durum {r['status']}: insan karari gerekir")
            elif not r["verified"]:
                r.update(candidate=False, reason="tam veri okumasi dogrulanmadi")
            elif len(valid) < KEEP:
                r.update(candidate=False, reason="2 dogrulanmis basarili dokum yok")
            else:
                r.update(candidate=True, reason="eski, basarili, dogrulanmis; en yeni 2 korunuyor")
        return rows

    # ------------------------------------------------------------------ eski dokumler
    def adopt(self, confirm: bool) -> list[dict]:
        """Metadatasi olmayan dokume deploy gunlugunden metadata: sha, migration'lar, sonuc."""
        out = []
        logs = sorted((self.root / "logs").glob("deploy-*.log")) if (self.root / "logs").is_dir() else []
        texts = {lg: lg.read_text(encoding="utf-8", errors="replace") for lg in logs}
        for p in self.files():
            if self.read_meta(p) is not None:
                continue
            m = NAME_RE.fullmatch(p.name)
            assert m
            log_text = next((t for t in texts.values() if str(p.name) in t), "")
            mig = re.search(r"bekleyen migration: \d+ dosya \(([^)]*)\)", log_text)
            res = re.search(r"^DEPLOY_RESULT=(\w+) sha=([0-9a-f]{40})", log_text, re.M)
            status = "success" if res and res.group(1) == "success" else "failed"
            row = {"file": p.name, "log": bool(log_text), "status": status,
                   "migrations": [x for x in (mig.group(1).replace("...", "").split() if mig else [])],
                   "sha": res.group(2) if res else None}
            if confirm:
                meta = {"version": 1, "file": p.name, "deploy_id": f"{m.group(1)}-{m.group(2)}",
                        "sha": row["sha"], "migrations": row["migrations"],
                        "created_at": datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "size": p.stat().st_size, "sha256": self.sha256(p), "toc": None, "status": status,
                        "verify": {"full_read": None}, "legacy": True,
                        "history": [{"at": now_iso(), "status": status, "reason": "adopt: deploy gunlugunden"}]}
                rc, toc_out = self.pg_restore(p, "-l", timeout=1800)
                meta["toc"] = self.parse_toc(toc_out) if rc == 0 else None
                if rc != 0 or self.toc_problem(meta["toc"]):
                    meta["status"] = "dump_failed"
                    meta["reason"] = "adopt: icindekiler okunamadi"
                self.write_meta(p, meta)
                row["status"] = meta["status"]
            out.append(row)
        return out

    # ------------------------------------------------------------------ silme
    def _deploy_lock_held(self) -> bool:
        """Deploy kilidi su an BASKA bir surecte (cagiran arilla-deploy) tutuluyor mu? flock ya da mkdir kilidi."""
        if (self.root / ".deploy.lock.d").is_dir():
            return True
        import fcntl  # noqa: PLC0415 - yalniz Linux

        with open(self.root / ".deploy.lock", "a") as probe:
            try:
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return True
            fcntl.flock(probe, fcntl.LOCK_UN)
        return False

    def auto_prune(self, path: Path) -> dict:
        """Karar 0194: basarili migration deploy'unun sonunda, deploy kilidi altinda. Silmezse sebebini doner."""
        if (self.state / "dump-auto-prune.off").exists():
            return {"skipped": "kapali (state/dump-auto-prune.off)", "deleted": []}
        if not self._deploy_lock_held():
            raise RuntimeError("auto-prune yalniz arilla-deploy kilidi altinda calisir; silme yapilmadi")
        meta = self.read_meta(path)
        if not meta or meta.get("status") != "success":
            return {"skipped": f"yeni dokum basarili degil (durum {(meta or {}).get('status')})", "deleted": []}
        v = self.verify(path, full=True)
        if not v["ok"]:
            raise RuntimeError(f"yeni dokum dogrulanamadi, silme yapilmadi: {v}")
        return self.prune(confirm=True, lock_held=True, fresh={path.name})

    def prune(self, confirm: bool, only: list[str] | None = None, lock_held: bool = False,
              fresh: set[str] | frozenset[str] = frozenset()) -> dict:
        """`lock_held`: cagiran deploy kilidini tutuyor (auto-prune). `fresh`: bu calismada tam okunmus dosyalar;
        bunlar ve adaylar (zaten silinecek) yalniz boyut + SHA-256 ile yeniden denetlenir."""
        rows = self.classify()
        candidates = [r for r in rows if r["candidate"] and (not only or r["file"] in only)]
        if only:
            unknown = set(only) - {r["file"] for r in candidates}
            if unknown:
                raise ValueError(f"aday olmayan dosya istendi: {sorted(unknown)}")
        report = {"confirm": confirm, "candidates": [r["file"] for r in candidates],
                  "bytes": sum(r["size"] for r in candidates), "deleted": [], "kept": [r["file"] for r in rows if not r["candidate"]]}
        if not confirm or not candidates:
            return report
        import fcntl  # noqa: PLC0415 - yalniz Linux (VPS); saglik kontrolu Windows testlerinde de yuklenir

        lock = None if lock_held else open(self.root / ".deploy.lock", "a")  # arilla-deploy ile AYNI kilit
        try:
            if lock is not None:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    raise RuntimeError("bir dagitim calisiyor (kilit .deploy.lock); silme yapilmadi") from None
            # Once korunan en yeni iki dokum ve her aday: degismemis + (korunanlar) tum veri okunabilir.
            keep_valid = [r for r in rows if r["valid"] and not r["candidate"]]
            for r in keep_valid + candidates:
                path = self.safe_path(r["file"])
                full = not lock_held or (not r["candidate"] and r["file"] not in fresh)
                v = self.verify(path, full=full)
                if not v["ok"]:
                    raise RuntimeError(f"dogrulama basarisiz, silme durdu: {r['file']} ({v})")
            self.state.mkdir(parents=True, exist_ok=True)
            audit = self.state / "pre-migrate-prune.log"
            actor = os.environ.get("SUDO_USER") or os.environ.get("USER") or str(os.getuid())
            if lock_held:
                actor = f"auto-prune ({actor})"
            for r in candidates:
                path = self.safe_path(r["file"])
                meta = self.read_meta(path) or {}
                st = os.lstat(path)
                if st.st_size != meta.get("size"):
                    raise RuntimeError(f"dosya degisti (boyut): {r['file']}")
                entry = {"at": now_iso(), "actor": actor, "file": r["file"], "size": st.st_size,
                         "sha256": meta.get("sha256"), "deploy_id": meta.get("deploy_id"), "sha": meta.get("sha"),
                         "migrations": meta.get("migrations"), "kept": [k["file"] for k in keep_valid]}
                with open(audit, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
                    fh.flush()
                    os.fsync(fh.fileno())
                path.unlink()
                self.meta_path(path).unlink(missing_ok=True)
                report["deleted"].append(r["file"])
        finally:
            if lock is not None:
                lock.close()
        return report


def write_state(root: Path, payload: dict) -> None:
    state = root / "state"
    state.mkdir(parents=True, exist_ok=True)
    tmp = state / "pre-migrate-verify.json.tmp"
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(state / "pre-migrate-verify.json")


def gb(n: int) -> str:
    return f"{n / 1e9:.2f} GB"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.environ.get("ARILLA_ROOT", "/opt/arilla"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("capacity")
    c.add_argument("--db-bytes", type=int, required=True)
    b = sub.add_parser("begin")
    b.add_argument("--dump", required=True)
    b.add_argument("--deploy-id", required=True)
    b.add_argument("--sha", required=True)
    b.add_argument("--migrations-file", required=True)
    f = sub.add_parser("finish")
    f.add_argument("--dump", required=True)
    s = sub.add_parser("set-status")
    s.add_argument("--dump", required=True)
    s.add_argument("--status", required=True, choices=("migrated", "success", "failed"))
    v = sub.add_parser("verify")
    g = v.add_mutually_exclusive_group(required=True)
    g.add_argument("--newest", action="store_true")
    g.add_argument("--file")
    v.add_argument("--full", action="store_true")
    v.add_argument("--state", action="store_true")
    r = sub.add_parser("report")
    r.add_argument("--json", action="store_true")
    a = sub.add_parser("adopt")
    a.add_argument("--confirm", action="store_true")
    p = sub.add_parser("prune")
    p.add_argument("--confirm", action="store_true")
    p.add_argument("--only", nargs="*")
    ap_auto = sub.add_parser("auto-prune")
    ap_auto.add_argument("--dump", required=True)
    args = ap.parse_args(argv)
    d = Dumps(Path(args.root))

    def dump_arg(value: str) -> Path:
        """Yalniz `<root>/backups/<ad>` ya da yalin ad; baska dizin reddedilir."""
        p = Path(value)
        if p.parent not in (Path("."), d.dir) and os.path.realpath(p.parent) != os.path.realpath(d.dir):
            raise ValueError(f"dokum backups disinda: {value}")
        return d.safe_path(p.name)

    try:
        if args.cmd == "capacity":
            reserve = int(os.environ.get("ARILLA_DUMP_RESERVE_BYTES", DEFAULT_RESERVE))
            allow = os.environ.get("ARILLA_DEPLOY_ALLOW_BELOW_CATALOG_GATE") == "1"
            gate = int(os.environ.get("ARILLA_CATALOG_GATE_BYTES", CATALOG_GATE_GIB * GiB))  # test ayari
            res = d.capacity(args.db_bytes, reserve, catalog_gate=gate, allow_below_gate=allow)
            print(json.dumps(res))
            if res["free"] >= res["need"] and not res["catalog_gate_ok"]:
                left = res["free"] - res["estimate"]
                msg = (f"KATALOG ESIGI: dokumden sonra bos ~{gb(left)} < {gb(res['catalog_gate'])}; otomatik "
                       "yayin (catalog-auto) durur. Once yer acin: pre_migrate_dumps.py report / prune.")
                if allow:
                    print(msg + " ARILLA_DEPLOY_ALLOW_BELOW_CATALOG_GATE=1: bilincli devam.", file=sys.stderr)
                else:
                    print(msg + " Migration BASLATILMADI (bilincli istisna: "
                          "ARILLA_DEPLOY_ALLOW_BELOW_CATALOG_GATE=1).", file=sys.stderr)
                    return 2
            if not res["ok"]:
                print(f"YETERSIZ DISK: bos {gb(res['free'])} < gerekli {gb(res['need'])} "
                      f"(tahmini dokum {gb(res['estimate'])} + taban {gb(res['reserve'])}). Migration BASLATILMADI. "
                      "Silme adaylari: pre_migrate_dumps.py report", file=sys.stderr)
                return 2
            return 0
        if args.cmd == "begin":
            migrations = [x for x in Path(args.migrations_file).read_text(encoding="utf-8").split() if x]
            if not re.fullmatch(r"[0-9a-f]{40}", args.sha) or not re.fullmatch(r"\d{8}-\d{6}", args.deploy_id):
                raise ValueError("sha/deploy-id bicimi")
            d.begin(dump_arg(args.dump), args.deploy_id, args.sha, migrations)
            return 0
        if args.cmd == "finish":
            ok, meta = d.finish(dump_arg(args.dump))
            print(json.dumps({"ok": ok, "status": meta["status"], "size": meta.get("size"),
                              "toc": meta.get("toc"), "reason": meta.get("reason")}))
            return 0 if ok else 1
        if args.cmd == "set-status":
            d.set_status(dump_arg(args.dump), args.status)
            return 0
        if args.cmd == "verify":
            files = d.files()
            if args.newest:
                if not files:
                    print("dokum yok")
                    return 0
                path = files[-1]
            else:
                path = d.safe_path(args.file)
            res = d.verify(path, full=args.full)
            if args.state:
                write_state(d.root, {**res, "kind": "full_read" if args.full else "sha256",
                                     "note": "pg_restore tam veri okumasi; gercek PostgreSQL geri yukleme kaniti DEGIL"})
            print(json.dumps(res, ensure_ascii=False))
            return 0 if res["ok"] else 1
        if args.cmd == "report":
            rows = d.classify()
            cand = [x for x in rows if x["candidate"]]
            if args.json:
                print(json.dumps({"dumps": rows, "candidate_bytes": sum(x["size"] for x in cand)}, ensure_ascii=False))
            else:
                for x in rows:
                    print(f"{'ADAY ' if x['candidate'] else 'KORU '} {x['file']} {gb(x['size'])} durum={x['status']} "
                          f"dogrulandi={x['verified']} - {x['reason']}")
                print(f"silme adayi: {len(cand)} dosya, {gb(sum(x['size'] for x in cand))} "
                      "(silmek icin: prune --confirm; otomatik: yalniz basarili migration deploy'u sonunda)")
            return 0
        if args.cmd == "adopt":
            for row in d.adopt(args.confirm):
                print(json.dumps(row, ensure_ascii=False))
            if not args.confirm:
                print("onizleme: metadata YAZILMADI (adopt --confirm)")
            return 0
        if args.cmd == "prune":
            rep = d.prune(args.confirm, args.only)
            print(json.dumps(rep, ensure_ascii=False))
            if not args.confirm:
                print("onizleme: hicbir dosya SILINMEDI (prune --confirm)")
            return 0
        if args.cmd == "auto-prune":
            rep = d.auto_prune(dump_arg(args.dump))
            if rep.get("skipped"):
                print(f"otomatik temizlik atlandi: {rep['skipped']}")
            else:
                print(f"otomatik temizlik: {len(rep['deleted'])} dokum silindi ({gb(rep['bytes'])}); "
                      f"korunan: {', '.join(rep['kept']) or '-'}")
            return 0
    except (ValueError, RuntimeError) as error:
        print(f"HATA: {error}", file=sys.stderr)
        return 75 if "kilit" in str(error) else 1
    return 64


if __name__ == "__main__":
    sys.exit(main())
