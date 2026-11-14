"""Cevrimdisi vektor kontrol noktalarini kalici tabloya alir (karar 0195; BGE-M3 E4 ciktilari).

    python -m enrich.vector_import plan   --ckpt DIR --model bge-m3-5617a9f6   # KURU: yazim yok
    python -m enrich.vector_import run    --ckpt DIR --model bge-m3-5617a9f6 --execute
    python -m enrich.vector_import verify --ckpt DIR --model bge-m3-5617a9f6 [--sample 500]

`enrich.offline_embed` urun metnini gomer ve dosyaya yazar (veritabanina yazmaz). Bu modul o
dosyalari `product_text_embedding_d1024` (migration 0114) tablosuna alir. Embedding URETMEZ, model
cagirmaz, anlamsal aramayi ACMAZ: `embedding_index` satiri kurmaz, indeks etkinlestirmez,
HNSW kurmaz.

Her parca icin, veritabanina dokunmadan ONCE:

1. Ust veri sozlesmesi: bicim, model, revizyon, boyut, normalizasyon, havuzlama, on isleme ve metin
   surumu kayit defteriyle (`model_registry.json`) birebir ayni olmali; aksi halde TUM kosu durur.
2. Dosya butunlugu: boyutlar, SHA-256'lar, her vektorun sonlu ve birim normlu olmasi.

Sonra parca satirlari (`BATCH` kadarlik dilimlerle, her dilim kendi islemi) icin:

3. **Urun eslesmesi:** urun hala var mi? (yoksa `missing`, atlanir).
4. **Icerik ozeti:** urunun GUNCEL baslik ve markasindan kanonik metin yeniden uretilir;
   `content_hash` ve `source_hash` kontrol noktasindakiyle ayniysa vektor o urunun metnine
   aittir. Degisenler `stale` sayilir, YAZILMAZ (urun yeniden gomulur).
5. **Idempotans:** ayni (urun, model) satiri ayni `content_hash` ve metin surumuyle zaten varsa
   `present` sayilir, yazilmaz (WAL uretmez). Tekrar kosu sonucu degistirmez.

Frenler: WAL geri basinci (karar 0134), `STOP` dosyasi/SIGTERM, dilimler arasi bekleme,
`--max-rows`, oturum duzeyi danisma kilidi (tek kosu), ardisik hata siniri. Yerel olmayan
veritabani yalniz `--allow-remote` ile yazilir; bu bayrak ADR 0195'teki insan onayi olmadan
KULLANILMAZ.

Sonuc sozlesmesi (karar 0174): `job_run.job = enrich_vector_import`; `detail.outcome` ve cikis
kodu `db.job_run` sozlesmesinden. Kullanim (kural 9): bu modulde model cagrisi yapilmaz; alinan
her parcanin cevrimdisi gomme emegi `api_usage`'a (`operation = embedding_offline_import`,
maliyet 0) parca basina bir satir olarak aktarilir.
"""

from __future__ import annotations

import argparse
import logging
import random
import signal
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from types import FrameType
from typing import Any
from urllib.parse import urlparse

import psycopg

from db import job_run, usage, wal_pressure
from db.connection import connect, env
from enrich.offline_embed import (
    STOP_FILE,
    CheckpointStore,
    Part,
    check_f16,
    sha256_bytes,
    unpack_f16,
)
from enrich.product_text import TEXT_VERSION, build_product_text, content_hash, source_hash
from enrich.products import TABLES, table_sql, vector_literal
from enrich.registry import ModelSpec, RegistryError, registry, require_writable

logger = logging.getLogger(__name__)

JOB = "enrich_vector_import"
USAGE_OPERATION = "embedding_offline_import"
#: Ayni anda tek kosu (oturum duzeyi danisma kilidi). Diger islerin anahtarlarindan ayri.
LOCK_KEY = 195_000_001
CHECKPOINT_FORMAT = 1
#: Dilim boyutu: bir islemde yazilan en fazla satir (1024 x halfvec = ~2 KiB; ~1 MiB WAL/dilim).
DEFAULT_BATCH = 250
#: Ardisik dilim hatasinda kosu durur.
MAX_CONSECUTIVE_ERRORS = 3
#: Dosya bicimi ile veritabani arasindaki kimlik ust siniri (int64 LE).
ID_BYTES = 8
HASH_BYTES = 16

