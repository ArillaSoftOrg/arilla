"""Checkpoint'li, kaldigi yerden devam eden toplu oneri kosusu (karar 0155).

Veritabanini YALNIZCA OKUR (salt okunur islem); urun kategorisi yazilmaz. Her parti: cikti
dosyasina yaz + fsync -> SQLite kontrol noktasi (son urun, cikti ofseti, sayaclar, surumler).
Yeniden baslatma, ciktiyi kayitli ofsete KIRPAR (yarim/yazilmamis parti gitsin), boylece her urun
tam bir kez yazilir. Ayni (baslik, kaynak yolu) cifti ayni calismada yeniden hesaplanmaz.
"""

from __future__ import annotations

import contextlib
import csv
import hashlib
import json
import os
import signal
import sqlite3
import time
from collections import OrderedDict
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

from classify.suggest.engine import SUGGEST_VERSION, Item, Suggester, Suggestion
from classify.text import path_norm

OUT_FILE = "suggestions.jsonl"
STATE_FILE = "state.sqlite"
RUN_FILE = "run.json"
DUP_CACHE = 100_000


@dataclass(frozen=True)
class Row:
    product_id: int
    title: str
    source_raw: str | None
    #: Urunun MEVCUT kategorisi (salt bilgi; oneri bunu degistirmez).
    current_category_id: int | None = None


class RunMismatch(RuntimeError):
    """Kontrol noktasi baska bir model/agac/kural surumuyle yazilmis."""


