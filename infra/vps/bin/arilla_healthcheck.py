#!/usr/bin/env python3
"""Arilla saglik kontrolu ve alarm (karar 0110). Yalniz standart kutuphane; ROOT ile (systemd).

    arilla_healthcheck.py                 # kontrol et, sonucu yaz; cikis 0 ok / 1 uyari / 2 kritik
    arilla_healthcheck.py --notify        # + alarm/olu-adam bildirimi (systemd zamanlayicisi)
    arilla_healthcheck.py --unit-failed X # systemd OnFailure kancasi: X birimi basarisiz
    arilla_healthcheck.py --unit-failed X --no-send  # yalniz siniflandirmayi yaz (teshis)
    arilla_healthcheck.py --json          # makine-okunur cikti

Kontroller: disk doluluk, konteyner sagligi, PostgreSQL erisimi ve baglanti kullanimi, WAL
arsiv kuyrugu (pg_ls_archive_statusdir), yedek yasi (pgbackrest info), geri yukleme provasi
yasi/sonucu, basarisiz arilla-* systemd birimleri, gece katalog hatti ve gunluk besleme tazeligi.

Gunluk besleme (karar 0184): `arilla-feeds-daily` `partial` ile (cikis 1) bittiginde, sorunlar
yalniz besleme duzeyindeyse (kesik dosya, boyut kapisi, geride), son basarili yazim 36 saatten
yeni ve taze teklif orani %25'in ustundeyse BILGI'dir; ayni sorunlar art arda gelirse tekrar
gonderilmez. `failed`, kur bayatligi, kesif hatasi, bayat fiyatlar ya da okunamayan durum KRITIK.
Son gunluk kosu kaydi 30 saati gecerse KRITIK.

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
    "verify_latest_warn_s": 8 * 24 * 3600,  # haftalik son-set dogrulamasi + tolerans (karar 0183)
    "verify_all_warn_s": 35 * 24 * 3600,  # aylik tum depo dogrulamasi + tolerans
    "pre_migrate_verify_warn_s": 8 * 24 * 3600,  # haftalik dokum tam okumasi + tolerans (karar 0187)
    "pipeline_stale_crit_s": 50 * 3600,  # gunluk 02:30 kosusu + bir kacan gece + tolerans
    # Gunluk besleme (karar 0184, 0188): gunde iki kosu (06:30, 21:30 + rastgele gecikme).
    "feeds_success_crit_s": 36 * 3600,  # en yeni besleme yazimi; ~3 kacan kosu
    "feeds_fresh_min_ratio": 0.25,  # taze / etkin teklif; 3 bantta 1 guncel besleme ~%40
    "feeds_run_stale_crit_s": 30 * 3600,  # son gunluk kosu kaydi; 2 kacan kosu + tolerans
    # Otomatik katalog hatti (karar 0164): yonetim panelinin gecikme esigiyle ayni. ExecCondition
    # atlamasi `job_run` yazmaz ve alarm uretmez; durmus hatti yalniz bu kural yakalar.
    "catalog_auto_stale_crit_s": 36 * 3600,
}

#: Otomatik katalog hatti (karar 0164). Esik `catalog-auto-guard` (START_FREE_GB) ve
#: `catalog_build.auto.START_FREE_GB` ile AYNIDIR (GiB); test_arilla_healthcheck esitligi denetler.
CATALOG_AUTO_TIMER = "arilla-catalog-auto.timer"
CATALOG_AUTO_JOB = "catalog_auto"
CATALOG_AUTO_START_FREE_GIB = 70

#: Sonucu `job_run`'dan siniflandirilan birimler -> o birimin yazdigi isler (karar 0174).
PIPELINE_JOBS = {"arilla-catalog-pipeline.service": ("resolve", "similarity_edges")}
EXIT_TEMPFAIL = 75
#: Tazelik icin "calisti" sayilan sonuclar; `outcome` yoksa eski kayit `status`'u.
RAN_OUTCOMES = ("completed", "no_input", "partial", "blocked_upstream")
LEGACY_RAN_STATUS = ("success", "partial")
#: systemd baslangic zamani ile job_run.started_at arasindaki saat payi (ayni makine).
INVOCATION_SKEW_S = 5
#: Gunluk besleme birimi -> `job_run.job` (karar 0184). `partial` cikis 1 verir (OnSuccess zinciri
#: bu yuzden tetiklenmez); seviye `job_run` kaydindan belirlenir.
FEEDS_UNIT = "arilla-feeds-daily.service"
FEEDS_JOB = "feed_daily"
#: Sonucu `job_run`'dan siniflandirilan tum birimler.
CLASSIFIED_UNITS = (*PIPELINE_JOBS, FEEDS_UNIT)


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

    def feeds_recent(self) -> list[dict] | None:
        """Gunluk beslemenin son iki cron kosusu, yeniden eskiye; sorgu basarisizsa None."""
        rc, out = self.psql(FEEDS_RECENT_SQL)
        if rc != 0:
            return None
        rows = []
        for line in out.splitlines():
            f = line.split("|")
            if len(f) != 8 or not f[7].isdigit():
                return None
            try:
                rows.append({
                    "status": f[0], "problems": f[1] or None,
                    "offers_active": int(f[2]) if f[2] else None, "offers_fresh": int(f[3]) if f[3] else None,
                    "last_success": datetime.fromtimestamp(int(f[4]), tz=timezone.utc) if f[4] else None,
                    "fx_stale": f[5] == "true", "discovery": f[6] or None,
                    "started": datetime.fromtimestamp(int(f[7]), tz=timezone.utc),
                })
            except ValueError:
                return None
        return rows

    def classify_unit(self, unit: str, now: datetime | None = None) -> tuple[str, str]:
        exec_status, since = self.unit_invocation(unit)
        if unit == FEEDS_UNIT:
            return classify_feeds_failure(exec_status, since, self.feeds_recent(),
                                          now or datetime.now(timezone.utc))
        rows = self.pipeline_recent(PIPELINE_JOBS[unit])
        return classify_pipeline_failure(exec_status, since, rows)

    def feeds_repeat(self, unit: str, now: datetime | None = None) -> bool:
        """Ayni BILGI bir onceki kosuda da uretildi mi (OnFailure tekrar gondermez)."""
        _status, since = self.unit_invocation(unit)
        return feeds_info_repeats(since, self.feeds_recent(), now or datetime.now(timezone.utc))

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
            "a.failed_count, a.last_failed_time, a.last_archived_time, "
            "(select sum(pg_database_size(oid)) from pg_database where datname not in ('template0','template1')) "
            "from pg_stat_archiver a")
        if rc == 0 and out.strip():
            f = out.strip().splitlines()[0].split("|")
            facts["pg"] = {
                "archive_mode": f[0], "connections": int(f[1]), "max_connections": int(f[2]),
                "ready_count": int(f[3]), "oldest_ready_s": int(f[4]), "wal_bytes": int(f[5]),
                "failed_count": int(f[6] or 0), "last_failed": f[7] or None, "last_archived": f[8] or None,
                "cluster_bytes": int(f[9]) if len(f) > 9 and f[9].isdigit() else None,
            }
        else:
            facts["pg"] = None
        try:
            facts["root_free_bytes"] = self.disk_usage(str(self.root)).free
        except OSError:
            facts["root_free_bytes"] = None

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
        # Karar 0183: kismi prova (tam kanit DEGIL) ve depo dogrulamalari ayri dosyalardadir.
        facts["restore_partial"] = read_json(self.root / "state" / "restore-test-partial.json")
        facts["verify_latest"] = read_json(self.root / "state" / "verify-latest.json")
        facts["verify_all"] = read_json(self.root / "state" / "verify-all.json")
        # Karar 0187: migration oncesi dokumler (yalniz metadata okunur; hash/okuma yapilmaz).
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import pre_migrate_dumps  # noqa: PLC0415 - ayni dizin

            facts["pre_migrate"] = pre_migrate_dumps.Dumps(self.root).classify()
        except Exception:  # noqa: BLE001 - saglik kontrolu bu yuzden dusmez
            facts["pre_migrate"] = None
        # Toplu katalog yayini bekcisinin kalp atisi (karar 0134; infra/vps/bin/catalog-publish).
        facts["bulk_window"] = read_json(self.root / "state" / "ali-publish" / "bulk-window.json")
        rc, out = self.run(["systemctl", "list-units", "--state=failed", "--plain", "--no-legend", "arilla-*"], 15)
        units = [line.split()[0] for line in out.splitlines() if line.strip()] if rc == 0 else []
        facts["failed_units"] = [u for u in units if u not in SELF_UNITS and not u.startswith("arilla-alert@")]
        facts["pipeline_failures"] = {u: self.classify_unit(u) for u in facts["failed_units"] if u in CLASSIFIED_UNITS}
        jobs = tuple(j for unit_jobs in PIPELINE_JOBS.values() for j in unit_jobs)
        facts["pipeline_last_ran"] = self.pipeline_last_ran(jobs)
        facts["feeds_recent"] = self.feeds_recent()
        facts["catalog_auto"] = self.catalog_auto_state()
        return facts

    def catalog_auto_state(self) -> dict | None:
        """Otomatik katalog hatti: zamanlayici etkin mi, son GERCEK calisma, son atlama nedeni.

        Hat kurulu degilse {"enabled": False}; kayitlar okunamazsa None (fail-closed).
        """
        rc, out = self.run(["systemctl", "is-enabled", CATALOG_AUTO_TIMER], 15)
        if out.strip() != "enabled":
            return {"enabled": False}
        rc, out = self.psql(CATALOG_AUTO_SQL)
        if rc != 0:
            return None
        f = out.strip().split("|")
        if len(f) != 2 or (f[0] and not f[0].isdigit()):
            return None
        return {
            "enabled": True,
            "last_worked": datetime.fromtimestamp(int(f[0]), tz=timezone.utc) if f[0] else None,
            "last_skip": f[1] or None,
        }


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


# --------------------------------------------------------------------------- gunluk besleme
#: Son iki cron kosusu (job_run_job_idx). `|` ayiraci sorun metninde gecmesin diye degistirilir.
FEEDS_RECENT_SQL = f"""
select status, replace(coalesce(error_summary, ''), '|', '/'),
       coalesce(detail->>'offers_active', ''), coalesce(detail->>'offers_fresh', ''),
       coalesce(extract(epoch from (detail->>'last_success_at')::timestamptz)::bigint::text, ''),
       coalesce(detail->>'fx_stale', ''), coalesce(detail->>'discovery', ''),
       extract(epoch from started_at)::bigint
  from job_run
 where job = '{FEEDS_JOB}' and trigger = 'cron'
 order by started_at desc limit 2