PRODUCT_SQL = """
SELECT p.id, p.title, b.name
  FROM product p
  LEFT JOIN brand b ON b.id = p.brand_id
 WHERE p.id = ANY(%(ids)s::bigint[])
"""


def existing_sql(table: str) -> str:
    return f"""
SELECT product_id, content_hash, text_version
  FROM {table}
 WHERE model_version = %(model)s AND product_id = ANY(%(ids)s::bigint[])
"""


def insert_sql(table: str, dimensions: int) -> str:
    """Yalniz `table_sql` ile ayni beyaz listeden (TABLES) tablo adi alir."""
    if table not in TABLES or not 1 <= dimensions <= 4000:
        raise ValueError(f"bilinmeyen vektor tablosu: {table!r}")
    return f"""
INSERT INTO {table} AS t
       (product_id, model_version, text_version, content_hash, source_hash, embedding)
SELECT u.product_id, %(model)s, %(text_version)s, u.content_hash, u.source_hash,
       u.embedding::halfvec({dimensions})
  FROM unnest(%(ids)s::bigint[], %(content)s::bytea[], %(source)s::bytea[], %(vectors)s::text[])
       AS u(product_id, content_hash, source_hash, embedding)
  JOIN product p ON p.id = u.product_id
ON CONFLICT (product_id, model_version) DO UPDATE
   SET text_version = EXCLUDED.text_version,
       content_hash = EXCLUDED.content_hash,
       source_hash  = EXCLUDED.source_hash,
       embedding    = EXCLUDED.embedding,
       embedded_at  = now()
 WHERE t.content_hash IS DISTINCT FROM EXCLUDED.content_hash
    OR t.text_version IS DISTINCT FROM EXCLUDED.text_version
"""


class CheckpointIncompatible(Exception):
    """Kontrol noktasi kayit defteriyle ya da kendi ozetleriyle uyusmuyor: hicbir sey yazilmaz."""


@dataclass
class ImportCounts:
    parts: int = 0
    parts_seen: int = 0
    rows: int = 0
    written: int = 0
    present: int = 0
    stale: int = 0
    missing: int = 0
    failed: int = 0
    limit_reached: bool = False
    wal_stopped: str | None = None
    interrupted: bool = False
    locked: bool = False
    incompatible: str | None = None
    aborted: bool = False
    errors: list[str] = field(default_factory=list)

    def note(self, message: str) -> None:
        if len(self.errors) < 5:
            self.errors.append(message[:100])

    def detail(self) -> dict[str, Any]:
        return {
            "parts": self.parts,
            "parts_seen": self.parts_seen,
            "rows": self.rows,
            "written": self.written,
            "present": self.present,
            "stale": self.stale,
            "missing": self.missing,
            "failed": self.failed,
        }


def decide_outcome(counts: ImportCounts) -> tuple[str, str | None]:
    """Karar 0174 sozlesmesi: sonuc yalnizca tipli sayaclardan, oncelik sirasiyla."""
    if counts.incompatible:
        return "failed", "incompatible_checkpoint"
    if counts.locked:
        return "skipped_locked", "lock_busy"
    if counts.aborted:
        return ("partial" if counts.written else "failed"), "consecutive_errors"
    if counts.wal_stopped:
        return "partial", "wal_backpressure"
    if counts.interrupted:
        return "partial", "interrupted"
    if counts.failed:
        return "partial", "item_errors"
    if counts.limit_reached:
        return "completed", "limit_reached"
    if counts.written == 0 and counts.stale == 0 and counts.missing == 0:
        return "no_input", "up_to_date"
    return "completed", None


# --- kontrol noktasi sozlesmesi --------------------------------------------------------------


def check_part_contract(part: Part, spec: ModelSpec) -> None:
    """Parca ust verisi kayit defteriyle birebir ayni olmali; degilse `CheckpointIncompatible`."""
    meta = part.meta
    problems: list[str] = []
    revision = spec.source.get("revision")
    expected: dict[str, Any] = {
        "format": CHECKPOINT_FORMAT,
        "model": spec.id,
        "revision": revision,
        "dimensions": spec.dimensions,
        "normalization": spec.normalization,
        "pooling": spec.pooling,
        "preprocessing_version": spec.preprocessing_version,
        "text_version": TEXT_VERSION,
    }
    for key, value in expected.items():
        if meta.get(key) != value:
            problems.append(f"{key}: {meta.get(key)!r} != {value!r}")
    if meta.get("rejected_ids") is None:
        problems.append("rejected_ids yok")
    if problems:
        raise CheckpointIncompatible(f"parca {part.seq}: " + "; ".join(problems))


