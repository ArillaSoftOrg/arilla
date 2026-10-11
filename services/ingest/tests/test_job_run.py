"""`db/job_run.py`: kirpma, sinirlar ve gercek veritabanina kosu kaydi (karar 0055)."""

from __future__ import annotations

import json
from collections.abc import Iterator

import psycopg
import pytest

from collect.bootstrap import SourceReport, summarize_job
from db import job_run
from db.connection import database_url
from similarity.__main__ import job_name

# --- saf ---------------------------------------------------------------------


def test_redact_strips_url_credentials_path_and_query() -> None:
    text = (
        "connection failed: postgresql://arilla:s3cret@db.internal:5432/arilla?sslmode=require "
        "feed https://shop.example.com/feed.xml?token=abc123&x=1"
    )
    out = job_run.redact(text)
    assert out is not None
    assert "s3cret" not in out
    assert "abc123" not in out
    assert "sslmode" not in out
    assert "feed.xml" not in out
    assert "postgresql://db.internal:5432/…" in out
    assert "https://shop.example.com/…" in out


def test_redact_masks_emails_and_key_values_and_bounds_length() -> None:
    out = job_run.redact("user ayse@example.com password=hunter2 api_key: zzz " + "x" * 900)
    assert out is not None
    assert "ayse@example.com" not in out
    assert "hunter2" not in out
    assert "zzz" not in out
    assert len(out) <= job_run.MAX_ERROR_SUMMARY
    assert job_run.redact("") is None
    assert job_run.redact(None) is None


def test_bounded_detail_keeps_only_flat_scalars_within_size() -> None:
    detail = job_run.bounded_detail(
        {
            "count": 3,
            "ok": True,
            "ratio": 0.5,
            "nan": float("nan"),
            "nested": {"a": 1},
            "items": [1, 2],
            "note": "https://x.example/a?b=c",
            **{f"k{i}": i for i in range(100)},
        }
    )
    assert detail["count"] == 3
    assert detail["ok"] is True
    assert "nan" not in detail
    assert "nested" not in detail
    assert "items" not in detail
    assert detail["note"] == "https://x.example/…"
    assert len(detail) <= job_run.MAX_DETAIL_KEYS
    assert len(json.dumps(detail)) <= job_run.MAX_DETAIL_JSON

    huge = job_run.bounded_detail({f"key_{i}": "y" * 120 for i in range(40)})
    assert len(json.dumps(huge, ensure_ascii=False)) <= job_run.MAX_DETAIL_JSON


def test_invalid_job_name_is_not_recorded_and_does_not_raise() -> None:
    assert job_run.start("Bad-Name") is None
    assert job_run.start("collect", trigger="nope") is None
    job_run.finish(None, "success")  # no-op


def test_default_trigger_comes_from_env_and_falls_back_to_manual(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(job_run.TRIGGER_ENV, raising=False)
    assert job_run.default_trigger() == "manual"
    for value, expected in [("cron", "cron"), (" CRON ", "cron"), ("worker", "worker")]:
        monkeypatch.setenv(job_run.TRIGGER_ENV, value)
        assert job_run.default_trigger() == expected
    # Gecersiz deger kaydi dusurmez; elle kosu sayilir.
    for value in ["", "daily", "cron; drop table job_run"]:
        monkeypatch.setenv(job_run.TRIGGER_ENV, value)
        assert job_run.default_trigger() == "manual"


def test_track_uses_env_trigger_unless_one_is_given(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []

    def fake_start(job: str, trigger: str = "manual") -> None:
        seen.append(trigger)

    monkeypatch.setattr(job_run, "start", fake_start)
    monkeypatch.setattr(job_run, "finish", lambda *_a, **_k: None)
    monkeypatch.setenv(job_run.TRIGGER_ENV, "cron")
    with job_run.track("resolve"):
        pass
    with job_run.track("resolve", "worker"):
        pass
    monkeypatch.delenv(job_run.TRIGGER_ENV)
    with job_run.track("resolve"):
        pass
    assert seen == ["cron", "worker", "manual"]


def test_logging_failure_never_breaks_the_job(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_args: object, **_kwargs: object) -> None:
        raise psycopg.OperationalError("db down postgresql://u:p@h/db")

    monkeypatch.setattr(job_run, "_execute", boom)
    with job_run.track("resolve") as run:
        run.detail["x"] = 1
    assert run.id is None


def test_bootstrap_job_summary() -> None:
    def report(status: str, created: int = 0) -> SourceReport:
        return SourceReport(
            slug=status, domain="d", started_at="t", status=status, offers_created=created
        )

    assert summarize_job([report("success", 2), report("success", 3)])[0] == "success"
    status, detail = summarize_job([report("success", 2), report("failed")])
    assert status == "partial"
    assert detail["offers_created"] == 2
    assert detail["status_failed"] == 1
    assert summarize_job([report("inactive"), report("refused")])[0] == "failed"
    assert summarize_job([report("partial")])[0] == "partial"
    assert summarize_job([])[0] == "failed"


def test_similarity_job_names() -> None:
    assert job_name(True, True) == "similarity"
    assert job_name(True, False) == "similarity_edges"
    assert job_name(False, True) == "similarity_prices"


# --- veritabani --------------------------------------------------------------

JOB = "test_job_run_py"


@pytest.fixture
def owner() -> Iterator[psycopg.Connection]:
    try:
        conn = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with conn:
        conn.execute("DELETE FROM job_run WHERE job = %s", (JOB,))
        conn.commit()
        yield conn
        conn.execute("DELETE FROM job_run WHERE job = %s", (JOB,))
        conn.commit()


def _rows(conn: psycopg.Connection) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status, trigger, finished_at IS NOT NULL, detail, error_summary"
            " FROM job_run WHERE job = %s ORDER BY id",
            (JOB,),
        )
        return cur.fetchall()


@pytest.mark.integration
def test_track_records_success_with_detail(owner: psycopg.Connection) -> None:
    with job_run.track(JOB) as run:
        assert run.id is not None
        assert _rows(owner) == [("running", "manual", False, {}, None)]
        run.detail.update(considered=5, created=2)
        run.status = "partial"
    assert _rows(owner) == [("partial", "manual", True, {"considered": 5, "created": 2}, None)]


@pytest.mark.integration
def test_track_records_failure_redacted_and_reraises(owner: psycopg.Connection) -> None:
    with pytest.raises(RuntimeError), job_run.track(JOB) as run:
        run.detail["seen"] = 1
        raise RuntimeError("feed https://shop.example/f.xml?key=SECRET patladi")
    rows = _rows(owner)
    assert len(rows) == 1
    status, _trigger, finished, detail, summary = rows[0]
    assert (status, finished, detail) == ("failed", True, {"seen": 1})
    assert "SECRET" not in summary
    assert summary.startswith("RuntimeError: feed https://shop.example/…")


@pytest.mark.integration
def test_finish_only_closes_running_rows(owner: psycopg.Connection) -> None:
    run_id = job_run.start(JOB)
    job_run.finish(run_id, "success")
    job_run.finish(run_id, "failed", error_summary="ikinci kapanis yok sayilir")
    assert [row[0] for row in _rows(owner)] == ["success"]