"""


#: (son gercek calismanin bitisi epoch | en yeni kaydin Python tarafi atlama nedeni).
#: Python tarafi atlama (`disk_low_*`, `backup_window`, `auto_running` ...) `success` + `detail.skipped`
#: yazar: calisma SAYILMAZ. ExecCondition (catalog-auto-guard) atlamasi hic kayit yazmaz.
CATALOG_AUTO_SQL = f"""
select coalesce((
        select extract(epoch from finished_at)::bigint::text from job_run
         where job = '{CATALOG_AUTO_JOB}' and status in ('success', 'partial')
           and finished_at is not null and not (detail ? 'skipped')
         order by started_at desc limit 1), ''),
       coalesce((
        select replace(detail->>'skipped', '|', '/') from job_run
         where job = '{CATALOG_AUTO_JOB}' order by started_at desc limit 1), '')
"""


def catalog_auto_check(state: dict | None, free_bytes: int | None, now: datetime, t: dict) -> Check | None:
    """Otomatik katalog hatti durdu mu (karar 0164). Kurulu degilse kontrol yok.

    - Son gercek calisma esikten eski -> CRIT (nedeni disk ise mesaj cozum yolunu soyler).
    - Bos disk baslangic esiginin altinda -> WARN: hat her tetikte SESSIZCE atlanir; 36 saat dolmadan
      erken uyari (12 Kasim: 2 gun boyunca alarmsiz durdu).
    """
    if state is not None and not state.get("enabled"):
        return None
    if state is None:
        return Check("catalog-auto:freshness", CRIT, f"{CATALOG_AUTO_JOB} kayitlari okunamadi")
    gib = 1 << 30
    low_disk = free_bytes is not None and free_bytes < CATALOG_AUTO_START_FREE_GIB * gib
    disk_note = (
        f"bos disk {free_bytes // gib} GiB < {CATALOG_AUTO_START_FREE_GIB} GiB baslangic esigi; hat her tetikte "
        "atlaniyor (esik DUSURULMEZ; docs/ops.md 'Otomatik yayin disk esiginde durdu')"
        if low_disk else ""
    )
    last = state.get("last_worked")
    if last is None:
        return Check("catalog-auto:freshness", WARN, "calisti kaydi yok" + (f"; {disk_note}" if disk_note else ""))
    age = (now - last).total_seconds()
    if age > t["catalog_auto_stale_crit_s"]:
        why = disk_note or (f"son atlama nedeni: {state['last_skip']}" if state.get("last_skip") else "")
        return Check("catalog-auto:freshness", CRIT,
                     f"otomatik katalog hatti {human(age)}dir calismadi" + (f"; {why}" if why else ""))
    if low_disk:
        return Check("catalog-auto:freshness", WARN, f"son calisma {human(age)} once; {disk_note}")
    return Check("catalog-auto:freshness", OK, f"son calisma {human(age)} once")


def feed_level_only(problems: str | None) -> bool:
    """Sorunlarin hepsi tek bir beslemeye mi ait (`feed_<id>:<kod>`): kaynak tarafi kapi/geride."""
    items = [p.strip() for p in (problems or "").split(";") if p.strip()]
    return bool(items) and all(p.startswith("feed_") and p[5:].split(":", 1)[0].isdigit() and ":" in p
                               for p in items)


def feeds_partial_tolerable(row: dict, now: datetime, t: dict = THRESHOLDS) -> tuple[bool, str]:
    """`partial` kosu bilgi duzeyinde mi: yalniz besleme duzeyi sorun VE fiyatlar yeterince taze."""
    if row.get("status") != "partial":
        return False, f"durum {row.get('status')}"
    if row.get("fx_stale"):
        return False, "kur bayat (TL karsiligi gosterilemez)"
    if row.get("discovery") == "failed":
        return False, "kesif basarisiz"
    if not feed_level_only(row.get("problems")):
        return False, "besleme disi sorun"
    last = row.get("last_success")
    if last is None:
        return False, "hic basarili besleme yazimi yok"
    age = (now - last).total_seconds()
    if age > t["feeds_success_crit_s"]:
        return False, f"son basarili besleme yazimi {human(age)} once"
    active, fresh = row.get("offers_active"), row.get("offers_fresh")
    if not active or fresh is None:
        return False, "taze teklif orani okunamadi"
    if fresh / active < t["feeds_fresh_min_ratio"]:
        return False, f"taze teklif %{100 * fresh // active} (esik %{int(100 * t['feeds_fresh_min_ratio'])})"
    return True, f"taze teklif %{100 * fresh // active}, son yazim {human(age)} once"


def feeds_current(since: datetime | None, rows: list[dict] | None) -> tuple[dict | None, dict | None]:
    """(bu kosunun kaydi, bir onceki kosunun kaydi)."""
    if since is None or not rows:
        return None, None
    cutoff = since.timestamp() - INVOCATION_SKEW_S
    current = next((r for r in rows if r["started"].timestamp() >= cutoff), None)
    prev = next((r for r in rows if r["started"].timestamp() < cutoff), None)
    return current, prev


def classify_feeds_failure(exec_status: int | None, since: datetime | None, rows: list[dict] | None,
                           now: datetime, t: dict = THRESHOLDS) -> tuple[str, str]:
    """Basarisiz gunluk besleme biriminin seviyesi ve mesaji (karar 0184).

    `partial` + yalniz besleme duzeyi sorun (kesik dosya, boyut kapisi, geride) + son basarili yazim
    36 saatten yeni + taze teklif orani esigin ustunde -> INFO. Geri kalan her sey, okunamayan
    durum dahil, CRIT (kapali tarafta kalir).
    """
    if exec_status is None or since is None:
        return CRIT, "birim durumu okunamadi (systemctl show)"
    if rows is None:
        return CRIT, f"job_run okunamadi (cikis {exec_status})"
    current, _prev = feeds_current(since, rows)
    if current is None:
        return CRIT, f"bu kosuya ait {FEEDS_JOB} kaydi yok (cikis {exec_status})"
    problems = current.get("problems") or "-"
    ok, why = feeds_partial_tolerable(current, now, t)
    if ok and exec_status == 1:
        return INFO, f"{FEEDS_JOB}=partial: {problems}; {why}"
    return CRIT, f"{FEEDS_JOB}={current.get('status')}: {problems}; {why} (cikis {exec_status})"


def feeds_info_repeats(since: datetime | None, rows: list[dict] | None, now: datetime,
                       t: dict = THRESHOLDS) -> bool:
    """Onceki kosu da ayni sorunlarla bilgi duzeyindeydi: BILGI bir kez gider (durum degisince yine)."""
    current, prev = feeds_current(since, rows)
    if current is None or prev is None or prev.get("problems") != current.get("problems"):
        return False
    # Onceki kosu kendi zamanindaki tazelikle degerlendirilir.
    return feeds_partial_tolerable(prev, prev["started"], t)[0]


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


def gib(n: float | None) -> str:
    return "?" if n is None else f"{n / 1073741824:.0f} GB"


def pre_migrate_check(rows, now: datetime, t: dict = THRESHOLDS) -> Check | None:
    """Migration oncesi dokumler (karar 0187). Tam veri okumasi gercek geri yukleme kaniti DEGILDIR.

    - en yeni dokumun tam okumasi basarisiz -> KRITIK
    - en yeni dokum `pre_migrate_verify_warn_s`'den eski ve hala tam okunmamis -> UYARI
    - insan karari bekleyen (basarisiz/yarim) ya da metadatasiz dokum -> UYARI
    Silme adaylari bilgi olarak yazilir; otomatik silme yalniz basarili migration deploy'unda (karar 0194).
    """
    if not rows:
        return None
    def gbs(n: float) -> str:
        return f"{n / 1e9:.1f} GB"
    newest = rows[-1]
    pending = [r for r in rows if r.get("meta") and r.get("status") != "success"]
    no_meta = [r for r in rows if not r.get("meta")]
    cand = [r for r in rows if r.get("candidate")]
    summary = (f"{len(rows)} dokum {gbs(sum(r['size'] for r in rows))}; silme adayi {len(cand)} "
               f"({gbs(sum(r['size'] for r in cand))}, prune --confirm ya da sonraki migration deploy'u)")
    if newest.get("full_read_ok") is False:
        return Check("backup:pre-migrate", CRIT, f"en yeni dokumun tam veri okumasi BASARISIZ ({newest['file']}); {summary}")
    created = parse_ts(newest.get("created_at"))
    age = (now - created).total_seconds() if created else 0
    if not newest.get("full_read_ok") and age > t["pre_migrate_verify_warn_s"]:
        return Check("backup:pre-migrate", WARN, f"en yeni dokum {human(age)}dir tam okunmadi ({newest['file']}); {summary}")
    if pending or no_meta:
        return Check("backup:pre-migrate", WARN,
                     f"insan karari bekleyen dokum {len(pending)}, metadatasiz {len(no_meta)} (adopt); {summary}")
    return Check("backup:pre-migrate", OK, summary)


def verify_check(name: str, label: str, st, now: datetime, max_age_s: int) -> Check:
    """pg-backup verify durum dosyasi (karar 0183). Tamamlanamayan dogrulama bozulma degildir: UYARI."""
    if not isinstance(st, dict) or not st.get("status"):
        return Check(name, WARN, f"{label} henuz yapilmadi")
    fin = parse_ts(st.get("finished_at"))
    age = (now - fin).total_seconds() if fin else 1e12
    reason = st.get("reason") or "-"
    if st["status"] == "failed":
        return Check(name, CRIT, f"{label} BASARISIZ ({reason}), {human(age)} once")
    if st["status"] != "ok":
        return Check(name, WARN, f"{label} tamamlanamadi ({reason}; bozulma degil, koruyucu sinir), {human(age)} once")
    if age > max_age_s:
        return Check(name, WARN, f"son basarili {label} {human(age)} once")
    read = st.get("read_bytes_min")
    return Check(name, OK, f"{label} {human(age)} once: {human(st.get('duration_s') or 0)}, R2 okuma >= {gib(read)}, "
                           f"CPU en cok %{st.get('cpu_max_pct')}, WAL kuyrugu en cok {st.get('archive_ready_max')}")


#: pg-restore-test varsayilanlariyla AYNI olmali (test_arilla_healthcheck sabitler).
RESTORE_WAL_BUDGET_BYTES = 16 * 1073741824
RESTORE_MIN_FREE_BYTES = 30 * 1073741824


def restore_capacity_checks(facts: dict, now: datetime, t: dict = THRESHOLDS) -> list[Check]:
    """Tam geri yukleme provasinin bu makinede guvenli olup olmadigi + kismi prova (karar 0183)."""
    out: list[Check] = []
    free, cluster = facts.get("root_free_bytes"), (facts.get("pg") or {}).get("cluster_bytes")
    full_possible = None
    if free is not None and cluster is not None:
        need = cluster + RESTORE_WAL_BUDGET_BYTES + RESTORE_MIN_FREE_BYTES
        full_possible = free >= need
        if full_possible:
            out.append(Check("restore-capacity", OK, f"tam prova icin yer var (bos {gib(free)}, gerekli {gib(need)})"))
        else:
            out.append(Check("restore-capacity", WARN,
                             f"TAM geri yukleme provasi bu makinede guvenli DEGIL: bos {gib(free)} < gerekli {gib(need)} "
                             f"(kume {gib(cluster)} + WAL {gib(RESTORE_WAL_BUDGET_BYTES)} + taban "
                             f"{gib(RESTORE_MIN_FREE_BYTES)}); yalniz kismi prova yapilir (tam kanit degil)"))
    rp = facts.get("restore_partial")
    if isinstance(rp, dict):
        fin = parse_ts(rp.get("finished_at"))
        age = (now - fin).total_seconds() if fin else 1e12
        if not rp.get("ok"):
            err = (rp.get("result") or {}).get("error") or (rp.get("result") or {}).get("errors") or "-"
            out.append(Check("restore-test:partial", CRIT, f"son KISMI prova BASARISIZ ({err})"))
        elif age > t["restore_test_warn_s"]:
            out.append(Check("restore-test:partial", WARN, f"son kismi prova {human(age)} once"))
        else:
            out.append(Check("restore-test:partial", OK, f"kismi prova (tam kanit DEGIL) {human(age)} once"))
    elif full_possible is False:
        out.append(Check("restore-test:partial", WARN, "kismi geri yukleme provasi henuz yapilmadi"))
    return out


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

        out.extend(restore_capacity_checks(facts, now, t))
        out.append(verify_check("backup:verify", "son-set dogrulamasi", facts.get("verify_latest"), now,
                                t["verify_latest_warn_s"]))
        out.append(verify_check("backup:verify-all", "tum depo dogrulamasi", facts.get("verify_all"), now,
                                t["verify_all_warn_s"]))

    pm = pre_migrate_check(facts.get("pre_migrate"), now, t)
    if pm:
        out.append(pm)

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

    if "feeds_recent" in facts:
        feeds = facts["feeds_recent"]
        if feeds is None:
            out.append(Check("feeds:freshness", CRIT, f"{FEEDS_JOB} kayitlari okunamadi"))
        elif feeds:  # hic kayit yoksa gunluk besleme bu makinede kurulu degil
            age = (now - feeds[0]["started"]).total_seconds()
            if age > t["feeds_run_stale_crit_s"]:
                # Bilgi duzeyindeki partial artik sessiz; zamanlayici durursa bunu bu kural yakalar.
                out.append(Check("feeds:freshness", CRIT, f"gunluk besleme {human(age)}dir calismadi"))
            else:
                out.append(Check("feeds:freshness", OK, f"son gunluk besleme {human(age)} once ({feeds[0]['status']})"))

    if "catalog_auto" in facts:
        ca = catalog_auto_check(facts["catalog_auto"], facts.get("root_free_bytes"), now, t)
        if ca:
            out.append(ca)
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


def unit_failed_message(unit: str, host: str, collector: Collector | None) -> tuple[str, str, bool]:
    """OnFailure (seviye, mesaj, webhook gonderilsin mi); siniflandirilan birimler `job_run`'dan okunur.

    Gunluk beslemede ayni sorunlarla art arda gelen BILGI yalniz bir kez gonderilir (karar 0184).
    """
    hint = f"(journalctl -u {unit})"
    if collector is None:
        return CRIT, f"[ManiCepte {host}] SORUN\n- CRIT systemd: {unit} basarisiz {hint}", True
    send = True
    try:
        level, msg = collector.classify_unit(unit)
        if level == INFO and unit == FEEDS_UNIT and collector.feeds_repeat(unit):
            send = False
            msg += " (onceki kosuda bildirildi, tekrar gonderilmedi)"
    except Exception as error:  # noqa: BLE001 - alarm yolu asla susmaz
        level, msg, send = CRIT, f"siniflandirma hatasi: {type(error).__name__}", True
    head = "BILGI" if level == INFO else "SORUN"
    return level, f"[ManiCepte {host}] {head}\n- {level.upper()} systemd: {unit} {msg} {hint}", send


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
        collector = Collector(root) if unit in CLASSIFIED_UNITS else None
        if args.no_send and collector is not None:
            # Teshis: birim basarisiz degilse siniflandirma anlamsiz (OnFailure zaten calismazdi).
            state = collector.unit_active_state(unit)
            if state is not None and state != "failed":
                print(f"[ManiCepte {host}] TESHIS\n- OK systemd: {unit} basarisiz degil (ActiveState={state}); "
                      "alarm gitmezdi")
                return 0
        level, text, send = unit_failed_message(unit, host, collector)
        if not args.no_send:
            if alert.get("ALERT_WEBHOOK_URL") and send:
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
