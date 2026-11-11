#!/usr/bin/env python3
"""Yedek dogrulama / geri yukleme provasi BEKCISI (karar 0183). Yalniz standart kutuphane; ROOT ile.

    backup_monitor.py watch --container NAME --out FILE [secenekler]

Bir konteyneri (pgbackrest verify ya da restore) disaridan izler; o konteynerin kendisine
dokunmaz. Her `--interval` saniyede:

- `docker stats`: CPU (%, 100 = bir cekirdek), bellek (bayt), ag okuma (bayt; R2'den okunan
  veri icin yaklasik, konteyner yalniz egress agindadir)
- bos disk (`--free-path`) ve istege bagli dizin buyuklugu (`--dir`; gercek ayrilmis bloklar,
  seyrek dosyalar sayilmaz)
- WAL arsiv kuyrugu (`--root` verilirse): bekleyen `.ready` sayisi ve en eski bekleme yasi

Koruyucu sinir asilinca konteyner `docker kill` ile DURDURULUR ve neden yazilir:
`min_free` (disk tabani), `max_dir` (dizin butcesi), `wal_backlog` (arsiv kuyrugu), `deadline`.
Olcum ozeti `--out` dosyasina JSON yazilir. Cikis 0 = izleme tamamlandi (konteynerin kendi
sonucu ayrica alinir), 3 = koruyucu sinirla durduruldu.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

ABORTED = 3

Runner = Callable[[list[str], int], tuple[int, str]]


def default_runner(cmd: list[str], timeout: int = 30) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        return p.returncode, p.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


_UNITS = {"b": 1, "kb": 1000, "mb": 1000**2, "gb": 1000**3, "tb": 1000**4,
          "kib": 1024, "mib": 1024**2, "gib": 1024**3, "tib": 1024**4}


def parse_size(text: str) -> int | None:
    """`docker stats` boyutu: '512MiB', '1.2GB', '30kB', '0B' -> bayt."""
    m = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)\s*", text or "")
    if not m or m.group(2).lower() not in _UNITS:
        return None
    return int(float(m.group(1)) * _UNITS[m.group(2).lower()])


def parse_stats(line: str) -> dict | None:
    """'{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}' -> {'cpu_pct','mem_bytes','rx_bytes'}."""
    parts = (line or "").strip().split("|")
    if len(parts) != 3:
        return None
    cpu = parts[0].strip().rstrip("%")
    mem = parts[1].split("/")[0]
    rx = parts[2].split("/")[0]
    try:
        cpu_pct = float(cpu)
    except ValueError:
        return None
    mem_b, rx_b = parse_size(mem), parse_size(rx)
    if mem_b is None or rx_b is None:
        return None
    return {"cpu_pct": cpu_pct, "mem_bytes": mem_b, "rx_bytes": rx_b}


def allocated_bytes(path: Path) -> int:
    """Dizindeki dosyalarin GERCEKTEN ayrilmis bloklari (seyrek dosyalarin bosluklari sayilmaz)."""
    total = 0
    for base, _dirs, files in os.walk(path, onerror=lambda _e: None):
        for name in files:
            try:
                st = os.lstat(os.path.join(base, name))
            except OSError:
                continue
            blocks = getattr(st, "st_blocks", None)  # Windows'ta yok (yalniz yerel birim testi)
            total += blocks * 512 if blocks is not None else st.st_size
    return total


ARCHIVE_SQL = ("select (select count(*) from pg_ls_archive_statusdir() where name like '%.ready'), "
               "(select coalesce(extract(epoch from now() - min(modification))::bigint, 0) "
               "   from pg_ls_archive_statusdir() where name like '%.ready')")


def archive_status(root: Path | None, run: Runner) -> tuple[int, int] | None:
    """(bekleyen WAL sayisi, en eski bekleme sn); okunamazsa None. Saglik kontrolunun sorgusuyla ayni."""
    if root is None:
        return None
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import arilla_healthcheck as hc  # noqa: PLC0415 - ayni dizin, yalniz gerektiginde

    rc, out = hc.Collector(root, run=run).psql(ARCHIVE_SQL)
    if rc != 0 or not out.strip():
        return None
    f = out.strip().splitlines()[0].split("|")
    try:
        return int(f[0]), int(f[1])
    except (IndexError, ValueError):
        return None


class Limits:
    def __init__(self, min_free: int | None = None, max_dir: int | None = None,
                 abort_ready: int | None = None, abort_oldest_s: int | None = None,
                 deadline_s: int | None = None):
        self.min_free, self.max_dir = min_free, max_dir
        self.abort_ready, self.abort_oldest_s, self.deadline_s = abort_ready, abort_oldest_s, deadline_s


def breach(sample: dict, limits: Limits, elapsed: float) -> str | None:
    """Ilk asilan koruyucu sinirin adi; yoksa None. Saf fonksiyon (testli)."""
    free = sample.get("free_bytes")
    if limits.min_free is not None and free is not None and free < limits.min_free:
        return "min_free"
    used = sample.get("dir_bytes")
    if limits.max_dir is not None and used is not None and used > limits.max_dir:
        return "max_dir"
    ready, oldest = sample.get("archive_ready"), sample.get("archive_oldest_s")
    if limits.abort_ready is not None and ready is not None and ready >= limits.abort_ready:
        return "wal_backlog"
    if limits.abort_oldest_s is not None and oldest is not None and ready and oldest >= limits.abort_oldest_s:
        return "wal_backlog"
    if limits.deadline_s is not None and elapsed >= limits.deadline_s:
        return "deadline"
    return None


def summarize(samples: list[dict], baseline: tuple[int, int] | None, duration: float,
              aborted: str | None) -> dict:
    def col(key):
        return [s[key] for s in samples if s.get(key) is not None]

    cpu, mem, rx = col("cpu_pct"), col("mem_bytes"), col("rx_bytes")
    free, used = col("free_bytes"), col("dir_bytes")
    ready, oldest = col("archive_ready"), col("archive_oldest_s")
    return {
        "samples": len(samples),
        "duration_s": round(duration, 1),
        "aborted": aborted,
        "cpu_max_pct": max(cpu) if cpu else None,
        "cpu_avg_pct": round(sum(cpu) / len(cpu), 1) if cpu else None,
        "mem_max_bytes": max(mem) if mem else None,
        # docker'in ag sayaci konteyner omru boyunca birikir; son ornek >= gercek okumanin alt siniri.
        "read_bytes_min": max(rx) if rx else None,
        "free_min_bytes": min(free) if free else None,
        "dir_max_bytes": max(used) if used else None,
        "archive_ready_baseline": baseline[0] if baseline else None,
        "archive_ready_max": max(ready) if ready else None,
        "archive_oldest_max_s": max(oldest) if oldest else None,
    }


def container_running(name: str, run: Runner) -> bool | None:
    rc, out = run(["docker", "inspect", "-f", "{{.State.Running}}", name], 15)
    if rc != 0:
        return None  # henuz yok ya da silindi
    return out.strip() == "true"


def watch(name: str, limits: Limits, *, interval: float = 15.0, free_path: Path | None = None,
          dir_path: Path | None = None, root: Path | None = None, run: Runner = default_runner,
          sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
          start_wait_s: float = 120.0) -> dict:
    started = clock()
    # Konteyner `docker compose run` ile ayrica baslatilir: once ortaya cikmasini bekle.
    seen = False
    while clock() - started < start_wait_s:
        state = container_running(name, run)
        if state is not None:
            seen = True
            break
        sleep(1.0)
    baseline = archive_status(root, run)
    samples: list[dict] = []
    aborted = None
    while seen:
        state = container_running(name, run)
        if not state:
            break
        sample: dict = {}
        rc, out = run(["docker", "stats", "--no-stream", "--format",
                       "{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}", name], 30)
        if rc == 0:
            sample.update(parse_stats(out.strip().splitlines()[0] if out.strip() else "") or {})
        if free_path is not None:
            try:
                sample["free_bytes"] = shutil.disk_usage(free_path).free
            except OSError:
                pass
        if dir_path is not None and dir_path.exists():
            sample["dir_bytes"] = allocated_bytes(dir_path)
        st = archive_status(root, run)
        if st is not None:
            sample["archive_ready"], sample["archive_oldest_s"] = st
        samples.append(sample)
        aborted = breach(sample, limits, clock() - started)
        if aborted:
            run(["docker", "kill", name], 30)
            break
        sleep(interval)
    result = summarize(samples, baseline, clock() - started, aborted)
    result["container_seen"] = seen
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("watch")
    w.add_argument("--container", required=True)
    w.add_argument("--out", required=True)
    w.add_argument("--interval", type=float, default=15.0)
    w.add_argument("--root", help="WAL arsiv kuyrugunu olc (ARILLA_ROOT)")
    w.add_argument("--free-path")
    w.add_argument("--min-free-bytes", type=int)
    w.add_argument("--dir")
    w.add_argument("--max-dir-bytes", type=int)
    w.add_argument("--abort-ready", type=int)
    w.add_argument("--abort-oldest-s", type=int)
    w.add_argument("--deadline-s", type=int)
    args = ap.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", args.container):
        print("gecersiz konteyner adi", file=sys.stderr)
        return 64
    limits = Limits(args.min_free_bytes, args.max_dir_bytes, args.abort_ready, args.abort_oldest_s, args.deadline_s)
    result = watch(args.container, limits, interval=args.interval,
                   free_path=Path(args.free_path) if args.free_path else None,
                   dir_path=Path(args.dir) if args.dir else None,
                   root=Path(args.root) if args.root else None)
    out = Path(args.out)
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_text(json.dumps(result), encoding="utf-8")
    tmp.replace(out)
    return ABORTED if result["aborted"] else 0


if __name__ == "__main__":
    sys.exit(main())
