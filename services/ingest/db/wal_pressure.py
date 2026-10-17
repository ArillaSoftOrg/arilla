"""WAL geri basinci: toplu yazma islerini WAL arsiv kapasitesine gore yavaslatir (karar 0134).

Olcu ARSIVLENMEMIS WAL'dir: `pg_current_wal_lsn()` ile son arsivlenen segmentin sonu
arasindaki bayt farki. `pg_wal` dizin boyutu KULLANILMAZ: dizinde PostgreSQL'in yeniden
kullanmak icin tuttugu (recycled, `max_wal_size`'a kadar) ve arsivlenmis ama bir sonraki
checkpoint'te silinecek segmentler de vardir. Bunlar arsiv borcu degildir; dizin boyutuna
gore beklemek, arsiv bosaldiktan sonra da checkpoint'e kadar (15 dk + yayilma) bekletir.

Yalniz herkese acik fonksiyonlar okunur (`arilla_app` superuser degil; `pg_ls_waldir` ve
`pg_ls_archive_statusdir` yetki ister): `pg_current_wal_lsn`, `pg_stat_archiver`,
`pg_settings`. Her parti arasinda tek, birincil anahtarsiz ucuz bir sorgu.

Davranis (parti ONCESI cagrilir; acik islem yokken):

- `archive_mode` kapali ya da olcu okunamiyor: bekleme yok (yerel/test). Uretimde arsiv acik.
- Arsiv basarisiz (`last_failed_time > last_archived_time`): yazma yok, duzelene kadar beklenir;
  `failing_grace_s` asilirsa is durur (tamamlanan partiler kalir, ayni komut kaldigi yerden surer).
- Gecikme >= `pause_bytes`: `resume_bytes` altina inene kadar beklenir (histerezis);
  `max_pause_s` asilirsa is durur.
- `target_bytes` < gecikme < `pause_bytes`: parti arasi uyku, uretim hizini arsiv hizinin
  altina ceker (oransal; `max_sleep_s` ile sinirli).
- Gecikme <= `target_bytes`: tam hiz.

Durdurma istegi (SIGTERM -> `should_stop`) her beklemede en gec `poll_s` icinde fark edilir.
"""

from __future__ import annotations

import logging
import re
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

import psycopg

log = logging.getLogger(__name__)

MIB = 1024 * 1024

SAMPLE_SQL = """
SELECT pg_current_wal_lsn() - '0/0'::pg_lsn,
       current_setting('archive_mode'),
       (SELECT setting::bigint FROM pg_settings WHERE name = 'wal_segment_size'),
       a.last_archived_wal,
       a.archived_count,
       a.failed_count,
       coalesce(a.last_failed_time > a.last_archived_time,
                a.last_failed_time IS NOT NULL AND a.last_archived_time IS NULL)
  FROM pg_stat_archiver a
"""

_SEGMENT = re.compile(r"^([0-9A-F]{8})([0-9A-F]{8})([0-9A-F]{8})(\..*)?$")


def archived_upto(last_archived_wal: str | None, seg_size: int) -> int | None:
    """Son arsivlenen dosya adindan, arsivi kesin tamamlanmis WAL'in bittigi bayt konumu.

    Tam segment (`000000010000000A000000FF`) -> segmentin SONU. `.partial` / `.backup`
    eki -> segmentin BASI (temkinli: gecikme oldugundan buyuk gorunur, asla kucuk degil).
    Zaman cizelgesi dosyasi (`00000002.history`) ya da hic arsiv yok -> None (bilinmiyor).
    """
    if not last_archived_wal:
        return None
    m = _SEGMENT.match(last_archived_wal)
    if m is None:
        return None
    segs_per_log = 0x100000000 // seg_size
    segno = int(m.group(2), 16) * segs_per_log + int(m.group(3), 16)
    start = segno * seg_size
    return start if m.group(4) else start + seg_size


@dataclass(frozen=True)
class WalSample:
    at: float
    insert_lsn: int
    archive_mode: str
    seg_size: int
    archived_upto: int | None
    archived_count: int
    failed_count: int
    archive_failing: bool

    @property
    def lag_bytes(self) -> int | None:
        if self.archived_upto is None:
            return None
        return max(0, self.insert_lsn - self.archived_upto)


def read_sample(
    conn: psycopg.Connection, *, clock: Callable[[], float] = time.monotonic
) -> WalSample:
    """Tek ucuz sorgu; kendi kucuk islemini kapatir (parti islemi icinde CAGRILMAZ)."""
    with conn.cursor() as cur:
        cur.execute(SAMPLE_SQL)
        row = cur.fetchone()
    conn.commit()
    assert row is not None
    seg = int(row[2])
    return WalSample(
        at=clock(),
        insert_lsn=int(row[0]),
        archive_mode=str(row[1]),
        seg_size=seg,
        archived_upto=archived_upto(row[3], seg),
        archived_count=int(row[4] or 0),
        failed_count=int(row[5] or 0),
        archive_failing=bool(row[6]),
    )


