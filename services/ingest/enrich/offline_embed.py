"""Cevrimdisi urun metin embedding'i: veritabanina YAZMAZ, dosya kontrol noktalidir (E4).

    python -m enrich.offline_embed run    --model bge-m3-5617a9f6 --out DIR --target 1000
    python -m enrich.offline_embed status --out DIR
    python -m enrich.offline_embed verify --out DIR [--deep]

Neden: 1024 boyutlu vektorlerin uretim tablosu (migration 0114 taslagi) henuz yok. Model gercek
urunlerle calistirilir, ciktilar kalici tabloya alinana kadar diskte, devam edilebilir parcalar
halinde tutulur. Bu modul:

- Urunleri SALT OKUNUR, sayfali okur (`default_transaction_read_only=on`, birincil anahtar keyset,
  `statement_timeout`). Hicbir tabloya yazmaz; `api_usage` yerine kullanim parca dosyasina yazilir
  (kalici tabloya alinirken `api_usage`'a aktarilir, kural 9).
- Metin ve ozet kurali `enrich.products` ile AYNIDIR (`build_product_text`, `content_hash`,
  `source_hash`): parcalar ileride dogrudan `product_text_embedding_d1024` satirina doner.
- Yazmadan once ve her `--canary-every` parcada altin vektor kanaryasi (karar 0186). Gecmezse durur.
- Parca = ardisik kimlik araligi. Dosyalar gecici adla yazilir, fsync, sonra yeniden adlandirilir;
  parca ancak `.json` (son yazilan) varsa tamamdir. Kosu yarida kesilirse yalniz o parca kaybolur;
  devam noktasi tamamlanmis parcalarin en buyuk kimligidir. Ayni urun ikinci kez islenmez.
  Onceki parcalar ASLA silinmez ya da yeniden yazilmaz.
- Frenler: disk tabani (`--min-free-gib`), bellek tabani (`MemAvailable`), yuk esigi (bekler),
  sessiz pencereler (yedek vb., bekler), `STOP` dosyasi, ardisik hata siniri, kanarya.
- Ayni anda tek kosu (`.lock`, `flock`).

Dosya bicimi (parca N, `parts/part-NNNNNN.*`):
- `.ids`  int64 LE, satir basina urun kimligi
- `.hash` satir basina 16 bayt `content_hash` ve ardindan 16 bayt `source_hash` (32 bayt)
- `.f16`  satir basina `dimensions` x float16 LE (PostgreSQL `halfvec` ile ayni hassasiyet)
- `.json` ust veri: model, revizyon, metin surumu, aralik, sayilar, SHA-256'lar, olcumler
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import signal
import struct
import sys
import threading
import time
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from types import FrameType
from typing import Any, Protocol

from db import job_run
from enrich.canary import CanaryFailed, require_canary
from enrich.client import EmbeddingError, EmbeddingRejected
from enrich.product_text import TEXT_VERSION, build_product_text, content_hash, source_hash
from enrich.providers import RemoteHttpTextProvider, validate_for
from enrich.registry import ModelSpec, RegistryError, registry

FORMAT = 1
PARTS = "parts"
STOP_FILE = "STOP"
RUNS_LOG = "runs.jsonl"
GIB = 1 << 30

FETCH_SQL = """
SELECT p.id, p.title, b.name
  FROM product p
  LEFT JOIN brand b ON b.id = p.brand_id
 WHERE p.id > %(after)s
   AND p.publication_state = 'published'
   AND p.offer_count + p.foreign_offer_count > 0
 ORDER BY p.id
 LIMIT %(limit)s
