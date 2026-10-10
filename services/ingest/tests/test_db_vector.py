"""`db.vector.tune_ann_search`: islem-yerel HNSW ayarlari (AI denetimi A4)."""

from __future__ import annotations

from collections.abc import Iterator

import psycopg
import pytest

from db.connection import database_url
from db.vector import DEFAULT_EF_SEARCH, ITERATIVE_SCAN, tune_ann_search

pytestmark = pytest.mark.integration


@pytest.fixture
def conn() -> Iterator[psycopg.Connection]:
    try:
        connection = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with connection:
        yield connection


def _setting(conn: psycopg.Connection, name: str) -> str:
    with conn.cursor() as cur:
        cur.execute("SELECT current_setting(%s, true)", (name,))
        row = cur.fetchone()
        assert row is not None
        return row[0]


def test_settings_apply_inside_the_transaction(conn: psycopg.Connection) -> None:
    assert tune_ann_search(conn) is True
    assert _setting(conn, "hnsw.ef_search") == str(DEFAULT_EF_SEARCH)
    assert _setting(conn, "hnsw.iterative_scan") == ITERATIVE_SCAN


def test_settings_do_not_leak_past_the_transaction(conn: psycopg.Connection) -> None:
    tune_ann_search(conn)
    conn.rollback()
    assert _setting(conn, "hnsw.ef_search") != str(DEFAULT_EF_SEARCH)
    assert _setting(conn, "hnsw.iterative_scan") != ITERATIVE_SCAN


def test_a_failing_setting_does_not_abort_the_caller(
    conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    # pgvector kutuphanesi yuklenmeden "hnsw.*" yalnizca yer tutucudur ve her degeri
    # kabul eder; gecersiz degerin gercekten hata verdigi yolu sinamak icin once yukle.
    with conn.cursor() as cur:
        cur.execute("SELECT '[1,2]'::vector")
    monkeypatch.setattr("db.vector.ITERATIVE_SCAN", "bu-gecersiz-bir-deger")

    assert tune_ann_search(conn) is False

    # Savepoint geri alindi: ayni islem sorgu calistirmaya devam edebilir.
    with conn.cursor() as cur:
        cur.execute("SELECT 1")
        assert cur.fetchone() == (1,)