@dataclass(frozen=True)
class WalPolicy:
    """Esikler bayt cinsinden. Varsayilanlar 4 GiB `archive-push-queue-max` icin:
    pgBackRest kuyruk bu siniri asarsa WAL'i BIRAKIR (PITR kopar). Duraklama siniri bu
    degerin en fazla yarisi olmali; sarmalayici (`infra/vps/bin/catalog-publish`) degerleri
    gercek yapilandirmadan hesaplar."""

    target_bytes: int = 1024 * MIB
    pause_bytes: int = 1536 * MIB
    resume_bytes: int = 512 * MIB
    max_sleep_s: float = 30.0
    max_pause_s: float = 3600.0
    failing_grace_s: float = 900.0
    poll_s: float = 5.0
    rate_window_s: float = 120.0
    min_factor: float = 0.1

    def __post_init__(self) -> None:
        if not 0 < self.resume_bytes < self.target_bytes < self.pause_bytes:
            raise ValueError("WAL esikleri: 0 < resume < target < pause olmali")
        if self.max_sleep_s <= 0 or self.max_pause_s <= 0 or self.poll_s <= 0:
            raise ValueError("WAL bekleme sureleri pozitif olmali")


@dataclass
class WalStats:
    paced_sleeps: int = 0
    paced_seconds: float = 0.0
    pauses: int = 0
    paused_seconds: float = 0.0
    failing_seconds: float = 0.0
    max_lag_bytes: int = 0

    def as_detail(self) -> dict[str, float | int]:
        return {
            "wal_paced_sleeps": self.paced_sleeps,
            "wal_paced_s": round(self.paced_seconds, 1),
            "wal_pauses": self.pauses,
            "wal_paused_s": round(self.paused_seconds, 1),
            "wal_archive_failing_s": round(self.failing_seconds, 1),
            "wal_max_lag_mb": self.max_lag_bytes // MIB,
        }