"""


class Fetcher(Protocol):
    def fetch(self, after_id: int, limit: int) -> list[tuple[int, str | None, str | None]]: ...


class Provider(Protocol):
    def embed_texts(self, texts: Sequence[str]) -> Any: ...


@dataclass(frozen=True)
class Part:
    seq: int
    first_id: int
    last_id: int
    rows: int
    meta: dict[str, Any]


@dataclass
class Guards:
    min_free_bytes: int
    min_mem_available_bytes: int
    max_load: float
    quiet_windows: list[tuple[int, int]]
    max_wait_s: float = 3600.0


@dataclass
class RunStats:
    parts: int = 0
    products: int = 0
    embedded: int = 0
    skipped_empty: int = 0
    rejected: int = 0
    duplicates_in_part: int = 0
    retries: int = 0
    failures: int = 0
    waits_s: float = 0.0
    embed_s: float = 0.0
    fetch_s: float = 0.0
    write_s: float = 0.0
    canary_runs: int = 0
    canary_min_cosine: float | None = None
    stop_reason: str | None = None
    outcome: str = "completed"
    latencies_ms: list[float] = field(default_factory=list)


# --- yardimcilar ---------------------------------------------------------------------------


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def pack_f16(vectors: Sequence[Sequence[float]], dimensions: int) -> bytes:
    out = bytearray()
    fmt = f"<{dimensions}e"
    for vector in vectors:
        if len(vector) != dimensions:
            raise ValueError(f"boyut {len(vector)} != {dimensions}")
        out += struct.pack(fmt, *vector)
    return bytes(out)


def unpack_f16(data: bytes, dimensions: int) -> list[tuple[float, ...]]:
    size = dimensions * 2
    if len(data) % size:
        raise ValueError("f16 dosya boyutu satir boyutunun kati degil")
    fmt = f"<{dimensions}e"
    return [struct.unpack_from(fmt, data, offset) for offset in range(0, len(data), size)]


def check_f16(data: bytes, dimensions: int, *, tolerance: float = 5e-3) -> None:
    """float16'ya yuvarlanmis vektorler sonlu ve birim normlu mu? (halfvec yuvarlamasi ~1e-4)"""
    for index, vector in enumerate(unpack_f16(data, dimensions)):
        if not all(math.isfinite(v) for v in vector):
            raise ValueError(f"satir {index}: sonlu olmayan deger")
        norm = math.sqrt(sum(v * v for v in vector))
        if abs(norm - 1.0) > tolerance:
            raise ValueError(f"satir {index}: norm {norm:.5f}")