@dataclass(frozen=True)
class PartRows:
    ids: list[int]
    content: list[bytes]
    source: list[bytes]
    vectors: list[tuple[float, ...]]


def read_part(store: CheckpointStore, part: Part, *, dimensions: int) -> PartRows:
    """Dosyalari okur, SHA-256 ve vektor kapilarini DOGRULAR. Bozuksa `CheckpointIncompatible`."""
    blobs = {}
    for suffix in ("ids", "hash", "f16"):
        path = store.path(part.seq, suffix)
        if not path.is_file():
            raise CheckpointIncompatible(f"parca {part.seq}: {suffix} dosyasi yok")
        data = path.read_bytes()
        if sha256_bytes(data) != part.meta["sha256"][suffix]:
            raise CheckpointIncompatible(f"parca {part.seq}: {suffix} SHA-256 uyusmuyor")
        blobs[suffix] = data
    n = part.rows
    if (
        len(blobs["ids"]) != n * ID_BYTES
        or len(blobs["hash"]) != n * 2 * HASH_BYTES
        or len(blobs["f16"]) != n * dimensions * 2
    ):
        raise CheckpointIncompatible(f"parca {part.seq}: dosya boyutu satir sayisiyla uyusmuyor")
    try:
        check_f16(blobs["f16"], dimensions)
    except ValueError as error:
        raise CheckpointIncompatible(f"parca {part.seq}: {error}") from error
    ids = [
        int.from_bytes(blobs["ids"][i : i + ID_BYTES], "little")
        for i in range(0, n * ID_BYTES, ID_BYTES)
    ]
    if len(set(ids)) != len(ids) or ids != sorted(ids):
        raise CheckpointIncompatible(f"parca {part.seq}: kimlikler tekrarli ya da sirasiz")
    if ids and (ids[0] != part.first_id or ids[-1] != part.last_id):
        raise CheckpointIncompatible(f"parca {part.seq}: kimlik araligi ust veriyle uyusmuyor")
    stride = 2 * HASH_BYTES
    hashes = blobs["hash"]
    return PartRows(
        ids=ids,
        content=[hashes[i * stride : i * stride + HASH_BYTES] for i in range(n)],
        source=[hashes[i * stride + HASH_BYTES : (i + 1) * stride] for i in range(n)],
        vectors=unpack_f16(blobs["f16"], dimensions),
    )


def validate_store(store: CheckpointStore, spec: ModelSpec) -> list[Part]:
    parts = store.parts()
    if not parts:
        raise CheckpointIncompatible("kontrol noktasinda tamamlanmis parca yok")
    for part in parts:
        check_part_contract(part, spec)
    return parts


# --- iceri alma -----------------------------------------------------------------------------


@dataclass
class Options:
    dry_run: bool = True
    batch: int = DEFAULT_BATCH
    max_rows: int | None = None
    sleep_s: float = 0.0
    only_parts: frozenset[int] | None = None
    deep: bool = True


