"""Link worker'i uretim benzeri ortamda TLS'siz ya da adressiz Redis ile
baslamaz; yerel gelistirme localhost'la calismaya devam eder. Veritabani
gerektirmez."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from collect.link import __main__ as cli
from collect.link.worker_config import LOCAL_REDIS_URL, WorkerConfigError, worker_redis_url

LOCAL_DB = "postgresql://arilla_app:@localhost:5432/arilla"
REMOTE_DB = "postgresql://arilla_app:db-gizli@aws-0.pooler.supabase.com:5432/postgres"
SECRET = "redis-gizli-parola"


def test_local_development_without_redis_url_uses_localhost() -> None:
    assert worker_redis_url(None, LOCAL_DB) == LOCAL_REDIS_URL
    assert worker_redis_url("  ", LOCAL_DB) == LOCAL_REDIS_URL


def test_local_plain_redis_is_accepted() -> None:
    assert worker_redis_url("redis://localhost:6379", LOCAL_DB) == "redis://localhost:6379"
    assert worker_redis_url("redis://127.0.0.1:6380/0", LOCAL_DB) == "redis://127.0.0.1:6380/0"


def test_tls_redis_is_accepted_everywhere() -> None:
    url = f"rediss://default:{SECRET}@eu1.upstash.io:6379"
    assert worker_redis_url(url, REMOTE_DB) == url
    assert worker_redis_url(url, LOCAL_DB) == url


def test_missing_redis_url_outside_local_development_fails() -> None:
    with pytest.raises(WorkerConfigError, match="REDIS_URL tanimli degil"):
        worker_redis_url(None, REMOTE_DB)
    with pytest.raises(WorkerConfigError):
        worker_redis_url(None, None)


@pytest.mark.parametrize(
    ("redis_url", "database_url"),
    [
        (f"redis://default:{SECRET}@eu1.upstash.io:6379", REMOTE_DB),  # uzak, TLS'siz
        (f"redis://default:{SECRET}@eu1.upstash.io:6379", LOCAL_DB),  # yerelde bile uzak
        ("redis://localhost:6379", REMOTE_DB),  # uretim DB'si + yerel kuyruk
    ],
)
def test_plain_redis_outside_local_development_is_rejected(
    redis_url: str, database_url: str
) -> None:
    with pytest.raises(WorkerConfigError, match="rediss://") as raised:
        worker_redis_url(redis_url, database_url)
    assert SECRET not in str(raised.value)
    assert "upstash" not in str(raised.value)


def test_unknown_scheme_is_rejected() -> None:
    with pytest.raises(WorkerConfigError, match="redis:// ya da rediss://"):
        worker_redis_url(f"https://default:{SECRET}@eu1.upstash.io", REMOTE_DB)


def _run_worker_cli(
    monkeypatch: pytest.MonkeyPatch, values: dict[str, str | None]
) -> tuple[int, list[str]]:
    monkeypatch.setattr(cli, "env", lambda name, default=None: values.get(name, default))
    opened: list[str] = []

    def no_db() -> None:
        opened.append("connect")
        raise AssertionError("veritabanina baglanilmamali")

    monkeypatch.setattr(cli, "connect", no_db)
    return cli.main(["--worker"]), opened


def test_worker_cli_fails_fast_without_redis_url(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.ERROR):
        code, opened = _run_worker_cli(monkeypatch, {"DATABASE_URL": REMOTE_DB})
    assert code == 2
    assert opened == []
    assert "REDIS_URL tanimli degil" in caplog.text
    assert "db-gizli" not in caplog.text


def test_worker_cli_rejects_remote_plain_redis_without_logging_it(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    values = {
        "DATABASE_URL": REMOTE_DB,
        "REDIS_URL": f"redis://default:{SECRET}@eu1.upstash.io:6379",
    }
    with caplog.at_level(logging.DEBUG):
        code, opened = _run_worker_cli(monkeypatch, values)
    assert code == 2
    assert opened == []
    assert "rediss://" in caplog.text
    assert SECRET not in caplog.text
    assert "upstash" not in caplog.text


# --- Heartbeat / healthcheck (dosya tabanli; HTTP endpoint yok) ---------------


def test_heartbeat_path_defaults_when_blank() -> None:
    from collect.link.worker_config import DEFAULT_HEARTBEAT_FILE, heartbeat_path

    assert heartbeat_path(None) == Path(DEFAULT_HEARTBEAT_FILE)
    assert heartbeat_path("  ") == Path(DEFAULT_HEARTBEAT_FILE)
    assert heartbeat_path("/run/x.hb") == Path("/run/x.hb")


def test_heartbeat_freshness(tmp_path) -> None:  # type: ignore[no-untyped-def]
    import os

    from collect.link.worker_config import heartbeat_is_fresh, touch_heartbeat

    path = tmp_path / "hb"
    assert not heartbeat_is_fresh(path, 1000.0)  # dosya yok -> sagliksiz
    touch_heartbeat(path)
    mtime = path.stat().st_mtime
    assert heartbeat_is_fresh(path, mtime + 10)
    assert not heartbeat_is_fresh(path, mtime + 10_000)
    os.utime(path, (mtime - 500, mtime - 500))
    assert not heartbeat_is_fresh(path, mtime)


def test_touch_heartbeat_swallows_disk_errors(tmp_path) -> None:  # type: ignore[no-untyped-def]
    from collect.link.worker_config import touch_heartbeat

    touch_heartbeat(tmp_path / "yok" / "dizin" / "hb")  # ust dizin yok: istisna firlatmaz


def test_healthcheck_cli_exit_code(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    path = tmp_path / "hb"
    monkeypatch.setenv("WORKER_HEARTBEAT_FILE", str(path))
    assert cli.main(["--healthcheck"]) == 1
    path.touch()
    assert cli.main(["--healthcheck"]) == 0