def percentile(values: Sequence[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    k = max(0, min(len(ordered) - 1, math.ceil(q * len(ordered)) - 1))
    return round(ordered[k], 1)


def parse_windows(raw: str) -> list[tuple[int, int]]:
    """'01:25-02:15,06:20-07:10' -> gun icindeki dakika araliklari (UTC)."""
    windows: list[tuple[int, int]] = []
    for chunk in filter(None, (c.strip() for c in raw.split(","))):
        start, _, end = chunk.partition("-")
        h1, m1 = (int(x) for x in start.split(":"))
        h2, m2 = (int(x) for x in end.split(":"))
        windows.append((h1 * 60 + m1, h2 * 60 + m2))
    return windows


def in_window(minute: int, windows: Sequence[tuple[int, int]]) -> bool:
    for start, end in windows:
        if start <= end and start <= minute < end:
            return True
        if start > end and (minute >= start or minute < end):  # gece yarisini asan
            return True
    return False


def mem_available_bytes(path: Path = Path("/proc/meminfo")) -> int | None:
    try:
        for line in path.read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) * 1024
    except OSError:
        return None
    return None


def load_average() -> float | None:
    try:
        return os.getloadavg()[0]
    except (AttributeError, OSError):
        return None


def free_bytes(path: Path) -> int:
    usage = os.statvfs(path) if hasattr(os, "statvfs") else None
    if usage is not None:
        return usage.f_bavail * usage.f_frsize
    import shutil

    return shutil.disk_usage(path).free


def fsync_write(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# --- kontrol noktasi deposu ----------------------------------------------------------------


class CheckpointStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.parts_dir = root / PARTS

    def ensure(self) -> None:
        self.parts_dir.mkdir(parents=True, exist_ok=True)

    def path(self, seq: int, suffix: str) -> Path:
        return self.parts_dir / f"part-{seq:06d}.{suffix}"

    def parts(self) -> list[Part]:
        """Tamamlanmis parcalar (json'u olan), sira numarasina gore. Bozuk ust veri -> hata."""
        found: list[Part] = []
        if not self.parts_dir.is_dir():
            return found
        for meta_path in sorted(self.parts_dir.glob("part-*.json")):
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            found.append(
                Part(
                    seq=int(meta["seq"]),
                    first_id=int(meta["first_id"]),
                    last_id=int(meta["last_id"]),
                    rows=int(meta["rows"]),
                    meta=meta,
                )
            )
        found.sort(key=lambda p: p.seq)
        for previous, current in zip(found, found[1:], strict=False):
            contiguous = int(current.meta["scanned_after"]) == int(previous.meta["scanned_through"])
            if current.seq != previous.seq + 1 or not contiguous:
                raise RuntimeError(f"parca dizisi tutarsiz: {previous.seq} -> {current.seq}")
        return found

    def watermark(self, parts: Sequence[Part], start_after: int) -> int:
        """Devam noktasi: son parcanin `scanned_through` degeri (bos parcalar dahil)."""
        if not parts:
            return start_after
        return max(start_after, int(parts[-1].meta.get("scanned_through", parts[-1].last_id)))

    def write_part(
        self, seq: int, ids: bytes, hashes: bytes, vectors: bytes, meta: dict[str, Any]
    ) -> None:
        if self.path(seq, "json").exists():
            raise RuntimeError(f"parca {seq} zaten var; uzerine yazilmaz")
        for suffix, data in (("ids", ids), ("hash", hashes), ("f16", vectors)):
            fsync_write(self.path(seq, suffix), data)
        meta = {
            **meta,
            "sha256": {
                "ids": sha256_bytes(ids),
                "hash": sha256_bytes(hashes),
                "f16": sha256_bytes(vectors),
            },
        }
        fsync_write(self.path(seq, "json"), json.dumps(meta, sort_keys=True).encode("utf-8"))
        dir_fd = None
        try:  # dizin girdisini de kalici yap (yalniz POSIX)
            dir_fd = os.open(self.parts_dir, os.O_RDONLY)
            os.fsync(dir_fd)
        except (OSError, AttributeError):
            pass
        finally:
            if dir_fd is not None:
                os.close(dir_fd)

    def append_run(self, record: dict[str, Any]) -> None:
        with (self.root / RUNS_LOG).open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, sort_keys=True) + "\n")
            f.flush()
            os.fsync(f.fileno())

    def verify(self, *, deep: bool, dimensions: int | None = None) -> dict[str, Any]:
        parts = self.parts()
        models = {p.meta["model"] for p in parts}
        problems: list[str] = []
        rows = 0
        for part in parts:
            rows += part.rows
            sizes = {
                "ids": part.rows * 8,
                "hash": part.rows * 32,
                "f16": part.rows * int(part.meta["dimensions"]) * 2,
            }
            for suffix, size in sizes.items():
                path = self.path(part.seq, suffix)
                if not path.is_file() or path.stat().st_size != size:
                    problems.append(f"parca {part.seq}: {suffix} boyutu hatali")
                    continue
                if deep:
                    data = path.read_bytes()
                    if sha256_bytes(data) != part.meta["sha256"][suffix]:
                        problems.append(f"parca {part.seq}: {suffix} SHA-256 uyusmuyor")
                    elif suffix == "f16":
                        try:
                            check_f16(data, int(part.meta["dimensions"]))
                        except ValueError as error:
                            problems.append(f"parca {part.seq}: {error}")
        if len(models) > 1:
            problems.append(f"birden fazla model: {sorted(models)}")
        if dimensions is not None and any(int(p.meta["dimensions"]) != dimensions for p in parts):
            problems.append("boyut kayit defteriyle uyusmuyor")
        return {
            "parts": len(parts),
            "rows": rows,
            "models": sorted(models),
            "first_id": parts[0].first_id if parts else None,
            "last_id": parts[-1].last_id if parts else None,
            "scanned_through": self.watermark(parts, 0),
            "bytes": sum(p.stat().st_size for p in self.parts_dir.glob("part-*") if p.is_file())
            if self.parts_dir.is_dir()
            else 0,
            "problems": problems,
        }


# --- veritabani (salt okunur) ---------------------------------------------------------------


