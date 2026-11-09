#!/usr/bin/env python3
"""Arilla saglik kontrolu ve alarm (karar 0110). Yalniz standart kutuphane; ROOT ile (systemd).

    arilla_healthcheck.py                 # kontrol et, sonucu yaz; cikis 0 ok / 1 uyari / 2 kritik
    arilla_healthcheck.py --notify        # + alarm/olu-adam bildirimi (systemd zamanlayicisi)
    arilla_healthcheck.py --unit-failed X # systemd OnFailure kancasi: X birimi basarisiz
    arilla_healthcheck.py --unit-failed X --no-send  # yalniz siniflandirmayi yaz (teshis)
    arilla_healthcheck.py --json          # makine-okunur cikti

Kontroller: disk doluluk, konteyner sagligi, PostgreSQL erisimi ve baglanti kullanimi, WAL
arsiv kuyrugu (pg_ls_archive_statusdir), yedek yasi (pgbackrest info), geri yukleme provasi
yasi/sonucu, basarisiz arilla-* systemd birimleri, gece katalog hatti tazeligi.

Gece katalog hatti (karar 0174, PR1c): `arilla-catalog-pipeline` basarisiz oldugunda birimin
cikis kodu (`ExecMainStatus`) VE o kosunun `job_run.detail.outcome`'u birlikte okunur. Tek
seferlik kilit beklemesi (75 + `skipped_locked`) BILGI'dir: bir kez bildirilir, kritik sayilmaz,
hatirlatma uretmez. Art arda ikinci atlama, kayitsiz/uyumsuz sonuc ya da okunamayan durum
KRITIK'tir (kapali tarafta kalir). Ayrica her is icin son "calisti" kosusu 50 saati gecerse
KRITIK (takili kilit, calismayan zamanlayici). `blocked_upstream` calisti sayilir, alarm yok.

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

OK, INFO, WARN, CRIT = "ok", "info", "warn", "crit"
#: INFO kritiklik siralamasinda OK ile esittir: genel durumu, parmak izini ve hatirlatmayi etkilemez.
LEVEL_RANK = {OK: 0, INFO: 0, WARN: 1, CRIT: 2}
ALERTING = (WARN, CRIT)
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
    "pipeline_stale_crit_s": 50 * 3600,  # gunluk 02:30 kosusu + bir kacan gece + tolerans
}

#: Sonucu `job_run`'dan siniflandirilan birimler -> o birimin yazdigi isler (karar 0174).
PIPELINE_JOBS = {"arilla-catalog-pipeline.service": ("resolve", "similarity_edges")}
EXIT_TEMPFAIL = 75
#: Tazelik icin "calisti" sayilan sonuclar; `outcome` yoksa eski kayit `status`'u.
RAN_OUTCOMES = ("completed", "no_input", "partial", "blocked_upstream")
LEGACY_RAN_STATUS = ("success", "partial")
#: systemd baslangic zamani ile job_run.started_at arasindaki saat payi (ayni makine).
INVOCATION_SKEW_S = 5


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

    def unit_invocation(self, unit: str) -> tuple[int | None, datetime | None]:
        """(son kosunun ana cikis kodu, birimin son baslangic zamani); okunamazsa None."""
        rc, out = self.run(["systemctl", "show", unit, "-p", "ExecMainStatus", "-p", "InactiveExitTimestamp",
                            "--timestamp=utc"], 15)
        return parse_unit_show(out) if rc == 0 else (None, None)

    def unit_active_state(self, unit: str) -> str | None:
        """systemd ActiveState (failed, inactive, active...); okunamazsa None."""
        rc, out = self.run(["systemctl", "show", unit, "-p", "ActiveState", "--value"], 15)
        return (out.strip() or None) if rc == 0 else None

    def pipeline_recent(self, jobs: tuple[str, ...]) -> list[dict] | None:
        """Islerin son iki cron kosusu, yeniden eskiye; sorgu basarisizsa None."""
        rc, out = self.psql(PIPELINE_RECENT_SQL.format(jobs=sql_jobs(jobs)))
        if rc != 0:
            return None
        rows = []
        for line in out.splitlines():
            f = line.split("|")
            if len(f) != 5 or not f[4].isdigit():
                return None
            rows.append({"job": f[0], "status": f[1], "outcome": f[2] or None, "reason": f[3] or None,
                         "started": datetime.fromtimestamp(int(f[4]), tz=timezone.utc)})
        return rows

    def pipeline_last_ran(self, jobs: tuple[str, ...]) -> dict[str, datetime | None] | None:
        """Her isin son "calisti" kosusunun bitisi; kayit yoksa None deger, sorgu basarisizsa None."""
        rc, out = self.psql(PIPELINE_LAST_RAN_SQL.format(jobs=sql_jobs(jobs)))
        if rc != 0:
            return None
        last: dict[str, datetime | None] = {}
        for line in out.splitlines():
            f = line.split("|")
            if len(f) != 2 or f[0] not in jobs or not f[1].isdigit():
                return None
            last[f[0]] = datetime.fromtimestamp(int(f[1]), tz=timezone.utc) if int(f[1]) else None
        return last if set(last) == set(jobs) else None

    def classify_unit(self, unit: str) -> tuple[str, str]:
        exec_status, since = self.unit_invocation(unit)
        rows = self.pipeline_recent(PIPELINE_JOBS[unit])
        return classify_pipeline_failure(exec_status, since, rows)

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
        facts["pipeline_failures"] = {u: self.classify_unit(u) for u in facts["failed_units"] if u in PIPELINE_JOBS}
        jobs = tuple(j for unit_jobs in PIPELINE_JOBS.values() for j in unit_jobs)
        facts["pipeline_last_ran"] = self.pipeline_last_ran(jobs)
        return facts


# --------------------------------------------------------------------------- katalog hatti
#: Her isin son iki cron kosusu (job_run_job_idx: job, started_at DESC).
PIPELINE_RECENT_SQL = """
select j.job, r.status, coalesce(r.detail->>'outcome', ''), coalesce(r.detail->>'reason', ''),
       extract(epoch from r.started_at)::bigint
  from unnest(array[{jobs}]::text[]) as j(job)
  cross join lateral (
        select status, detail, started_at from job_run
         where job = j.job and trigger = 'cron'
         order by started_at desc limit 2) r
 order by r.started_at desc
