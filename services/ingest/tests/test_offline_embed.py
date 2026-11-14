"""Cevrimdisi embedding (E4): kontrol noktasi, devam, idempotans, frenler, kanarya kapisi."""

from __future__ import annotations

import hashlib
import json
import math
import struct
from datetime import UTC, datetime
from pathlib import Path

import pytest

from enrich import offline_embed as oe
from enrich.canary import CanaryFailed
from enrich.client import EmbeddingBatch, EmbeddingError, EmbeddingRejected
from enrich.registry import registry

MODEL = "bge-m3-5617a9f6"
SPEC = registry().get(MODEL)
DIM = SPEC.dimensions


def unit_vector(text: str) -> list[float]:
    seed = hashlib.sha256(text.encode()).digest()
    raw = [((seed[i % 32] + i * 7) % 251) / 251.0 - 0.5 for i in range(DIM)]
    norm = math.sqrt(sum(v * v for v in raw))
    return [v / norm for v in raw]


class FakeProvider:
    def __init__(self, *, reject: str | None = None, fail_times: int = 0) -> None:
        self.calls: list[list[str]] = []
        self.reject = reject
        self.fail_times = fail_times
        self.latencies_ms: list[float] = []

    def embed_texts(self, texts):
        if self.fail_times > 0:
            self.fail_times -= 1
            raise EmbeddingError("gecici")
        if self.reject is not None and any(self.reject in t for t in texts):
            raise EmbeddingRejected("bozuk")
        self.calls.append(list(texts))
        self.latencies_ms.append(1.0)
        return EmbeddingBatch(
            vectors=[unit_vector(t) for t in texts], model_version=MODEL, total_tokens=len(texts)
        )


class FakeFetcher:
    def __init__(self, rows: list[tuple[int, str | None, str | None]]) -> None:
        self.rows = rows
        self.calls: list[tuple[int, int]] = []

    def fetch(self, after_id, limit):
        self.calls.append((after_id, limit))
        return [r for r in self.rows if r[0] > after_id][:limit]


def catalog(n: int, start: int = 100) -> list[tuple[int, str | None, str | None]]:
    return [(start + i * 3, f"Urun basligi {i}", None) for i in range(n)]


def ok_canary(spec, factory):
    class R:
        cosines = [("passage", "x", 0.99998)]

    return R()


def failing_canary(spec, factory):
    raise CanaryFailed("yanlis havuzlama")


def runner(tmp_path: Path, fetcher, provider, *, target, part_size=10, **kw) -> oe.Runner:
    guards = kw.pop(
        "guards",
        oe.Guards(min_free_bytes=0, min_mem_available_bytes=0, max_load=1e9, quiet_windows=[]),
    )
    return oe.Runner(
        SPEC,
        oe.CheckpointStore(tmp_path),
        fetcher,
        lambda purpose: provider,
        target=target,
        part_size=part_size,
        batch_size=4,
        start_after=0,
        guards=guards,
        canary_every=kw.pop("canary_every", 0),
        sleep=kw.pop("sleep", lambda s: None),
        canary=kw.pop("canary", ok_canary),
        **kw,
    )


def test_writes_parts_until_target_and_verifies(tmp_path: Path) -> None:
    provider = FakeProvider()
    stats = runner(tmp_path, FakeFetcher(catalog(40)), provider, target=25).run()
    assert stats.outcome == "completed" and stats.stop_reason == "target_reached"
    store = oe.CheckpointStore(tmp_path)
    parts = store.parts()
    assert [p.rows for p in parts] == [10, 10, 5]
    report = store.verify(deep=True, dimensions=DIM)
    assert report["problems"] == [] and report["rows"] == 25 and report["models"] == [MODEL]
    ids = struct.unpack("<10q", store.path(1, "ids").read_bytes())
    assert list(ids) == [100 + i * 3 for i in range(10)]
    meta = parts[0].meta
    assert meta["revision"] == SPEC.source["revision"] and meta["pooling"] == "cls"
    assert meta["dimensions"] == 1024 and meta["text_version"] >= 1


def test_resume_never_reprocesses_or_overwrites(tmp_path: Path) -> None:
    rows = catalog(40)
    first = FakeProvider()
    runner(tmp_path, FakeFetcher(rows), first, target=10).run()
    before = oe.CheckpointStore(tmp_path).path(1, "f16").read_bytes()
    second = FakeProvider()
    stats = runner(tmp_path, FakeFetcher(rows), second, target=25).run()
    assert stats.embedded == 15
    embedded = [t for call in second.calls for t in call]
    assert "Urun basligi 0" not in embedded and len(embedded) == 15
    assert oe.CheckpointStore(tmp_path).path(1, "f16").read_bytes() == before
    again = runner(tmp_path, FakeFetcher(rows), FakeProvider(), target=25).run()
    assert again.outcome == "no_input" and again.stop_reason == "target_reached"


