"""Token/dakika butcesi — saglayici sinirinin ALTINDA kalmak icin.

Jina hesabinin siniri dakikada 100.000 token. Eski yol 429 alip ustel
geri cekilerek yasiyordu; bu modul istegi gondermeden once bekler.

Kayan 60 sn pencere: her istek once TAHMINI token'iyla pencereye yazilir,
yanit gelince saglayicinin dondugu `usage.total_tokens` ile duzeltilir.
Penceredeki toplam + yeni tahmin butceyi asiyorsa, en eski kayit pencereden
dusene kadar beklenir. 429 gelirse `pause` ile tum istekler durdurulur.

Saat ve uyku enjekte edilir; testler gercek zamanda beklemez.
"""

from __future__ import annotations

import logging
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

from db.connection import env

logger = logging.getLogger(__name__)

#: Varsayilan butce: hesap sinirinin %80'i. Tahmin hatasi ve baska
#: istemcilerin (TypeScript istek yolundaki kullanici gorseli) payi icin bosluk.
DEFAULT_TOKENS_PER_MINUTE = 80_000
WINDOW_SECONDS = 60.0

TPM_ENV = "JINA_TOKENS_PER_MINUTE"


def tokens_per_minute_from_env() -> int:
    raw = env(TPM_ENV)
    if not raw:
        return DEFAULT_TOKENS_PER_MINUTE
    try:
        value = int(raw)
    except ValueError:
        logger.warning("%s gecersiz (%r), varsayilan %s", TPM_ENV, raw, DEFAULT_TOKENS_PER_MINUTE)
        return DEFAULT_TOKENS_PER_MINUTE
    return value if value > 0 else DEFAULT_TOKENS_PER_MINUTE


@dataclass
class _Entry:
    at: float
    tokens: int


@dataclass
class TokenBudget:
    """Kayan pencereli token butcesi. Es zamanlilik 1 varsayilir (kilit yok)."""

    tokens_per_minute: int = DEFAULT_TOKENS_PER_MINUTE
    window: float = WINDOW_SECONDS
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    _entries: deque[_Entry] = field(default_factory=deque)
    _paused_until: float = 0.0
    #: Toplam bekleme — kosu raporu icin.
    waited: float = 0.0

    def _expire(self, now: float) -> None:
        while self._entries and self._entries[0].at <= now - self.window:
            self._entries.popleft()

    def used(self) -> int:
        self._expire(self.clock())
        return sum(entry.tokens for entry in self._entries)

    def _wait(self, seconds: float) -> None:
        if seconds <= 0:
            return
        self.waited += seconds
        self.sleep(seconds)

    def acquire(self, estimate: int) -> _Entry:
        """Butce musait olana kadar bekler, tahmini pencereye yazar.

        Tek basina butceyi asan bir istek (tahmin > TPM) pencere bosalinca
        gecer; aksi halde sonsuza kadar beklerdi.
        """
        estimate = max(0, int(estimate))
        while True:
            now = self.clock()
            if now < self._paused_until:
                self._wait(self._paused_until - now)
                continue
            self._expire(now)
            used = sum(entry.tokens for entry in self._entries)
            if not self._entries or used + estimate <= self.tokens_per_minute:
                entry = _Entry(at=now, tokens=estimate)
                self._entries.append(entry)
                return entry
            # En eski kayit pencereden dusene kadar bekle, sonra yeniden hesapla.
            oldest = self._entries[0].at
            self._wait(oldest + self.window - now)

    def settle(self, entry: _Entry, actual: int) -> None:
        """Tahmini saglayicinin dondugu gercek token sayisiyla degistirir."""
        entry.tokens = max(0, int(actual))

    def pause(self, seconds: float) -> None:
        """429 sonrasi: `seconds` boyunca hicbir istek gonderilmez."""
        until = self.clock() + max(0.0, seconds)
        self._paused_until = max(self._paused_until, until)