class VectorImporter:
    def __init__(
        self,
        conn: psycopg.Connection,
        store: CheckpointStore,
        spec: ModelSpec,
        options: Options,
        *,
        governor: wal_pressure.WalGovernor | None = None,
        should_stop: Callable[[], bool] = lambda: False,
        stop_file: Path | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.conn = conn
        self.store = store
        self.spec = spec
        self.options = options
        self.governor = governor
        self.should_stop = should_stop
        self.stop_file = stop_file
        self.sleep = sleep
        self.counts = ImportCounts()
        family = registry().family(spec)
        require_writable(spec, spec.index_family)
        assert family.table is not None
        self.table = family.table
        self.dimensions = family.dimensions
        self.insert = insert_sql(self.table, self.dimensions)
        self.exists = existing_sql(self.table)
        table_sql(self.table, self.dimensions)  # beyaz liste dogrulamasi

    # -- ust duzey ------------------------------------------------------------------------
    def run(self) -> ImportCounts:
        if not self._lock():
            self.counts.locked = True
            return self.counts
        try:
            try:
                parts = validate_store(self.store, self.spec)
            except CheckpointIncompatible as error:
                self.counts.incompatible = str(error)[:200]
                return self.counts
            self.counts.parts_seen = len(parts)
            consecutive = 0
            for part in parts:
                if self.options.only_parts and part.seq not in self.options.only_parts:
                    continue
                if self._halted():
                    break
                try:
                    done = self._import_part(part)
                except CheckpointIncompatible as error:
                    self.counts.incompatible = str(error)[:200]
                    return self.counts
                except psycopg.Error as error:
                    self.conn.rollback()
                    self.counts.failed += part.rows
                    self.counts.note(f"parca {part.seq}: {type(error).__name__}")
                    consecutive += 1
                    if consecutive >= MAX_CONSECUTIVE_ERRORS:
                        self.counts.aborted = True
                        break
                    continue
                consecutive = 0
                if not done:
                    break
                self.counts.parts += 1
            return self.counts
        finally:
            self._unlock()

    def _halted(self) -> bool:
        if self.should_stop() or (self.stop_file is not None and self.stop_file.exists()):
            self.counts.interrupted = True
            return True
        return False

    # -- parca ------------------------------------------------------------------------------
    def _import_part(self, part: Part) -> bool:
        rows = read_part(self.store, part, dimensions=self.dimensions)
        part_written = 0
        step = max(1, self.options.batch)
        for lo in range(0, len(rows.ids), step):
            if self._halted():
                return False
            if self.options.max_rows is not None and self.counts.written >= self.options.max_rows:
                self.counts.limit_reached = True
                return False
            hi = lo + step
            written = self._import_slice(
                rows.ids[lo:hi], rows.content[lo:hi], rows.source[lo:hi], rows.vectors[lo:hi]
            )
            if written is None:
                return False
            part_written += written
            if self.options.sleep_s and not self.options.dry_run:
                self.sleep(self.options.sleep_s)
        if part_written and not self.options.dry_run:
            # Kural 9: parcanin cevrimdisi gomme emegi, ilk gercek yazimda bir kez kaydedilir.
            usage.record(
                self.conn,
                usage.ModelCall(
                    operation=USAGE_OPERATION,
                    model_version=self.spec.id,
                    units=int(part.meta.get("unique_texts", part.rows)),
                    cost_micros=0,
                ),
            )
            self.conn.commit()
        return True

    def _import_slice(
        self,
        ids: list[int],
        content: list[bytes],
        source: list[bytes],
        vectors: list[tuple[float, ...]],
    ) -> int | None:
        counts = self.counts
        counts.rows += len(ids)
        with self.conn.cursor() as cur:
            cur.execute(PRODUCT_SQL, {"ids": ids})
            products = {int(r[0]): (r[1], r[2]) for r in cur.fetchall()}
            cur.execute(self.exists, {"model": self.spec.id, "ids": ids})
            existing = {int(r[0]): (bytes(r[1]), int(r[2])) for r in cur.fetchall()}
        write: list[int] = []
        for index, product_id in enumerate(ids):
            current = products.get(product_id)
            if current is None:
                counts.missing += 1
                continue
            title, brand = current
            text = build_product_text(title, brand)
            if (
                content_hash(self.spec.id, text) != content[index]
                or source_hash(title or "", brand) != source[index]
            ):
                counts.stale += 1
                continue
            if existing.get(product_id) == (content[index], TEXT_VERSION):
                counts.present += 1
                continue
            write.append(index)
        if not write:
            return 0
        if self.options.dry_run:
            counts.written += len(write)
            return len(write)
        if not self._may_write():
            return None
        with self.conn.cursor() as cur:
            cur.execute(
                self.insert,
                {
                    "model": self.spec.id,
                    "text_version": TEXT_VERSION,
                    "ids": [ids[i] for i in write],
                    "content": [content[i] for i in write],
                    "source": [source[i] for i in write],
                    "vectors": [vector_literal(vectors[i]) for i in write],
                },
            )
        self.conn.commit()
        counts.written += len(write)
        return len(write)

    def _may_write(self) -> bool:
        """WAL geri basinci (karar 0134). False: kosu durur (neden sayaclara yazilir)."""
        if self.governor is None or self.governor.before_batch():
            return True
        if self.governor.stopped_reason is not None:
            self.counts.wal_stopped = self.governor.stopped_reason
        else:  # bekleme sirasinda durdurma istendi
            self.counts.interrupted = True
        return False

    # -- kilit -------------------------------------------------------------------------------
    def _lock(self) -> bool:
        with self.conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(%s)", (LOCK_KEY,))
            row = cur.fetchone()
        self.conn.commit()
        return bool(row and row[0])

    def _unlock(self) -> None:
        try:
            if self.conn.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
                self.conn.rollback()
            with self.conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(%s)", (LOCK_KEY,))
            self.conn.commit()
        except psycopg.Error as error:  # baglanti kapaninca kilit zaten birakilir
            logger.warning("danisma kilidi birakilamadi: %s", type(error).__name__)


# --- dogrulama (yazmaz) ----------------------------------------------------------------------


def verify_import(
    conn: psycopg.Connection,
    store: CheckpointStore,
    spec: ModelSpec,
    *,
    sample: int = 500,
    seed: int = 7,
) -> dict[str, Any]:
    """Tablodaki satirlari kontrol noktasiyla karsilastirir; hicbir sey yazmaz.

    Her parcada rastgele `sample` toplam satir secilir: veritabanindaki vektor kontrol noktasindaki
    vektorle AYNI (halfvec yuvarlamasi icinde), `content_hash` ayni olmalidir.
    """
    family = registry().family(spec)
    assert family.table is not None
    parts = validate_store(store, spec)
    rng = random.Random(seed)
    checkpoint_rows = sum(p.rows for p in parts)
    with conn.cursor() as cur:
        cur.execute(f"SELECT count(*) FROM {family.table} WHERE model_version = %s", (spec.id,))
        in_db = int(cur.fetchone()[0])  # type: ignore[index]
    pool: list[tuple[Part, int]] = [(p, i) for p in parts for i in range(p.rows)]
    chosen = rng.sample(pool, min(sample, len(pool)))
    by_part: dict[int, list[int]] = {}
    for part, index in chosen:
        by_part.setdefault(part.seq, []).append(index)
    mismatched = missing = checked = 0
    parts_by_seq = {p.seq: p for p in parts}
    for seq, indexes in by_part.items():
        rows = read_part(store, parts_by_seq[seq], dimensions=family.dimensions)
        ids = [rows.ids[i] for i in indexes]
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT product_id, content_hash, embedding::text
                      FROM {family.table}
                     WHERE model_version = %s AND product_id = ANY(%s::bigint[])""",
                (spec.id, ids),
            )
            db_rows = {int(r[0]): (bytes(r[1]), r[2]) for r in cur.fetchall()}
        for index in indexes:
            checked += 1
            got = db_rows.get(rows.ids[index])
            if got is None:
                missing += 1
                continue
            vector = [float(x) for x in got[1].strip("[]").split(",")]
            same = got[0] == rows.content[index] and all(
                abs(a - b) <= 1e-3 for a, b in zip(vector, rows.vectors[index], strict=True)
            )
            if not same:
                mismatched += 1
    return {
        "checkpoint_rows": checkpoint_rows,
        "in_database": in_db,
        "sampled": checked,
        "sample_missing": missing,
        "sample_mismatched": mismatched,
        "ok": missing == 0 and mismatched == 0,
    }


# --- komut satiri -----------------------------------------------------------------------------

_stop_requested = False


def _request_stop(signum: int, frame: FrameType | None) -> None:
    global _stop_requested
    _stop_requested = True
    logger.warning("durdurma istegi alindi (%s); mevcut dilim bitince cikilacak", signum)


def _should_stop() -> bool:
    return _stop_requested


def _is_local(url: str) -> bool:
    return (urlparse(url).hostname or "").lower() in {"localhost", "127.0.0.1", "::1"}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m enrich.vector_import", description=__doc__)
    parser.add_argument("command", choices=("plan", "run", "verify"))
    parser.add_argument("--ckpt", type=Path, required=True, help="offline_embed cikti dizini")
    parser.add_argument("--model", required=True, help="kayit defteri model kimligi")
    parser.add_argument(
        "--execute", action="store_true", help="run: gercek yazim (varsayilan kuru)"
    )
    parser.add_argument("--allow-remote", action="store_true", help="yerel olmayan veritabani")
    parser.add_argument("--batch", type=int, default=DEFAULT_BATCH, help="dilim basina satir")
    parser.add_argument("--max-rows", type=int, default=None, help="en fazla yazilacak satir")
    parser.add_argument("--sleep-ms", type=int, default=0, help="dilimler arasi bekleme")
    parser.add_argument("--parts", type=str, default=None, help="yalniz bu parcalar (1,2,5-8)")
    parser.add_argument("--sample", type=int, default=500, help="verify: rastgele satir sayisi")
    parser.add_argument("--verbose", action="store_true")
    return parser


def parse_parts(raw: str) -> frozenset[int]:
    out: set[int] = set()
    for chunk in filter(None, (c.strip() for c in raw.split(","))):
        lo, _, hi = chunk.partition("-")
        out.update(range(int(lo), int(hi or lo) + 1))
    return frozenset(out)


def _report(counts: ImportCounts, seconds: float, dry_run: bool) -> None:
    mode = "KURU CALISMA (yazim yok)" if dry_run else "GERCEK YAZIM"
    print(f"\n== vektor ice aktarimi: {mode} ==")
    for key, value in counts.detail().items():
        print(f"  {key:12s} {value}")
    if counts.incompatible:
        print(f"  UYUMSUZ: {counts.incompatible}")
    if counts.wal_stopped:
        print(f"  WAL geri basinci: {counts.wal_stopped}")
    for message in counts.errors:
        print(f"  hata: {message}")
    print(f"  sure {seconds:.1f} sn")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s"
    )
    if args.batch < 1 or args.batch > 2000:
        print("HATA: --batch 1..2000 olmali", file=sys.stderr)
        return 2
    try:
        spec = registry().get(args.model)
        require_writable(spec, spec.index_family)
    except RegistryError as error:
        print(f"HATA: {error}", file=sys.stderr)
        return 2
    store = CheckpointStore(args.ckpt)
    url = env("DATABASE_URL") or ""
    writing = args.command == "run" and args.execute
    if writing and not _is_local(url) and not args.allow_remote:
        print(
            "HATA: yerel olmayan veritabanina yazim icin --allow-remote gerekir "
            "(ADR 0195: insan onayi olmadan kullanilmaz).",
            file=sys.stderr,
        )
        return 2
    only = parse_parts(args.parts) if args.parts else None
    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)
    started = time.monotonic()

    if args.command == "verify":
        with connect() as conn:
            conn.read_only = True
            try:
                result = verify_import(conn, store, spec, sample=args.sample)
            except CheckpointIncompatible as error:
                print(f"UYUMSUZ: {error}", file=sys.stderr)
                return 1
        for key, value in result.items():
            print(f"  {key:18s} {value}")
        return 0 if result["ok"] else 1

    options = Options(
        dry_run=not writing,
        batch=args.batch,
        max_rows=args.max_rows,
        sleep_s=args.sleep_ms / 1000,
        only_parts=only,
    )
    stop_file = args.ckpt / STOP_FILE
    if not writing:
        with connect() as conn:
            conn.read_only = True
            counts = VectorImporter(
                conn, store, spec, options, should_stop=_should_stop, stop_file=stop_file
            ).run()
        _report(counts, time.monotonic() - started, True)
        name, reason = decide_outcome(counts)
        return job_run.outcome(name, reason).exit_code

    with job_run.track(JOB, outcomes=True) as run, connect() as conn:
        governor = wal_pressure.WalGovernor.for_connection(conn, should_stop=_should_stop)
        counts = VectorImporter(
            conn,
            store,
            spec,
            options,
            governor=governor,
            should_stop=_should_stop,
            stop_file=stop_file,
        ).run()
        run.detail.update(counts.detail())
        run.detail.update(governor.stats.as_detail())
        name, reason = decide_outcome(counts)
        if counts.wal_stopped:
            run.error_summary = f"WAL geri basinci: {counts.wal_stopped}"
        elif counts.incompatible:
            run.error_summary = f"kontrol noktasi uyumsuz: {counts.incompatible}"[:300]
        elif counts.errors:
            run.error_summary = "; ".join(counts.errors)[:300]
        code = run.set_outcome(name, reason)
    _report(counts, time.monotonic() - started, False)
    return code


if __name__ == "__main__":
    sys.exit(main())
