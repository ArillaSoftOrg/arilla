"""WAL geri basinci (karar 0134): saf mantik, sahte saat + sahte arsiv modeli. Veritabani yok."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from db.wal_pressure import MIB, WalGovernor, WalPolicy, WalSample, archived_upto

SEG = 16 * MIB


def test_archived_upto_full_segment_is_segment_end() -> None:
    # 0xA * 256 + 0xFF = 2815. segment; arsiv bu segmentin SONUNA kadar tamam.
    assert archived_upto("000000010000000A000000FF", SEG) == (0xA * 256 + 0xFF + 1) * SEG


def test_archived_upto_partial_and_backup_are_conservative() -> None:
    start = (0xA * 256 + 0x10) * SEG
    assert archived_upto("000000010000000A00000010.partial", SEG) == start
    assert archived_upto("000000010000000A00000010.00000028.backup", SEG) == start


def test_archived_upto_unknown() -> None:
    assert archived_upto(None, SEG) is None
    assert archived_upto("00000002.history", SEG) is None
    assert archived_upto("garbage", SEG) is None


def test_policy_rejects_inverted_thresholds() -> None:
    with pytest.raises(ValueError):
        WalPolicy(target_bytes=2 * MIB, pause_bytes=MIB, resume_bytes=MIB // 2)
    with pytest.raises(ValueError):
        WalPolicy(target_bytes=MIB, pause_bytes=2 * MIB, resume_bytes=MIB)


@dataclass
class FakeWorld:
    """Sahte PostgreSQL: WAL uretimi partiyle, arsiv sabit hizla (segment adimli) ilerler."""

    archive_rate: float  # bayt/sn
    now: float = 0.0
    insert: int = 0
    archived: float = 0.0
    failing: bool = False
    archive_mode: str = "on"
    unknown: bool = False
    samples: int = 0

    def advance(self, seconds: float) -> None:
        self.now += seconds
        if not self.failing:
            self.archived = min(float(self.insert), self.archived + self.archive_rate * seconds)

    def write(self, wal_bytes: int, seconds: float) -> None:
        self.insert += wal_bytes
        self.advance(seconds)

    def sample(self) -> WalSample:
        self.samples += 1
        done_segs = int(self.archived // SEG)
        return WalSample(
            at=self.now,
            insert_lsn=self.insert,
            archive_mode=self.archive_mode,
            seg_size=SEG,
            archived_upto=None if self.unknown else done_segs * SEG,
            archived_count=done_segs,
            failed_count=1 if self.failing else 0,
            archive_failing=self.failing,
        )

    @property
    def lag(self) -> int:
        return self.insert - int(self.archived // SEG) * SEG


POLICY = WalPolicy(
    target_bytes=256 * MIB,
    pause_bytes=512 * MIB,
    resume_bytes=128 * MIB,
    max_sleep_s=30,
    max_pause_s=600,
    failing_grace_s=120,
    poll_s=5,
    rate_window_s=120,
)


def governor(world: FakeWorld, policy: WalPolicy = POLICY, stop=lambda: False) -> WalGovernor:
    return WalGovernor(
        sample=world.sample,
        policy=policy,
        should_stop=stop,
        sleep=world.advance,
        clock=lambda: world.now,
    )


def test_archive_off_never_waits() -> None:
    w = FakeWorld(archive_rate=0, archive_mode="off")
    g = governor(w)
    for _ in range(50):
        assert g.before_batch()
        w.write(64 * MIB, 1.0)
    assert g.stats.paced_sleeps == 0 and g.stats.pauses == 0


def test_below_target_runs_at_full_speed() -> None:
    w = FakeWorld(archive_rate=200 * MIB)
    g = governor(w)
    for _ in range(100):
        t0 = w.now
        assert g.before_batch()
        assert w.now == t0  # hic uyku yok
        w.write(20 * MIB, 1.0)
    assert g.stats.paced_sleeps == 0


def test_pause_waits_until_resume_threshold_hysteresis() -> None:
    w = FakeWorld(archive_rate=10 * MIB)
    w.insert = 600 * MIB  # gecikme > pause
    g = governor(w)
    assert g.before_batch()
    # resume (128 MB) altina inmeden donmez; pause ile resume arasinda beklemeye devam eder.
    assert w.lag <= POLICY.resume_bytes + SEG
    assert g.stats.pauses == 1
    assert g.stats.paused_seconds >= (600 - 128 - 16) / 10


def test_pause_longer_than_limit_stops_job_and_stays_stopped() -> None:
    w = FakeWorld(archive_rate=0.1 * MIB)
    w.insert = 600 * MIB
    g = governor(w)
    assert not g.before_batch()
    assert g.stopped_reason is not None and "arsivlenmemis WAL" in g.stopped_reason
    assert w.now >= POLICY.max_pause_s
    assert not g.before_batch()


def test_archive_failure_blocks_writes_then_recovers() -> None:
    w = FakeWorld(archive_rate=50 * MIB, failing=True)
    w.insert = 32 * MIB
    calls = {"n": 0}

    def sleep(s: float) -> None:
        w.advance(s)
        calls["n"] += 1
        if calls["n"] == 6:  # ~30 sn sonra arsiv duzelir
            w.failing = False

    g = WalGovernor(sample=w.sample, policy=POLICY, sleep=sleep, clock=lambda: w.now)
    assert g.before_batch()
    assert g.stats.failing_seconds >= 25
    assert g.stopped_reason is None


def test_archive_failure_beyond_grace_stops() -> None:
    w = FakeWorld(archive_rate=50 * MIB, failing=True)
    g = governor(w)
    assert not g.before_batch()
    assert g.stopped_reason is not None and "basarisiz" in g.stopped_reason
    assert POLICY.failing_grace_s <= w.now <= POLICY.failing_grace_s + POLICY.poll_s


def test_stop_request_interrupts_pause_within_poll_interval() -> None:
    w = FakeWorld(archive_rate=0.1 * MIB)
    w.insert = 600 * MIB
    stop_at = 42.0
    g = governor(w, stop=lambda: w.now >= stop_at)
    assert not g.before_batch()
    assert g.stopped_reason is None  # durdurma istegi: WAL nedeniyle degil
    assert w.now <= stop_at + POLICY.poll_s


def test_stop_request_interrupts_pacing_sleep() -> None:
    w = FakeWorld(archive_rate=1 * MIB)
    g = governor(w, stop=lambda: w.now >= 3.0)
    w.insert = 300 * MIB  # target ustu, pause alti
    w.archived = 16 * MIB
    assert g.before_batch()  # ilk olcum: taban
    w.write(64 * MIB, 1.0)
    assert not g.before_batch()
    assert w.now <= 3.0 + POLICY.poll_s


def test_unknown_archive_position_waits_instead_of_writing_blind() -> None:
    w = FakeWorld(archive_rate=10 * MIB, unknown=True)
    calls = {"n": 0}

    def sleep(s: float) -> None:
        w.advance(s)
        calls["n"] += 1
        if calls["n"] == 3:
            w.unknown = False  # ilk segment arsivlendi

    g = WalGovernor(sample=w.sample, policy=POLICY, sleep=sleep, clock=lambda: w.now)
    assert g.before_batch()
    assert w.now >= 10 and g.stats.pauses == 1


def test_unknown_archive_position_forever_stops_after_max_pause() -> None:
    w = FakeWorld(archive_rate=10 * MIB, unknown=True)
    g = governor(w)
    assert not g.before_batch()
    assert g.stopped_reason is not None and "olculemiyor" in g.stopped_reason


def test_unknown_archive_rate_above_target_sleeps_bounded() -> None:
    w = FakeWorld(archive_rate=0.0)
    w.insert = 300 * MIB
    w.archived = 16 * MIB
    g = governor(w)
    assert g.before_batch()
    w.write(16 * MIB, 1.0)
    t0 = w.now
    assert g.before_batch()
    assert w.now - t0 == pytest.approx(POLICY.max_sleep_s)


@pytest.mark.parametrize("archive_mb_s", [5.0, 20.0, 60.0])
def test_simulation_converges_to_archive_rate_without_hitting_pause(archive_mb_s: float) -> None:
    """Uretim kapasitesi arsivden cok yuksek (parti 1 sn'de 80 MB). Yonetici gecikmeyi
    duraklama sinirinin altinda tutar ve verim arsiv hizina yakinsar (ac birakmaz)."""
    w = FakeWorld(archive_rate=archive_mb_s * MIB)
    g = governor(w)
    max_lag = 0
    while w.now < 4 * 3600:
        assert g.before_batch()
        w.write(80 * MIB, 1.0)
        max_lag = max(max_lag, w.lag)
    assert g.stats.pauses == 0, "hiz denetimi duraklamaya dusmeden calismali"
    assert max_lag < POLICY.pause_bytes + 80 * MIB
    throughput = w.insert / w.now
    assert throughput >= 0.8 * archive_mb_s * MIB
    assert throughput <= 1.05 * archive_mb_s * MIB + POLICY.pause_bytes / w.now
    batches = w.insert // (80 * MIB)
    assert w.samples <= 2 * batches + 1  # parti basina en fazla iki ucuz olcum


def test_simulation_archive_slows_down_midway() -> None:
    """Arsiv hizi 40 -> 4 MB/sn duser (R2 yavaslamasi). Gecikme duraklama sinirini kisaca
    gecebilir ama sinirsiz buyumez; hiz geri gelince tekrar tam hiza cikar."""
    w = FakeWorld(archive_rate=40 * MIB)
    g = governor(w)
    max_lag = 0
    while w.now < 3 * 3600:
        if 3600 <= w.now < 7200:
            w.archive_rate = 4 * MIB
        else:
            w.archive_rate = 40 * MIB
        assert g.before_batch()
        w.write(80 * MIB, 1.0)
        max_lag = max(max_lag, w.lag)
    assert max_lag < POLICY.pause_bytes + 2 * 80 * MIB
    assert g.stopped_reason is None


def test_cli_rejects_inconsistent_wal_thresholds_before_writing(capsys) -> None:
    from catalog_build import __main__ as cli

    with pytest.raises(SystemExit) as exc:
        cli.main(
            [
                "publish",
                "--limit",
                "1",
                "--confirm",
                "--wal-target-mb",
                "100",
                "--wal-pause-mb",
                "50",
            ]
        )
    assert exc.value.code == 2
    assert "resume < target < pause" in capsys.readouterr().err