class PgFetcher:
    """Uretim katalogundan salt okunur, sayfali okuma. Oturum yazamaz (`read_only`)."""

    def __init__(self, url: str, *, statement_timeout_ms: int = 15000) -> None:
        import psycopg

        self.conn = psycopg.connect(
            url,
            autocommit=True,
            application_name="e4-offline-embed",
            options=(
                f"-c default_transaction_read_only=on -c statement_timeout={statement_timeout_ms}"
                " -c idle_in_transaction_session_timeout=60000"
            ),
        )
        with self.conn.cursor() as cur:
            cur.execute("SHOW default_transaction_read_only")
            row = cur.fetchone()
            if row is None or row[0] != "on":
                raise RuntimeError("oturum salt okunur degil; durduruldu")

    def fetch(self, after_id: int, limit: int) -> list[tuple[int, str | None, str | None]]:
        with self.conn.cursor() as cur:
            cur.execute(FETCH_SQL, {"after": after_id, "limit": limit})
            return [(int(r[0]), r[1], r[2]) for r in cur.fetchall()]

    def fetch_ids(self, ids: Sequence[int]) -> dict[int, tuple[str | None, str | None]]:
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT p.id, p.title, b.name FROM product p"
                " LEFT JOIN brand b ON b.id = p.brand_id WHERE p.id = ANY(%(ids)s)",
                {"ids": list(ids)},
            )
            return {int(r[0]): (r[1], r[2]) for r in cur.fetchall()}

    def close(self) -> None:
        self.conn.close()


# --- denetim: urun <-> vektor eslemesi gercek veriyle ---------------------------------------


