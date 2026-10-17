#!/usr/bin/env python3
"""Arilla saglik kontrolu ve alarm (karar 0110). Yalniz standart kutuphane; ROOT ile (systemd).

    arilla_healthcheck.py                 # kontrol et, sonucu yaz; cikis 0 ok / 1 uyari / 2 kritik
    arilla_healthcheck.py --notify        # + alarm/olu-adam bildirimi (systemd zamanlayicisi)
    arilla_healthcheck.py --unit-failed X # systemd OnFailure kancasi: X birimi basarisiz
    arilla_healthcheck.py --json          # makine-okunur cikti

Kontroller: disk doluluk, konteyner sagligi, PostgreSQL erisimi ve baglanti kullanimi, WAL
arsiv kuyrugu (pg_ls_archive_statusdir), yedek yasi (pgbackrest info), geri yukleme provasi
yasi/sonucu, basarisiz arilla-* systemd birimleri.

Bildirim (/opt/arilla/env/alert.env, ikisi de istege bagli):
  HEALTHCHECK_PING_URL  her calismada ping (kritikse <url>/fail). VPS duserse ping kesilir ->
                        DIS servis alarm verir (olu adam anahtari).
  ALERT_WEBHOOK_URL     durum degisince ve sorun surerken 6 saatte bir JSON POST.
Mesajlarda sir, sorgu metni ya da kisisel veri YOKTUR.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

OK, WARN, CRIT = "ok", "warn", "crit"
LEVEL_RANK = {OK: 0, WARN: 1, CRIT: 2}
CORE_SERVICES = ("postgres", "redis", "web", "worker", "cron", "caddy")
SELF_UNITS = ("arilla-healthcheck.service",)
REMIND_SECONDS = 6 * 3600

THRESHOLDS = {
    "disk_warn_pct": 70.0,
    "disk_crit_pct": 80.0,
    "conn_warn_pct": 80.0,
    "conn_crit_pct": 90.0,
    "archive_ready_warn": 4,  # arsivlenmeyi bekleyen WAL dosyasi
    "archive_ready_crit": 16,
    "archive_oldest_ready_crit_s": 15 * 60,
    "last_backup_crit_s": 30 * 3600,  # gunluk fark yedegi + tolerans
    "last_full_crit_s": 8 * 24 * 3600,  # haftalik tam yedek + tolerans
    "restore_test_warn_s": 35 * 24 * 3600,
}


@dataclass
class Check:
    name: str
    level: str
    message: str


Runner = Callable[[list[str], int], tuple[int, str]]


def default_runner(cmd: list[str], timeout: int = 60) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        return p.returncode, p.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


def parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    v = value.strip().replace(" ", "T")
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    # PostgreSQL: +00 -> +00:00
    if len(v) >= 3 and (v[-3] in "+-") and v[-2:].isdigit():
        v = v + ":00"
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ------------------------------------------------------------------------------- toplama
class Collector:
    def __init__(self, root: Path, run: Runner = default_runner, disk_usage=shutil.disk_usage):
        self.root = root
        self.run = run
        self.disk_usage = disk_usage
        env = read_env(root / "env" / "postgres.env")
        self.pg_user = env.get("POSTGRES_USER", "arilla")
        self.pg_db = env.get("POSTGRES_DB", "arilla")

    def compose(self, *args: str) -> list[str]:
        extra = os.environ.get("ARILLA_COMPOSE_EXTRA")  # yalniz yerel/CI testi
        return [
            "docker", "compose", "--env-file", str(self.root / "compose.env"),
            "-f", str(self.root / "compose.prod.yml"), *(["-f", extra] if extra else []),
            "--profile", "backup", *args,
        ]

    def psql(self, sql: str) -> tuple[int, str]:
        return self.run(self.compose("exec", "-T", "postgres", "psql", "-U", self.pg_user, "-d", self.pg_db,
                                     "-AtqX", "-F", "|", "-c", sql), 30)

    def collect(self) -> dict:
        facts: dict = {}
        facts["disk"] = {}
        for path in (self.root, Path("/var/lib/docker")):
            try:
                u = self.disk_usage(str(path))
                facts["disk"][str(path)] = round(100.0 * u.used / u.total, 1) if u.total else 0.0
            except OSError:
                continue
        rc, out = self.run(self.compose("ps", "--format", "{{.Service}}={{.Health}}"), 30)
        facts["containers"] = dict(line.split("=", 1) for line in out.splitlines() if "=" in line) if rc == 0 else None
        facts["backup_configured"] = (self.root / "backup" / "pg" / "archive.conf").exists()

        rc, out = self.psql(
            "select current_setting('archive_mode'), "
            "(select count(*) from pg_stat_activity), current_setting('max_connections')::int, "
            "(select count(*) from pg_ls_archive_statusdir() where name like '%.ready'), "
            "(select coalesce(extract(epoch from now() - min(modification))::bigint, 0) "
            "   from pg_ls_archive_statusdir() where name like '%.ready'), "
            "(select coalesce(sum(size),0) from pg_ls_waldir()), "
            "a.failed_count, a.last_failed_time, a.last_archived_time "
            "from pg_stat_archiver a")
        if rc == 0 and out.strip():
            f = out.strip().splitlines()[0].split("|")
            facts["pg"] = {
                "archive_mode": f[0], "connections": int(f[1]), "max_connections": int(f[2]),
                "ready_count": int(f[3]), "oldest_ready_s": int(f[4]), "wal_bytes": int(f[5]),
                "failed_count": int(f[6] or 0), "last_failed": f[7] or None, "last_archived": f[8] or None,
            }
        else:
            facts["pg"] = None

        facts["backup_info"] = None
        if facts["containers"] and facts["containers"].get("backup"):
            rc, out = self.run(self.compose("exec", "-T", "backup", "pgbackrest", "--stanza=arilla",
                                            "--output=json", "info"), 120)
            if rc == 0:
                try:
                    facts["backup_info"] = json.loads(out)
                except json.JSONDecodeError:
                    facts["backup_info"] = None

        facts["restore_test"] = read_json(self.root / "state" / "restore-test.json")
        # Toplu katalog yayini bekcisinin kalp atisi (karar 0134; infra/vps/bin/catalog-publish).
        facts["bulk_window"] = read_json(self.root / "state" / "ali-publish" / "bulk-window.json")
        rc, out = self.run(["systemctl", "list-units", "--state=failed", "--plain", "--no-legend", "arilla-*"], 15)
        units = [line.split()[0] for line in out.splitlines() if line.strip()] if rc == 0 else []
        facts["failed_units"] = [u for u in units if u not in SELF_UNITS and not u.startswith("arilla-alert@")]
        return facts


def read_env(path: Path) -> dict[str, str]:
    data: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                data[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return data


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------------------- degerlendirme
def last_backups(info) -> tuple[datetime | None, datetime | None, str | None]:
    """(son herhangi yedek, son tam yedek, stanza durum mesaji)"""
    if not info:
        return None, None, None
    stanza = next((s for s in info if s.get("name") == "arilla"), None) if isinstance(info, list) else None
    if not stanza:
        return None, None, "stanza yok"
    status = stanza.get("status", {})
    msg = None if status.get("code", 0) == 0 else str(status.get("message", "hata"))
    last_any = last_full = None
    for b in stanza.get("backup", []) or []:
        stop = b.get("timestamp", {}).get("stop")
        if not isinstance(stop, (int, float)):
            continue
        dt = datetime.fromtimestamp(stop, tz=timezone.utc)
        if b.get("error"):
            continue
        last_any = max(last_any, dt) if last_any else dt
        if b.get("type") == "full":
            last_full = max(last_full, dt) if last_full else dt
    return last_any, last_full, msg


def human(seconds: float) -> str:
    s = int(seconds)
    if s < 3600:
        return f"{s // 60} dk"
    if s < 86400:
        return f"{s // 3600} sa"
    return f"{s // 86400} gun"


#: Kalp atisi ne kadar gecerli olursa olsun ust sinir (16 MB x 1024 = 16 GB).
BULK_WINDOW_MAX_READY = 1024


def bulk_window_ready_crit(window, now: datetime) -> int:
    """Taze ve gecerli kalp atisi -> bekcinin duraklama esigi (dosya); aksi halde 0."""
    if not isinstance(window, dict):
        return 0
    try:
        until, crit = float(window["until"]), int(window["ready_crit"])
    except (KeyError, TypeError, ValueError):
        return 0
    if now.timestamp() > until or crit <= 0:
        return 0
    return min(crit, BULK_WINDOW_MAX_READY)


def evaluate(facts: dict, now: datetime, t: dict = THRESHOLDS) -> list[Check]:
    out: list[Check] = []

    for path, pct in sorted(facts.get("disk", {}).items()):
        lvl = CRIT if pct >= t["disk_crit_pct"] else WARN if pct >= t["disk_warn_pct"] else OK
        out.append(Check(f"disk:{path}", lvl, f"doluluk %{pct}"))

    containers = facts.get("containers")
    if containers is None:
        out.append(Check("containers", CRIT, "docker compose ps calismadi"))
    else:
        bad = [f"{s}={containers.get(s, 'yok') or 'saglik-yok'}" for s in CORE_SERVICES if containers.get(s) != "healthy"]
        out.append(Check("containers", CRIT if bad else OK, "sagliksiz: " + ", ".join(bad) if bad else "hepsi healthy"))

    pg = facts.get("pg")
    configured = bool(facts.get("backup_configured"))
    if pg is None:
        out.append(Check("postgres", CRIT, "PostgreSQL sorgulanamadi"))
    else:
        pct = 100.0 * pg["connections"] / max(pg["max_connections"], 1)
        lvl = CRIT if pct >= t["conn_crit_pct"] else WARN if pct >= t["conn_warn_pct"] else OK
        out.append(Check("postgres:connections", lvl, f"{pg['connections']}/{pg['max_connections']} baglanti"))
        if pg["archive_mode"] != "on":
            out.append(Check("wal-archive", CRIT if configured else WARN,
                             "archive_mode kapali ama yedekleme yapilandirilmis" if configured
                             else "WAL arsivi ETKIN DEGIL (yedekleme aktivasyonu bekliyor)"))
        else:
            ready, oldest = pg["ready_count"], pg["oldest_ready_s"]
            warn_n, crit_n = t["archive_ready_warn"], t["archive_ready_crit"]
            window = bulk_window_ready_crit(facts.get("bulk_window"), now)
            if window:
                # Toplu yayin sirasinda arsiv BILEREK birkac yuz dosya geride tutulur (geri basinc).
                # Kritik esik bekcinin duraklama sinirina (kuyruk sinirinin yarisi) cikar; en eski
                # dosya yasi (depo erisilemez) kurali AYNEN kalir.
                crit_n = max(crit_n, window)
                warn_n = max(warn_n, crit_n // 2)
            lvl = OK
            if ready >= crit_n or (ready > 0 and oldest >= t["archive_oldest_ready_crit_s"]):
                lvl = CRIT
            elif ready >= warn_n:
                lvl = WARN
            msg = f"bekleyen WAL {ready} (en eski {human(oldest)}), pg_wal {pg['wal_bytes'] // 1048576} MB"
            if window:
                msg += f"; toplu yayin penceresi (kritik {crit_n})"
            last_failed, last_ok = parse_ts(pg.get("last_failed")), parse_ts(pg.get("last_archived"))
            if last_failed and (not last_ok or last_failed > last_ok) and lvl == OK:
                lvl = WARN
                msg += "; son arsiv denemesi basarisiz"
            out.append(Check("wal-archive", lvl, msg))

    containers = containers or {}
    if configured or "backup" in containers:
        healthy = containers.get("backup") == "healthy"
        out.append(Check("backup:container", OK if healthy else CRIT,
                         "backup konteyneri healthy" if healthy else f"backup konteyneri {containers.get('backup') or 'yok'}"))
        last_any, last_full, status_msg = last_backups(facts.get("backup_info"))
        if status_msg:
            out.append(Check("backup:stanza", CRIT, f"pgbackrest: {status_msg}"))
        if not last_any:
            out.append(Check("backup:last", CRIT, "basarili yedek bulunamadi"))
        else:
            age = (now - last_any).total_seconds()
            out.append(Check("backup:last", CRIT if age > t["last_backup_crit_s"] else OK, f"son yedek {human(age)} once"))
        if last_full:
            age = (now - last_full).total_seconds()
            out.append(Check("backup:full", CRIT if age > t["last_full_crit_s"] else OK, f"son tam yedek {human(age)} once"))
        elif last_any:
            out.append(Check("backup:full", CRIT, "tam yedek yok"))

        rt = facts.get("restore_test")
        if not rt:
            out.append(Check("restore-test", WARN, "geri yukleme provasi henuz yapilmadi"))
        else:
            fin = parse_ts(rt.get("finished_at"))
            age = (now - fin).total_seconds() if fin else 1e12
            if not rt.get("ok"):
                out.append(Check("restore-test", CRIT, "son geri yukleme provasi BASARISIZ"))
            elif age > t["restore_test_warn_s"]:
                out.append(Check("restore-test", WARN, f"son basarili prova {human(age)} once"))
            else:
                rto = (rt.get("result") or {}).get("rto_s")
                out.append(Check("restore-test", OK, f"son prova {human(age)} once, RTO {rto} sn"))

    failed = facts.get("failed_units") or []
    out.append(Check("systemd", CRIT if failed else OK, "basarisiz: " + ", ".join(failed) if failed else "basarisiz birim yok"))
    return out


def overall(checks: list[Check]) -> str:
    return max((c.level for c in checks), key=LEVEL_RANK.__getitem__, default=OK)


# ---------------------------------------------------------------------------------- bildirim
def post_json(url: str, payload: dict, timeout: int = 10) -> bool:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (yapilandirilmis https adresi)
            return 200 <= r.status < 300
    except OSError:
        return False


def ping(url: str, fail: bool, timeout: int = 10) -> bool:
    target = url.rstrip("/") + ("/fail" if fail else "")
    try:
        with urllib.request.urlopen(target, timeout=timeout) as r:  # noqa: S310
            return 200 <= r.status < 300
    except OSError:
        return False


def fingerprint(checks: list[Check]) -> str:
    return ";".join(sorted(f"{c.name}:{c.level}" for c in checks if c.level != OK))


def decide_webhook(prev: dict | None, checks: list[Check], now: datetime) -> str | None:
    """Gonderilecek mesaj turu: 'problem' | 'reminder' | 'recovered' | None"""
    fp = fingerprint(checks)
    prev_fp = (prev or {}).get("fingerprint", "")
    if fp and fp != prev_fp:
        return "problem"
    if fp and fp == prev_fp:
        last = parse_ts((prev or {}).get("sent_at"))
        if not last or (now - last).total_seconds() >= REMIND_SECONDS:
            return "reminder"
        return None
    if not fp and prev_fp:
        return "recovered"
    return None


def format_message(kind: str, checks: list[Check], host: str) -> str:
    head = {"problem": "SORUN", "reminder": "SORUN SURUYOR", "recovered": "DUZELDI"}[kind]
    lines = [f"[ManiCepte {host}] {head}"]
    for c in checks:
        if c.level != OK:
            lines.append(f"- {c.level.upper()} {c.name}: {c.message}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.environ.get("ARILLA_ROOT", "/opt/arilla"))
    ap.add_argument("--notify", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--unit-failed")
    args = ap.parse_args(argv)
    root = Path(args.root)
    alert = read_env(root / "env" / "alert.env")
    host = socket.gethostname()
    now = datetime.now(timezone.utc)

    if args.unit_failed:
        unit = "".join(ch for ch in args.unit_failed if ch.isalnum() or ch in "-_.@")[:120]
        text = f"[ManiCepte {host}] SORUN\n- CRIT systemd: {unit} basarisiz (journalctl -u {unit})"
        if alert.get("ALERT_WEBHOOK_URL"):
            post_json(alert["ALERT_WEBHOOK_URL"], {"text": text, "content": text})
        if alert.get("HEALTHCHECK_PING_URL"):
            ping(alert["HEALTHCHECK_PING_URL"], fail=True)
        print(text)
        return 0

    checks = evaluate(Collector(root).collect(), now)
    level = overall(checks)
    if args.json:
        print(json.dumps({"level": level, "checks": [asdict(c) for c in checks]}, ensure_ascii=False))
    else:
        for c in checks:
            print(f"{c.level.upper():5} {c.name}: {c.message}")
        print(f"GENEL: {level.upper()}")

    if args.notify:
        state_dir = root / "state"
        state_dir.mkdir(parents=True, exist_ok=True)
        state_file = state_dir / "alert-state.json"
        prev = read_json(state_file)
        if alert.get("HEALTHCHECK_PING_URL"):
            ping(alert["HEALTHCHECK_PING_URL"], fail=(level == CRIT))
        kind = decide_webhook(prev, checks, now)
        sent_at = (prev or {}).get("sent_at")
        if kind and alert.get("ALERT_WEBHOOK_URL"):
            text = format_message(kind, checks, host)
            if post_json(alert["ALERT_WEBHOOK_URL"], {"text": text, "content": text}):
                sent_at = now.isoformat()
        elif kind:
            sent_at = now.isoformat()
        tmp = state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps({"fingerprint": fingerprint(checks), "sent_at": sent_at, "level": level}), encoding="utf-8")
        tmp.replace(state_file)
        return 0
    return LEVEL_RANK[level]


if __name__ == "__main__":
    sys.exit(main())