def test_duplicates_embedded_once_and_empty_titles_skipped(tmp_path: Path) -> None:
    rows = [(1, "Ayni baslik", None), (2, "Ayni baslik", None), (3, "  ", None), (4, "Diger", None)]
    provider = FakeProvider()
    stats = runner(tmp_path, FakeFetcher(rows), provider, target=10).run()
    assert sum(len(c) for c in provider.calls) == 2
    assert stats.embedded == 3 and stats.skipped_empty == 1 and stats.duplicates_in_part == 1
    store = oe.CheckpointStore(tmp_path)
    vectors = oe.unpack_f16(store.path(1, "f16").read_bytes(), DIM)
    assert vectors[0] == vectors[1]


def test_permanent_rejection_isolated_to_single_product(tmp_path: Path) -> None:
    rows = [(i, f"Urun {i}" + (" BOZUK" if i == 5 else ""), None) for i in range(1, 9)]
    stats = runner(tmp_path, FakeFetcher(rows), FakeProvider(reject="BOZUK"), target=8).run()
    part = oe.CheckpointStore(tmp_path).parts()[0]
    assert stats.rejected == 1 and part.meta["rejected_ids"] == [5] and part.rows == 7


def test_canary_failure_blocks_any_output(tmp_path: Path) -> None:
    stats = runner(
        tmp_path, FakeFetcher(catalog(5)), FakeProvider(), target=5, canary=failing_canary
    ).run()
    assert stats.outcome == "failed" and stats.stop_reason == "canary_failed"
    assert oe.CheckpointStore(tmp_path).parts() == []


def test_disk_floor_stops_before_writing(tmp_path: Path) -> None:
    guards = oe.Guards(
        min_free_bytes=1 << 62, min_mem_available_bytes=0, max_load=1e9, quiet_windows=[]
    )
    stats = runner(tmp_path, FakeFetcher(catalog(5)), FakeProvider(), target=5, guards=guards).run()
    assert stats.stop_reason == "disk_floor" and stats.outcome == "failed"
    assert oe.CheckpointStore(tmp_path).parts() == []


def test_stop_file_stops_gracefully(tmp_path: Path) -> None:
    (tmp_path / oe.STOP_FILE).write_text("")
    stats = runner(tmp_path, FakeFetcher(catalog(5)), FakeProvider(), target=5).run()
    assert stats.stop_reason == "stop_requested"


def test_quiet_window_waits_then_gives_up(tmp_path: Path) -> None:
    guards = oe.Guards(
        min_free_bytes=0,
        min_mem_available_bytes=0,
        max_load=1e9,
        quiet_windows=oe.parse_windows("01:20-02:15"),
        max_wait_s=60,
    )
    slept: list[float] = []
    stats = runner(
        tmp_path,
        FakeFetcher(catalog(5)),
        FakeProvider(),
        target=5,
        guards=guards,
        sleep=slept.append,
        now=lambda: datetime(2026, 11, 14, 1, 30, tzinfo=UTC),
    ).run()
    assert stats.stop_reason == "busy_timeout" and slept == [30.0, 30.0]


def test_transient_errors_stop_without_partial_part(tmp_path: Path) -> None:
    stats = runner(tmp_path, FakeFetcher(catalog(5)), FakeProvider(fail_times=10), target=5).run()
    assert stats.stop_reason == "provider_errors" and stats.outcome == "failed"
    store = oe.CheckpointStore(tmp_path)
    assert store.parts() == [] and not list(store.parts_dir.glob("*.json"))


def test_transient_error_recovers(tmp_path: Path) -> None:
    stats = runner(tmp_path, FakeFetcher(catalog(5)), FakeProvider(fail_times=1), target=5).run()
    assert stats.outcome == "completed" and stats.embedded == 5 and stats.failures == 1


def test_verify_detects_tampering(tmp_path: Path) -> None:
    runner(tmp_path, FakeFetcher(catalog(10)), FakeProvider(), target=10).run()
    store = oe.CheckpointStore(tmp_path)
    path = store.path(1, "f16")
    data = bytearray(path.read_bytes())
    data[0] ^= 0xFF
    path.write_bytes(bytes(data))
    assert store.verify(deep=True)["problems"]