def _cos(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def audit(
    spec: ModelSpec,
    store: CheckpointStore,
    fetch_ids: Callable[[Sequence[int]], dict[int, tuple[str | None, str | None]]],
    provider: Provider,
    *,
    sample: int,
    seed: int = 191,
    min_cosine: float = 0.999,
    split_seq: int | None = None,
) -> dict[str, Any]:
    """Orneklenmis satirlarda: (1) saklanan content_hash = urunun SIMDIKI metninin ozeti,
    (2) metin TEK BASINA yeniden gomulunce saklanan vektorle kosinus >= esik, (3) her saklanan
    vektorun en yakin taze vektoru KENDI urununun (kayma/karisma yok). Hicbir sey yazmaz."""
    import random

    parts = store.parts()
    population = [(p.seq, i) for p in parts for i in range(p.rows)]
    rng = random.Random(seed)
    picked = sorted(rng.sample(population, min(sample, len(population))))
    rows: list[dict[str, Any]] = []
    dims = spec.dimensions
    for seq in sorted({s for s, _ in picked}):
        ids = store.path(seq, "ids").read_bytes()
        hashes = store.path(seq, "hash").read_bytes()
        f16 = store.path(seq, "f16").read_bytes()
        for s, i in picked:
            if s != seq:
                continue
            rows.append(
                {
                    "seq": seq,
                    "id": struct.unpack_from("<q", ids, i * 8)[0],
                    "hash": hashes[i * 32 : i * 32 + 16],
                    "vector": struct.unpack_from(f"<{dims}e", f16, i * dims * 2),
                }
            )
    current = fetch_ids([r["id"] for r in rows])
    missing = changed = 0
    checked: list[dict[str, Any]] = []
    for row in rows:
        found = current.get(row["id"])
        if found is None:
            missing += 1
            continue
        text = build_product_text(*found)
        if content_hash(spec.id, text) != row["hash"]:
            changed += 1  # metin sonradan degismis: yeniden gomulmeli, hata degil
            continue
        row["text"] = text
        checked.append(row)
    fresh: list[list[float]] = []
    for row in checked:  # TEK TEK: parti/siralama/es zamanlilik etkisi disarida
        batch = provider.embed_texts([row["text"]])
        fresh.append(list(validate_for(spec, batch, 1).vectors[0]))
    cosines = [_cos(r["vector"], f) for r, f in zip(checked, fresh, strict=True)]
    misaligned = 0
    for i, row in enumerate(checked):
        best = max(range(len(fresh)), key=lambda j: _cos(row["vector"], fresh[j]))
        if best != i and _cos(row["vector"], fresh[best]) > cosines[i] + 1e-6:
            misaligned += 1
    below = sum(1 for c in cosines if c < min_cosine)

    def summary(selector: Callable[[dict[str, Any]], bool]) -> dict[str, Any]:
        values = sorted(c for r, c in zip(checked, cosines, strict=True) if selector(r))
        return {
            "n": len(values),
            "min_cosine": round(values[0], 6) if values else None,
            "median_cosine": round(values[len(values) // 2], 6) if values else None,
        }

    report: dict[str, Any] = {
        "model": spec.id,
        "sampled": len(rows),
        "missing_product": missing,
        "text_changed": changed,
        "checked": len(checked),
        "below_threshold": below,
        "threshold": min_cosine,
        "misaligned": misaligned,
        "all": summary(lambda r: True),
        "passed": bool(checked) and below == 0 and misaligned == 0,
    }
    if split_seq is not None:
        report["before_split"] = summary(lambda r: r["seq"] < split_seq)
        report["from_split"] = summary(lambda r: r["seq"] >= split_seq)
    return report


# --- calistirici ---------------------------------------------------------------------------


class Runner:
    def __init__(
        self,
        spec: ModelSpec,
        store: CheckpointStore,
        fetcher: Fetcher,
        provider_factory: Callable[[str], Provider],
        *,
        target: int,
        part_size: int,
        batch_size: int,
        start_after: int,
        guards: Guards,
        canary_every: int,
        max_consecutive_failures: int = 3,
        concurrency: int = 1,
        should_stop: Callable[[], bool] = lambda: False,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        sleep: Callable[[float], None] = time.sleep,
        canary: Callable[[ModelSpec, Callable[[str], Provider]], Any] = require_canary,
        retry_counter: Callable[[], int] = lambda: 0,
    ) -> None:
        self.spec = spec
        self.store = store
        self.fetcher = fetcher
        self.factory = provider_factory
        self.provider = provider_factory("passage")
        self.concurrency = max(1, concurrency)
        self._local = threading.local()
        self.target = target
        self.part_size = part_size
        self.batch_size = batch_size
        self.start_after = start_after
        self.guards = guards
        self.canary_every = canary_every
        self.max_failures = max_consecutive_failures
        self.should_stop = should_stop
        self.now = now
        self.sleep = sleep
        self.canary = canary
        self.retry_counter = retry_counter
        self.stats = RunStats()

    # frenler
    def _stop_file(self) -> bool:
        return (self.store.root / STOP_FILE).exists()

    def _guard(self, next_part_bytes: int) -> str | None:
        """None: devam. Metin: kalici durma nedeni. Bekleme gerektiren durumlar burada beklenir."""
        waited = 0.0
        while True:
            if self.should_stop() or self._stop_file():
                return "stop_requested"
            free = free_bytes(self.store.root)
            if free - next_part_bytes < self.guards.min_free_bytes:
                return "disk_floor"
            mem = mem_available_bytes()
            if mem is not None and mem < self.guards.min_mem_available_bytes:
                return "memory_floor"
            current = self.now()
            minute = current.hour * 60 + current.minute
            load = load_average()
            busy = in_window(minute, self.guards.quiet_windows) or (
                load is not None and load > self.guards.max_load
            )
            if not busy:
                return None
            if waited >= self.guards.max_wait_s:
                return "busy_timeout"
            self.sleep(30.0)
            waited += 30.0
            self.stats.waits_s += 30.0

    def _run_canary(self) -> bool:
        try:
            result = self.canary(self.spec, self.factory)
        except CanaryFailed:
            self.stats.stop_reason = "canary_failed"
            self.stats.outcome = "failed"
            return False
        self.stats.canary_runs += 1
        cosines = [c[2] for c in getattr(result, "cosines", [])]
        if cosines:
            low = min(cosines)
            prev = self.stats.canary_min_cosine
            self.stats.canary_min_cosine = low if prev is None else min(prev, low)
        return True

    def _embed(
        self, texts: list[str], provider: Provider | None = None
    ) -> tuple[list[list[float] | None], int, list[float]]:
        """Parti -> (vektorler, reddedilen, gecikmeler). Kalici red (4xx) ikiye bolunerek tek
        bozuk girdiye indirgenir. Paylasilan sayaca YAZMAZ (es zamanli cagrilir)."""
        provider = provider or self.provider
        started = time.perf_counter()
        try:
            batch = provider.embed_texts(texts)
            vectors = validate_for(self.spec, batch, len(texts)).vectors
            return [list(v) for v in vectors], 0, [(time.perf_counter() - started) * 1000]
        except EmbeddingRejected:
            if len(texts) == 1:
                return [None], 1, []
            mid = len(texts) // 2
            left, lr, ll = self._embed(texts[:mid], provider)
            right, rr, rl = self._embed(texts[mid:], provider)
            return left + right, lr + rr, ll + rl

    def _provider_for_thread(self) -> Provider:
        local = self._local
        if not hasattr(local, "provider"):
            local.provider = self.factory("passage")
        return local.provider

    def run(self) -> RunStats:
        self.store.ensure()
        parts = self.store.parts()
        done = sum(p.rows for p in parts)
        after = self.store.watermark(parts, self.start_after)
        seq = parts[-1].seq + 1 if parts else 1
        if done >= self.target:
            self.stats.outcome = "no_input"
            self.stats.stop_reason = "target_reached"
            return self.stats
        if not self._run_canary():
            return self.stats
        row_bytes = self.spec.dimensions * 2 + 8 + 32
        consecutive = 0
        while done < self.target:
            want = min(self.part_size, self.target - done)
            reason = self._guard(want * row_bytes + 4096)
            if reason is not None:
                self.stats.stop_reason = reason
                self.stats.outcome = "partial" if self.stats.parts else "failed"
                break
            started = time.perf_counter()
            rows = self.fetcher.fetch(after, want)
            fetch_s = time.perf_counter() - started
            self.stats.fetch_s += fetch_s
            if not rows:
                self.stats.stop_reason = "catalog_exhausted"
                if not self.stats.parts:
                    self.stats.outcome = "no_input"
                break
            try:
                written = self._process(seq, after, rows, fetch_s)
            except EmbeddingError:
                consecutive += 1
                self.stats.failures += 1
                if consecutive >= self.max_failures:
                    self.stats.stop_reason = "provider_errors"
                    self.stats.outcome = "partial" if self.stats.parts else "failed"
                    break
                self.sleep(min(60.0, 5.0 * consecutive))
                continue
            consecutive = 0
            after = rows[-1][0]
            done += written
            seq += 1
            due = self.canary_every and self.stats.parts % self.canary_every == 0
            if due and not self._run_canary():
                break
        else:
            self.stats.stop_reason = self.stats.stop_reason or "target_reached"
        # Kapanis kanaryasi: kosu boyunca model degismedi mi?
        finished = self.stats.outcome in {"completed", "partial"} and self.stats.parts
        if finished and not self._run_canary():
            self.stats.outcome = "failed"
        return self.stats

    def _process(
        self, seq: int, after: int, rows: list[tuple[int, str | None, str | None]], fetch_s: float
    ) -> int:
        model = self.spec.id
        kept: list[tuple[int, bytes, bytes, str]] = []
        for product_id, title, brand in rows:
            text = build_product_text(title, brand)
            if not text:
                self.stats.skipped_empty += 1
                continue
            kept.append(
                (product_id, content_hash(model, text), source_hash(title or "", brand), text)
            )
        unique: dict[bytes, str] = {}
        for _, digest, _, text in kept:
            unique.setdefault(digest, text)
        self.stats.duplicates_in_part += len(kept) - len(unique)
        retries_before = self.retry_counter()
        started = time.perf_counter()
        # Uzunluga gore sira: partideki dolgu (padding) azalir; vektorler siradan bagimsizdir.
        order = sorted(unique, key=lambda d: (len(unique[d]), d))
        chunks = [order[i : i + self.batch_size] for i in range(0, len(order), self.batch_size)]
        vectors: dict[bytes, list[float] | None] = {}

        def work(chunk: list[bytes]) -> tuple[list[bytes], tuple[Any, int, list[float]]]:
            provider = self._provider_for_thread() if self.concurrency > 1 else self.provider
            return chunk, self._embed([unique[d] for d in chunk], provider)

        if self.concurrency > 1 and len(chunks) > 1:
            with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
                results = list(pool.map(work, chunks))
        else:
            results = [work(chunk) for chunk in chunks]
        for chunk, (embedded, rejected, latencies) in results:
            self.stats.rejected += rejected
            self.stats.latencies_ms.extend(latencies)
            for digest, vector in zip(chunk, embedded, strict=True):
                vectors[digest] = vector
        embed_s = time.perf_counter() - started
        final = [(pid, d, s) for pid, d, s, _ in kept if vectors.get(d) is not None]
        started = time.perf_counter()
        ids = b"".join(struct.pack("<q", pid) for pid, _, _ in final)
        hashes = b"".join(d + s for _, d, s in final)
        packed = pack_f16([vectors[d] for _, d, _ in final], self.spec.dimensions)  # type: ignore[misc]
        check_f16(packed, self.spec.dimensions)
        retries = self.retry_counter() - retries_before
        meta = {
            "format": FORMAT,
            "seq": seq,
            "model": model,
            "revision": self.spec.source.get("revision"),
            "pooling": self.spec.pooling,
            "dimensions": self.spec.dimensions,
            "normalization": self.spec.normalization,
            "text_version": TEXT_VERSION,
            "preprocessing_version": self.spec.preprocessing_version,
            "scanned_after": after,
            "scanned_through": rows[-1][0],
            "first_id": final[0][0] if final else rows[0][0],
            "last_id": final[-1][0] if final else rows[-1][0],
            "fetched": len(rows),
            "rows": len(final),
            "unique_texts": len(unique),
            "skipped_empty": len(rows) - len(kept),
            "rejected_ids": [pid for pid, d, _, _ in kept if vectors.get(d) is None],
            "retries": retries,
            "fetch_s": round(fetch_s, 3),
            "embed_s": round(embed_s, 3),
            "texts_per_s": round(len(unique) / embed_s, 2) if embed_s > 0 else None,
            "created_at": self.now().isoformat(timespec="seconds"),
        }
        self.store.write_part(seq, ids, hashes, packed, meta)
        self.stats.write_s += time.perf_counter() - started
        self.stats.embed_s += embed_s
        self.stats.retries += retries
        self.stats.parts += 1
        self.stats.products += len(rows)
        self.stats.embedded += len(final)
        return len(final)


# --- kilit ve CLI --------------------------------------------------------------------------


class RunLock:
    def __init__(self, root: Path) -> None:
        self.path = root / ".lock"
        self.handle: Any = None

    def acquire(self) -> bool:
        self.handle = self.path.open("a+")
        try:
            import fcntl
        except ImportError:  # Windows (yalniz yerel test): kilit yok
            return True
        try:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return False
        return True

    def release(self) -> None:
        if self.handle is not None:
            self.handle.close()


_STOP = False


def _request_stop(signum: int, frame: FrameType | None) -> None:
    global _STOP
    _STOP = True


def stats_record(stats: RunStats, args: argparse.Namespace, started: datetime) -> dict[str, Any]:
    texts_per_s = round(stats.embedded / stats.embed_s, 2) if stats.embed_s > 0 else None
    return {
        "started_at": started.isoformat(timespec="seconds"),
        "finished_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "model": args.model,
        "target": args.target,
        "batch_size": args.batch_size,
        "concurrency": args.concurrency,
        "outcome": stats.outcome,
        "reason": stats.stop_reason,
        "parts": stats.parts,
        "products_scanned": stats.products,
        "embedded": stats.embedded,
        "skipped_empty": stats.skipped_empty,
        "rejected": stats.rejected,
        "duplicates_in_part": stats.duplicates_in_part,
        "retries": stats.retries,
        "failures": stats.failures,
        "waits_s": stats.waits_s,
        "fetch_s": round(stats.fetch_s, 2),
        "embed_s": round(stats.embed_s, 2),
        "write_s": round(stats.write_s, 2),
        "embedded_per_s": texts_per_s,
        "batch_latency_ms_p50": percentile(stats.latencies_ms, 0.5),
        "batch_latency_ms_p95": percentile(stats.latencies_ms, 0.95),
        "canary_runs": stats.canary_runs,
        "canary_min_cosine": stats.canary_min_cosine,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m enrich.offline_embed")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--model", required=True)
    run.add_argument("--out", type=Path, required=True)
    run.add_argument("--target", type=int, required=True, help="kontrol noktasindaki toplam urun")
    run.add_argument("--part-size", type=int, default=1000)
    run.add_argument("--batch-size", type=int, default=32)
    run.add_argument("--concurrency", type=int, default=1, help="ayni anda istek (1-4)")
    run.add_argument("--start-after", type=int, default=0)
    run.add_argument("--min-free-gib", type=float, required=True)
    run.add_argument("--min-mem-gib", type=float, default=1.5)
    run.add_argument("--max-load", type=float, default=6.0)
    run.add_argument("--quiet-windows", default="", help="UTC, or. 01:20-02:15,02:25-03:00")
    run.add_argument("--canary-every", type=int, default=20)
    aud = sub.add_parser("audit")
    aud.add_argument("--model", required=True)
    aud.add_argument("--out", type=Path, required=True)
    aud.add_argument("--sample", type=int, default=300)
    aud.add_argument("--seed", type=int, default=191)
    aud.add_argument("--split-seq", type=int, default=None)
    for name in ("status", "verify"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--out", type=Path, required=True)
        cmd.add_argument("--deep", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "audit":
        spec = registry().get(args.model)
        assert spec.endpoint is not None
        url = os.environ.get(spec.endpoint["url_env"], "").strip()
        fetcher = PgFetcher(os.environ.get("DATABASE_URL", "").strip())
        try:
            report = audit(
                spec,
                CheckpointStore(args.out),
                fetcher.fetch_ids,
                RemoteHttpTextProvider(spec=spec, base_url=url, purpose="passage", batch_size=1),
                sample=args.sample,
                seed=args.seed,
                split_seq=args.split_seq,
            )
        finally:
            fetcher.close()
        print(json.dumps(report, indent=1, sort_keys=True))
        return 0 if report["passed"] else 1
    if args.command in {"status", "verify"}:
        report = CheckpointStore(args.out).verify(deep=args.command == "verify" and args.deep)
        last = None
        log = args.out / RUNS_LOG
        if log.is_file():
            lines = log.read_text(encoding="utf-8").splitlines()
            last = json.loads(lines[-1]) if lines else None
        print(json.dumps({**report, "last_run": last}, indent=1, sort_keys=True))
        return 1 if report["problems"] else 0

    if (
        args.target < 1
        or args.part_size < 1
        or not 1 <= args.batch_size <= 32
        or not 1 <= args.concurrency <= 4
    ):
        print(
            "HATA: --target/--part-size >= 1, --batch-size 1-32, --concurrency 1-4", file=sys.stderr
        )
        return 2
    try:
        spec = registry().get(args.model)
    except RegistryError as error:
        print(f"HATA: {error}", file=sys.stderr)
        return 2
    if spec.provider != "remote_http" or spec.endpoint is None:
        print(
            "HATA: yalniz kendi calistirdigimiz remote_http modeli (ucretli API yok)",
            file=sys.stderr,
        )
        return 2
    url = os.environ.get(spec.endpoint["url_env"], "").strip()
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not url or not database_url:
        print(f"HATA: {spec.endpoint['url_env']} ve DATABASE_URL gerekli", file=sys.stderr)
        return 2

    store = CheckpointStore(args.out)
    store.ensure()
    lock = RunLock(args.out)
    if not lock.acquire():
        print("baska bir kosu calisiyor (kilit)", file=sys.stderr)
        return job_run.exit_code("skipped_locked")
    signal.signal(signal.SIGTERM, _request_stop)
    signal.signal(signal.SIGINT, _request_stop)

    retries = [0]

    def counting_sleep(seconds: float) -> None:
        retries[0] += 1
        time.sleep(seconds)

    def factory(purpose: str) -> RemoteHttpTextProvider:
        return RemoteHttpTextProvider(
            spec=spec,
            base_url=url,
            purpose=purpose,
            batch_size=args.batch_size,
            sleep=counting_sleep,
        )

    started = datetime.now(UTC)
    fetcher = PgFetcher(database_url)
    try:
        runner = Runner(
            spec,
            store,
            fetcher,
            factory,
            target=args.target,
            part_size=args.part_size,
            batch_size=args.batch_size,
            start_after=args.start_after,
            guards=Guards(
                min_free_bytes=int(args.min_free_gib * GIB),
                min_mem_available_bytes=int(args.min_mem_gib * GIB),
                max_load=args.max_load,
                quiet_windows=parse_windows(args.quiet_windows),
            ),
            canary_every=args.canary_every,
            concurrency=args.concurrency,
            should_stop=lambda: _STOP,
            retry_counter=lambda: retries[0],
        )
        stats = runner.run()
    finally:
        fetcher.close()
    record = stats_record(stats, args, started)
    store.append_run(record)
    lock.release()
    print(json.dumps(record, sort_keys=True))
    return job_run.exit_code(stats.outcome)


if __name__ == "__main__":
    sys.exit(main())