def tsv_batches(path: str | Path, *, after_id: int, size: int) -> Iterator[list[Row]]:
    """`id<TAB>baslik<TAB>kaynak_yolu` (basliksiz) dosyadan, kimlik sirasiyla partiler."""
    rows: list[Row] = []
    with Path(path).open(encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2 or not parts[0].isdigit():
                continue
            pid = int(parts[0])
            if pid <= after_id:
                continue
            rows.append(Row(pid, parts[1], parts[2] if len(parts) > 2 and parts[2] else None))
    rows.sort(key=lambda r: r.product_id)
    for start in range(0, len(rows), size):
        yield rows[start : start + size]


def db_batches(conn, *, after_id: int, size: int, merchant_slug: str | None) -> Iterator[list[Row]]:  # noqa: ANN001
    """Urunleri kimlik sirasiyla, salt okunur okur (`classify.run.SELECT_BATCH`)."""
    from classify.run import SELECT_BATCH

    merchant_id = None
    if merchant_slug:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM merchant WHERE slug = %s", (merchant_slug,))
            found = cur.fetchone()
        if found is None:
            raise SystemExit(f"magaza yok: {merchant_slug}")
        merchant_id = found[0]
    last = after_id
    while True:
        with conn.cursor() as cur:
            cur.execute(SELECT_BATCH, {"after": last, "merchant_id": merchant_id, "limit": size})
            fetched = cur.fetchall()
        conn.rollback()  # okuma islemini kapat (salt okunur, kilit tutma)
        if not fetched:
            return
        yield [Row(int(r[0]), str(r[1]), r[6], r[3]) for r in fetched]
        last = int(fetched[-1][0])


def _key(model: str, tree: str, row: Row) -> bytes:
    text = " ".join(row.title.split()).lower() + "|" + path_norm(row.source_raw or "")
    return hashlib.sha256(f"{model}|{tree}|{SUGGEST_VERSION}|{text}".encode()).digest()[:12]


def _rss_mb() -> float | None:
    try:
        import psutil

        return psutil.Process().memory_info().rss / 1e6
    except ImportError:
        return None


class Runner:
    def __init__(
        self,
        out_dir: str | Path,
        suggester: Suggester,
        *,
        model_version: str,
        tree_version: str,
        restart: bool = False,
    ) -> None:
        self.dir = Path(out_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.suggester = suggester
        self.versions = {
            "model": model_version,
            "tree": tree_version,
            "suggest": str(SUGGEST_VERSION),
        }
        self.out_path = self.dir / OUT_FILE
        self._state_path = self.dir / STATE_FILE
        self._db: sqlite3.Connection | None = None
        if restart:
            for p in (self.out_path, self._state_path, self.dir / RUN_FILE):
                p.unlink(missing_ok=True)
        try:
            self._init_meta()
        except RunMismatch:
            self.close()
            raise
        self._stop = False
        self._cache: OrderedDict[bytes, Suggestion] = OrderedDict()

    @property
    def db(self) -> sqlite3.Connection:
        if self._db is None:
            self._db = sqlite3.connect(self._state_path)
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
            )
        return self._db

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None

    # -- kontrol noktasi -------------------------------------------------------------------
    def _get(self, key: str, default: str = "0") -> str:
        row = self.db.execute("SELECT v FROM meta WHERE k = ?", (key,)).fetchone()
        return row[0] if row else default

    def _set(self, **kv: object) -> None:
        for k, v in kv.items():
            self.db.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", (k, str(v)))

    def _init_meta(self) -> None:
        stored = {k: self._get("v_" + k, "") for k in self.versions}
        if any(stored.values()) and stored != self.versions:
            raise RunMismatch(
                f"kontrol noktasi {stored} ile yazilmis, simdi {self.versions}: --restart ya da "
                "yeni cikti dizini kullanin"
            )
        self._set(**{"v_" + k: v for k, v in self.versions.items()})
        self.db.commit()

    @property
    def last_id(self) -> int:
        return int(self._get("last_id"))

    def counters(self) -> dict[str, int]:
        return json.loads(self._get("counters", "{}"))

    # -- kosu --------------------------------------------------------------------------------
    def run(
        self,
        batches: Callable[[int], Iterable[Sequence[Row]]],
        *,
        max_products: int | None = None,
        max_seconds: float | None = None,
        max_rss_mb: float | None = None,
        sleep_ms: int = 0,
        annotate: Callable[[Row], dict[str, object]] | None = None,
    ) -> dict[str, object]:
        if max_rss_mb is not None and _rss_mb() is None:
            raise SystemExit("--max-rss-mb icin `psutil` gerekir (pip install psutil)")
        self._truncate_to_checkpoint()
        counters = {k: int(v) for k, v in self.counters().items()}
        old_handlers = self._install_signals()
        started = time.monotonic()
        peak = 0.0
        processed = 0
        embed_seconds = 0.0
        stop_reason = "bitti"
        try:
            with self.out_path.open("ab") as out:
                for batch in batches(self.last_id):
                    if self._stop:
                        stop_reason = "sinyal"
                        break
                    if max_seconds is not None and time.monotonic() - started >= max_seconds:
                        stop_reason = "sure"
                        break
                    if max_products is not None and processed >= max_products:
                        stop_reason = "urun_siniri"
                        break
                    if max_products is not None:
                        batch = batch[: max_products - processed]
                    t0 = time.monotonic()
                    results = self._suggest(batch, counters)
                    embed_seconds += time.monotonic() - t0
                    lines = []
                    for row, sug in zip(batch, results, strict=True):
                        record = {
                            "product_id": row.product_id,
                            "title": row.title,
                            "source_raw": row.source_raw,
                            "current_category_id": row.current_category_id,
                            "v": "|".join(self.versions.values()),
                            **sug.as_dict(),
                            **(annotate(row) if annotate else {}),
                        }
                        lines.append(json.dumps(record, ensure_ascii=False))
                        counters[sug.status] = counters.get(sug.status, 0) + 1
                    out.write(("\n".join(lines) + "\n").encode("utf-8"))
                    out.flush()
                    os.fsync(out.fileno())
                    processed += len(batch)
                    counters["toplam"] = counters.get("toplam", 0) + len(batch)
                    self._set(
                        last_id=batch[-1].product_id,
                        out_bytes=out.tell(),
                        counters=json.dumps(counters),
                    )
                    self.db.commit()
                    rss = _rss_mb()
                    if rss:
                        peak = max(peak, rss)
                    if max_rss_mb is not None and rss and rss > max_rss_mb:
                        stop_reason = "bellek_siniri"
                        break
                    if sleep_ms:
                        time.sleep(sleep_ms / 1000)
        finally:
            self._restore_signals(old_handlers)
        wall = time.monotonic() - started
        last_id = self.last_id
        self.close()
        summary = {
            "durum": stop_reason,
            "versions": self.versions,
            "bu_kosuda_urun": processed,
            "toplam": counters.get("toplam", 0),
            "sayaclar": counters,
            "son_urun_id": last_id,
            "sure_sn": round(wall, 2),
            "model_sure_sn": round(embed_seconds, 2),
            "urun_sn": round(processed / wall, 1) if wall > 0 else 0.0,
            "tepe_rss_mb": round(peak, 1) if peak else None,
            "tekrar_onbellek_isabet": counters.get("onbellek", 0),
        }
        (self.dir / RUN_FILE).write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return summary

    def _suggest(self, batch: Sequence[Row], counters: dict[str, int]) -> list[Suggestion]:
        model, tree = self.versions["model"], self.versions["tree"]
        keys = [_key(model, tree, r) for r in batch]
        results: list[Suggestion | None] = [None] * len(batch)
        todo: dict[bytes, list[int]] = {}
        for i, k in enumerate(keys):
            hit = self._cache.get(k)
            if hit is not None:
                self._cache.move_to_end(k)
                results[i] = hit
                counters["onbellek"] = counters.get("onbellek", 0) + 1
            else:
                todo.setdefault(k, []).append(i)
        if todo:
            firsts = [idxs[0] for idxs in todo.values()]
            computed = self.suggester.suggest(
                [Item(batch[i].title, batch[i].source_raw) for i in firsts]
            )
            for (k, idxs), sug in zip(todo.items(), computed, strict=True):
                for i in idxs:
                    results[i] = sug
                if len(idxs) > 1:
                    counters["onbellek"] = counters.get("onbellek", 0) + len(idxs) - 1
                self._cache[k] = sug
            while len(self._cache) > DUP_CACHE:
                self._cache.popitem(last=False)
        return [r for r in results if r is not None]

    def _truncate_to_checkpoint(self) -> None:
        size = int(self._get("out_bytes"))
        if self.out_path.exists() and self.out_path.stat().st_size > size:
            with self.out_path.open("r+b") as f:
                f.truncate(size)
        elif not self.out_path.exists():
            self.out_path.touch()

    def _install_signals(self):  # noqa: ANN202
        def stop(_signum, _frame) -> None:  # noqa: ANN001
            self._stop = True

        handlers = {}
        for sig in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(ValueError):  # ana parcacik degilse sinyal kurulmaz
                handlers[sig] = signal.signal(sig, stop)
        return handlers

    def _restore_signals(self, handlers) -> None:  # noqa: ANN001
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


def export(out_dir: str | Path, dest: str | Path, fmt: str = "csv", top: int = 3) -> int:
    """Cikti satirlarini (urun basina SON kayit) CSV ya da JSON olarak disa aktarir."""
    records: dict[int, dict[str, object]] = {}
    with (Path(out_dir) / OUT_FILE).open(encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            records[int(rec["product_id"])] = rec
    ordered = [records[k] for k in sorted(records)]
    if fmt == "json":
        Path(dest).write_text(
            json.dumps(ordered, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
        )
        return len(ordered)
    cols = ["urun_id", "baslik", "kaynak_yolu", "durum", "neden"]
    for k in range(1, top + 1):
        cols += [f"o{k}_id", f"o{k}_yol", f"o{k}_z", f"o{k}_kaynak", f"o{k}_gerekce"]
    with Path(dest).open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for rec in ordered:
            row = [
                rec["product_id"],
                rec["title"],
                rec["source_raw"] or "",
                rec["status"],
                rec["reason"],
            ]
            cands = rec["candidates"][:top]
            for k in range(top):
                if k < len(cands):
                    c = cands[k]
                    row += [c["category_id"], c["name_path"], c["z"], c["source"], c["rationale"]]
                else:
                    row += ["", "", "", "", ""]
            w.writerow(row)
    return len(ordered)