"""

#: Her isin son "calisti" kosusunun bitisi (epoch, yoksa 0); tetikleyici fark etmez.
PIPELINE_LAST_RAN_SQL = """
select j.job, coalesce((
        select extract(epoch from finished_at)::bigint from job_run
         where job = j.job and status <> 'running'
           and (detail->>'outcome' in ({ran})
                or (not (detail ? 'outcome') and status in ({legacy})))
         order by started_at desc limit 1), 0)
  from unnest(array[{{jobs}}]::text[]) as j(job)
""".format(ran=", ".join(f"'{o}'" for o in RAN_OUTCOMES), legacy=", ".join(f"'{s}'" for s in LEGACY_RAN_STATUS))


def sql_jobs(jobs: tuple[str, ...]) -> str:
    """Sabit is adlari (job_run.job CHECK ile ayni bicim); disaridan gelen metin degil."""
    for job in jobs:
        if not (job[:1].isalpha() and all(ch.islower() or ch.isdigit() or ch == "_" for ch in job)):
            raise ValueError(f"gecersiz is adi: {job!r}")
    return ", ".join(f"'{job}'" for job in jobs)


def parse_unit_show(out: str) -> tuple[int | None, datetime | None]:
    """`systemctl show -p ExecMainStatus -p InactiveExitTimestamp --timestamp=utc` ciktisi."""
    values = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    status = values.get("ExecMainStatus", "").strip()
    stamp = values.get("InactiveExitTimestamp", "").strip()
    since = None
    if stamp.endswith(" UTC"):
        parts = stamp[:-4].split()
        try:
            since = datetime.strptime(" ".join(parts[-2:]), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except ValueError:
            since = None
    return (int(status) if status.isdigit() else None), since


def describe(row: dict) -> str:
    result = row.get("outcome") or f"status={row.get('status')}"
    return f"{row['job']}={result}" + (f" ({row['reason']})" if row.get("reason") else "")


def classify_pipeline_failure(exec_status: int | None, since: datetime | None,
                              rows: list[dict] | None) -> tuple[str, str]:
    """Basarisiz katalog hatti biriminin seviyesi ve mesaji (karar 0174, PR1c).

    Tek seferlik kilit beklemesi (cikis 75 VE bu kosunun son kaydi `skipped_locked`) INFO;
    geri kalan her durum, okunamayan durum dahil, CRIT.
    """
    if exec_status is None or since is None:
        return CRIT, "birim durumu okunamadi (systemctl show)"
    if rows is None:
        return CRIT, f"job_run okunamadi (cikis {exec_status})"
    cutoff = since.timestamp() - INVOCATION_SKEW_S
    current = [r for r in rows if r["started"].timestamp() >= cutoff]
    if not current:
        return CRIT, f"bu kosuya ait job_run kaydi yok (cikis {exec_status})"
    last = current[0]
    if exec_status == EXIT_TEMPFAIL and last.get("outcome") == "skipped_locked":
        prev = next((r for r in rows if r["job"] == last["job"] and r["started"].timestamp() < cutoff), None)
        if prev and prev.get("outcome") == "skipped_locked":
            return CRIT, f"{describe(last)}: art arda ikinci kez kilit mesgul (cikis 75)"
        return INFO, f"{describe(last)}: kilit mesgul, kosu atlandi; sonraki zamanlanmis kosu tekrar dener"
    if last.get("outcome") in ("completed", "no_input", "blocked_upstream") and exec_status != 0:
        return CRIT, f"son kayit {describe(last)}; sonraki adim kayit acmadan basarisiz (cikis {exec_status})"
    return CRIT, f"{describe(last)} (cikis {exec_status})"


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

    classified = facts.get("pipeline_failures") or {}
    failed = [u for u in facts.get("failed_units") or [] if u not in classified]
    out.append(Check("systemd", CRIT if failed else OK, "basarisiz: " + ", ".join(failed) if failed else "basarisiz birim yok"))
    for unit, (lvl, msg) in sorted(classified.items()):
        out.append(Check(f"systemd:{unit}", lvl, msg))

    if "pipeline_last_ran" in facts:
        last_ran = facts["pipeline_last_ran"]
        if last_ran is None:
            out.append(Check("pipeline:freshness", CRIT, "katalog hatti kayitlari okunamadi"))
        else:
            stale, missing, ages = [], [], []
            for job, at in sorted(last_ran.items()):
                if at is None:
                    missing.append(job)
                    continue
                age = (now - at).total_seconds()
                ages.append(f"{job} {human(age)} once")
                if age > t["pipeline_stale_crit_s"]:
                    stale.append(f"{job} {human(age)}dir calismadi")
            if stale:
                out.append(Check("pipeline:freshness", CRIT, "katalog hatti: " + ", ".join(stale)))
            elif missing:
                out.append(Check("pipeline:freshness", WARN, "calisti kaydi yok: " + ", ".join(missing)))
            else:
                out.append(Check("pipeline:freshness", OK, "son calisma: " + ", ".join(ages)))
    return out


def overall(checks: list[Check]) -> str:
    level = max((c.level for c in checks), key=LEVEL_RANK.__getitem__, default=OK)
    return OK if level == INFO else level


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
    return ";".join(sorted(f"{c.name}:{c.level}" for c in checks if c.level in ALERTING))


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
        if c.level in ALERTING:
            lines.append(f"- {c.level.upper()} {c.name}: {c.message}")
    return "\n".join(lines)


def unit_failed_message(unit: str, host: str, collector: Collector | None) -> tuple[str, str]:
    """OnFailure seviyesi ve mesaji; katalog hatti birimi `job_run` sonucuyla siniflandirilir."""
    hint = f"(journalctl -u {unit})"
    if collector is None:
        return CRIT, f"[ManiCepte {host}] SORUN\n- CRIT systemd: {unit} basarisiz {hint}"
    try:
        level, msg = collector.classify_unit(unit)
    except Exception as error:  # noqa: BLE001 - alarm yolu asla susmaz
        level, msg = CRIT, f"siniflandirma hatasi: {type(error).__name__}"
    head = "BILGI" if level == INFO else "SORUN"
    return level, f"[ManiCepte {host}] {head}\n- {level.upper()} systemd: {unit} {msg} {hint}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.environ.get("ARILLA_ROOT", "/opt/arilla"))
    ap.add_argument("--notify", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--unit-failed")
    ap.add_argument("--no-send", action="store_true", help="--unit-failed: yalniz yaz, bildirim gonderme")
    args = ap.parse_args(argv)
    root = Path(args.root)
    alert = read_env(root / "env" / "alert.env")
    host = socket.gethostname()
    now = datetime.now(timezone.utc)

    if args.unit_failed:
        unit = "".join(ch for ch in args.unit_failed if ch.isalnum() or ch in "-_.@")[:120]
        collector = Collector(root) if unit in PIPELINE_JOBS else None
        if args.no_send and collector is not None:
            # Teshis: birim basarisiz degilse siniflandirma anlamsiz (OnFailure zaten calismazdi).
            state = collector.unit_active_state(unit)
            if state is not None and state != "failed":
                print(f"[ManiCepte {host}] TESHIS\n- OK systemd: {unit} basarisiz degil (ActiveState={state}); "
                      "alarm gitmezdi")
                return 0
        level, text = unit_failed_message(unit, host, collector)
        if not args.no_send:
            if alert.get("ALERT_WEBHOOK_URL"):
                post_json(alert["ALERT_WEBHOOK_URL"], {"text": text, "content": text})
            # Olu adam anahtari yalniz gercek sorunda "fail" alir; tek seferlik atlama degil.
            if alert.get("HEALTHCHECK_PING_URL") and level != INFO:
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