@dataclass
class WalGovernor:
    """Parti arasi geri basinc. `before_batch()` False donerse is durmali (`stopped_reason`)."""

    sample: Callable[[], WalSample]
    policy: WalPolicy = field(default_factory=WalPolicy)
    should_stop: Callable[[], bool] = lambda: False
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic
    stats: WalStats = field(default_factory=WalStats)
    stopped_reason: str | None = None
    _window: deque[WalSample] = field(default_factory=deque)
    _prev: WalSample | None = None
    _last_log: float = float("-inf")

    @classmethod
    def for_connection(
        cls, conn: psycopg.Connection, policy: WalPolicy | None = None, **kwargs: object
    ) -> WalGovernor:
        return cls(
            sample=lambda: read_sample(conn),
            policy=policy or WalPolicy(),
            **kwargs,  # type: ignore[arg-type]
        )

    # --- olcum ------------------------------------------------------------------------
    def _observe(self) -> WalSample:
        s = self.sample()
        self._window.append(s)
        while len(self._window) > 2 and s.at - self._window[0].at > self.policy.rate_window_s:
            self._window.popleft()
        lag = s.lag_bytes
        if lag is not None and lag > self.stats.max_lag_bytes:
            self.stats.max_lag_bytes = lag
        return s

    def archive_rate(self) -> float | None:
        """Pencere icindeki arsiv ilerlemesi (bayt/sn). Segment adimli oldugu icin pencere uzun."""
        pts = [w for w in self._window if w.archived_upto is not None]
        if len(pts) < 2:
            return None
        dt = pts[-1].at - pts[0].at
        if dt <= 0:
            return None
        return max(0.0, (pts[-1].archived_upto - pts[0].archived_upto) / dt)  # type: ignore[operator]

    def generation_rate(self) -> float | None:
        if len(self._window) < 2:
            return None
        a, b = self._window[0], self._window[-1]
        dt = b.at - a.at
        return None if dt <= 0 else max(0.0, (b.insert_lsn - a.insert_lsn) / dt)

    # --- bekleme ------------------------------------------------------------------------
    def _wait(self, seconds: float) -> bool:
        """Durdurma istegini en gec poll_s icinde fark ederek bekler. False = durdurma istendi."""
        end = self.clock() + seconds
        while True:
            if self.should_stop():
                return False
            left = end - self.clock()
            if left <= 0:
                return True
            self.sleep(min(self.policy.poll_s, left))

    def _status(self, state: str, s: WalSample, sleep_s: float = 0.0) -> None:
        now = self.clock()
        if state == "pace" and now - self._last_log < 60:
            return
        self._last_log = now
        lag = s.lag_bytes
        arch, gen = self.archive_rate(), self.generation_rate()
        log.info(
            "wal %s: gecikme %s MB, uretim %s MB/sn, arsiv %s MB/sn, uyku %.1f sn",
            state,
            "?" if lag is None else lag // MIB,
            "?" if gen is None else f"{gen / MIB:.1f}",
            "?" if arch is None else f"{arch / MIB:.1f}",
            sleep_s,
        )

    def pace_seconds(self, s: WalSample, batch_wal: int, batch_s: float) -> float:
        """Gecikme hedefin ustundeyse, partinin urettigi WAL'i arsiv hizinin `factor` katiyla
        uretecek kadar uyku. factor gecikme hedefte 1, duraklama sinirinda min_factor."""
        p = self.policy
        lag = s.lag_bytes
        if lag is None or lag <= p.target_bytes or batch_wal <= 0:
            return 0.0
        arch = self.archive_rate()
        if not arch:
            return p.max_sleep_s
        over = (lag - p.target_bytes) / (p.pause_bytes - p.target_bytes)
        factor = max(p.min_factor, 1.0 - over * (1.0 - p.min_factor))
        need = batch_wal / (arch * factor) - batch_s
        return min(p.max_sleep_s, max(0.0, need))

    def before_batch(self) -> bool:
        """Bir sonraki parti baslamadan once cagrilir. True = yaz, False = dur."""
        if self.stopped_reason is not None:
            return False
        p = self.policy
        s = self._observe()
        if s.archive_mode == "off":
            self._prev = s
            return True

        failing_since: float | None = None
        paused_since: float | None = None
        while True:
            if self.should_stop():
                return False
            if s.archive_failing:
                if failing_since is None:
                    failing_since = s.at
                    self._status("arsiv-hatasi", s)
                elapsed = s.at - failing_since
                if elapsed >= p.failing_grace_s:
                    self.stats.failing_seconds += elapsed
                    self.stopped_reason = (
                        f"WAL arsivi {int(elapsed)} sn'dir basarisiz"
                        f" (failed_count={s.failed_count})"
                    )
                    log.error("wal: %s; is duruyor", self.stopped_reason)
                    return False
                if not self._wait(p.poll_s):
                    return False
                s = self._observe()
                continue
            if failing_since is not None:
                self.stats.failing_seconds += s.at - failing_since
                failing_since = None

            lag = s.lag_bytes
            # Arsiv acik ama olcu yok (istatistik sifirlanmis / henuz arsiv yok): korlemesine
            # yazilmaz, ilk arsivlenen segmente kadar duraklama gibi beklenir (archive_timeout
            # en gec birkac dakikada bir segment kapatir).
            if lag is None or (
                lag >= p.pause_bytes or (paused_since is not None and lag > p.resume_bytes)
            ):
                if paused_since is None:
                    paused_since = s.at
                    self.stats.pauses += 1
                    self._status("duraklama", s)
                elapsed = s.at - paused_since
                if elapsed >= p.max_pause_s:
                    self.stats.paused_seconds += elapsed
                    self.stopped_reason = (
                        f"arsiv ilerlemesi {int(elapsed)} sn'dir olculemiyor (pg_stat_archiver)"
                        if lag is None
                        else f"arsivlenmemis WAL {lag // MIB} MB, {int(elapsed)} sn'dir "
                        f"{p.resume_bytes // MIB} MB altina inmedi"
                    )
                    log.error("wal: %s; is duruyor", self.stopped_reason)
                    return False
                if not self._wait(p.poll_s):
                    return False
                s = self._observe()
                continue
            if paused_since is not None:
                self.stats.paused_seconds += s.at - paused_since
                self._status("devam", s)
                # Duraklamadan cikinca hiz olcusu bekleme suresini icerir: dogrudan devam.
                self._prev = s
                return True
            break

        prev, self._prev = self._prev, s
        if prev is None:
            return True
        delay = self.pace_seconds(s, s.insert_lsn - prev.insert_lsn, s.at - prev.at)
        if delay > 0:
            self.stats.paced_sleeps += 1
            self.stats.paced_seconds += delay
            self._status("yavaslatma", s, delay)
            if not self._wait(delay):
                return False
            # Uyku partinin suresine sayilmasin: sonraki olcu bekleme sonrasindan baslar.
            self._prev = self._observe()
        return True


def policy_from_mb(
    *,
    target_mb: int,
    pause_mb: int,
    resume_mb: int,
    max_sleep_s: float,
    max_pause_s: float,
    failing_grace_s: float,
) -> WalPolicy:
    return WalPolicy(
        target_bytes=target_mb * MIB,
        pause_bytes=pause_mb * MIB,
        resume_bytes=resume_mb * MIB,
        max_sleep_s=max_sleep_s,
        max_pause_s=max_pause_s,
        failing_grace_s=failing_grace_s,
    )
