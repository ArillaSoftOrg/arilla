"""Worker dongusu gecici Redis hatalarinda dusmez (0035 QA'sinda bulunan ariza).

redis-py'nin soket okuma suresi BRPOP bekleme suresine esitken bos kuyrukta
ilk bekleme `TimeoutError` ile bitiyor ve worker sureci cikiyordu.
"""

from __future__ import annotations

import pytest
import redis

from collect.link import worker


class _FlakyRedis:
    def __init__(self) -> None:
        self.calls = 0

    def brpop(self, keys: list[str], timeout: float) -> None:
        self.calls += 1
        if self.calls == 1:
            raise redis.TimeoutError("Timeout reading from socket")
        if self.calls == 2:
            raise redis.ConnectionError("baglanti koptu")
        return None


def test_worker_survives_transient_redis_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(worker.time, "sleep", lambda _seconds: None)
    fake = _FlakyRedis()
    worker.run_worker(None, fake, max_iterations=3)  # type: ignore[arg-type]
    assert fake.calls == 3
