"""Worker dongusu gecici Redis hatalarinda dusmez (0035 QA'sinda bulunan ariza).

redis-py'nin soket okuma suresi BRPOP bekleme suresine esitken bos kuyrukta
ilk bekleme `TimeoutError` ile bitiyor ve worker sureci cikiyordu.
"""

from __future__ import annotations

import contextlib
import signal

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


class _OneMessageRedis:
    def __init__(self) -> None:
        self.calls = 0

    def brpop(self, keys: list[str], timeout: float) -> tuple[str, str] | None:
        self.calls += 1
        if self.calls == 1:
            return ("queue:link_resolution", '{"request_id": "req-1"}')
        return None


class _FakeConn:
    def __init__(self, *, broken: bool) -> None:
        self.closed = broken
        self.broken = broken
        self.rollbacks = 0

    def rollback(self) -> None:
        self.rollbacks += 1


def _raise(*_args: object, **_kwargs: object) -> None:
    raise RuntimeError("beklenmeyen")


def test_worker_exits_when_database_connection_is_lost(monkeypatch: pytest.MonkeyPatch) -> None:
    """Kopan tek baglantiyla devam edilemez: surec yoneticisi yeniden baslatsin diye cikar."""
    monkeypatch.setattr(worker, "process_one", _raise)
    conn = _FakeConn(broken=True)
    with pytest.raises(worker.DatabaseConnectionLost):
        worker.run_worker(conn, _OneMessageRedis(), max_iterations=3)  # type: ignore[arg-type]
    assert conn.rollbacks == 0


def test_worker_skips_message_on_unexpected_error_with_healthy_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(worker, "process_one", _raise)
    monkeypatch.setattr(worker, "_mark", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(worker.time, "sleep", lambda _seconds: None)
    conn = _FakeConn(broken=False)
    fake = _OneMessageRedis()
    worker.run_worker(conn, fake, max_iterations=3)  # type: ignore[arg-type]
    assert fake.calls == 3
    assert conn.rollbacks == 1


def test_sigterm_handler_exits_cleanly() -> None:
    """SystemExit(0): `with connect()` temizlenir, surec yoneticisi hata gormez."""
    from collect.link import __main__ as cli

    with pytest.raises(SystemExit) as exited:
        cli._exit_on_sigterm(signal.SIGTERM, None)
    assert exited.value.code == 0


def test_worker_cli_exits_non_zero_when_database_connection_is_lost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from collect.link import __main__ as cli

    @contextlib.contextmanager
    def fake_connect():  # type: ignore[no-untyped-def]
        yield object()

    def lost(*_args: object, **_kwargs: object) -> None:
        raise worker.DatabaseConnectionLost("req-1")

    previous = signal.getsignal(signal.SIGTERM)
    monkeypatch.setattr(cli, "connect", fake_connect)
    monkeypatch.setattr(cli, "run_worker", lost)
    monkeypatch.setattr(cli.redis.Redis, "from_url", lambda *_a, **_k: object())
    monkeypatch.setattr(cli, "_worker_embedder", lambda _fake: None)
    try:
        assert cli.main(["--worker"]) == 1
        assert signal.getsignal(signal.SIGTERM) is cli._exit_on_sigterm
    finally:
        signal.signal(signal.SIGTERM, previous)