def test_existing_part_is_never_overwritten(tmp_path: Path) -> None:
    runner(tmp_path, FakeFetcher(catalog(10)), FakeProvider(), target=10).run()
    with pytest.raises(RuntimeError):
        oe.CheckpointStore(tmp_path).write_part(1, b"", b"", b"", {})


def test_f16_roundtrip_and_norm_check() -> None:
    vec = unit_vector("x")
    data = oe.pack_f16([vec], DIM)
    assert len(data) == DIM * 2
    oe.check_f16(data, DIM)
    with pytest.raises(ValueError):
        oe.check_f16(oe.pack_f16([[v * 2 for v in vec]], DIM), DIM)


def test_window_parsing_handles_midnight() -> None:
    windows = oe.parse_windows("23:30-00:30")
    assert oe.in_window(23 * 60 + 45, windows) and oe.in_window(10, windows)
    assert not oe.in_window(60, windows)


def test_run_log_and_status(tmp_path: Path, capsys) -> None:
    store = oe.CheckpointStore(tmp_path)
    store.ensure()
    store.append_run({"outcome": "completed"})
    assert oe.main(["status", "--out", str(tmp_path)]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["last_run"] == {"outcome": "completed"} and out["parts"] == 0


def test_concurrency_and_length_order_do_not_change_output(tmp_path: Path) -> None:
    rows = [
        (i, "kisa" if i % 3 else f"cok daha uzun bir urun basligi {i}", None) for i in range(1, 60)
    ]
    rows = [(i, f"{t} {i}", b) for i, t, b in rows]
    serial = tmp_path / "serial"
    parallel = tmp_path / "parallel"
    runner(serial, FakeFetcher(rows), FakeProvider(), target=59, part_size=30).run()
    stats = runner(
        parallel, FakeFetcher(rows), FakeProvider(), target=59, part_size=30, concurrency=3
    ).run()
    assert stats.outcome == "completed" and stats.embedded == 59
    for seq in (1, 2):
        for suffix in ("ids", "hash", "f16"):
            a = oe.CheckpointStore(serial).path(seq, suffix).read_bytes()
            b = oe.CheckpointStore(parallel).path(seq, suffix).read_bytes()
            assert a == b


def test_batches_are_sorted_by_length(tmp_path: Path) -> None:
    rows = [(1, "x" * 50, None), (2, "y", None), (3, "z" * 20, None), (4, "w" * 5, None)]
    provider = FakeProvider()
    runner(tmp_path, FakeFetcher(rows), provider, target=4).run()
    sent = [t for call in provider.calls for t in call]
    assert [len(t) for t in sent] == sorted(len(t) for t in sent)


def _titles(rows):
    table = {pid: (title, brand) for pid, title, brand in rows}
    return lambda ids: {i: table[i] for i in ids if i in table}


def test_audit_passes_on_correct_mapping(tmp_path: Path) -> None:
    rows = catalog(40)
    runner(tmp_path, FakeFetcher(rows), FakeProvider(), target=40, concurrency=3).run()
    store = oe.CheckpointStore(tmp_path)
    report = oe.audit(SPEC, store, _titles(rows), FakeProvider(), sample=25)
    assert report["passed"] and report["checked"] == 25 and report["misaligned"] == 0


def test_audit_detects_swapped_vectors(tmp_path: Path) -> None:
    rows = catalog(20)
    runner(tmp_path, FakeFetcher(rows), FakeProvider(), target=20, part_size=20).run()
    store = oe.CheckpointStore(tmp_path)
    data = bytearray(store.path(1, "f16").read_bytes())
    row = DIM * 2
    data[0:row], data[row : 2 * row] = data[row : 2 * row], data[0:row]
    store.path(1, "f16").write_bytes(bytes(data))
    report = oe.audit(SPEC, store, _titles(rows), FakeProvider(), sample=20)
    assert not report["passed"] and report["misaligned"] == 2


def test_audit_reports_changed_and_missing_products(tmp_path: Path) -> None:
    rows = catalog(10)
    runner(tmp_path, FakeFetcher(rows), FakeProvider(), target=10).run()
    now = {pid: (title, brand) for pid, title, brand in rows}
    now[rows[0][0]] = ("Yeni baslik", None)
    del now[rows[1][0]]
    store = oe.CheckpointStore(tmp_path)
    fetch = lambda ids: {i: now[i] for i in ids if i in now}  # noqa: E731
    report = oe.audit(SPEC, store, fetch, FakeProvider(), sample=10)
    assert report["text_changed"] == 1 and report["missing_product"] == 1 and report["passed"]
