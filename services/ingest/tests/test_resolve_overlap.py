"""Gercek capraz-magaza corpus'u uzerinde eslestirme guvenligi (0029).

Yerel veritabaninda overlap merchant'lari (bootstrap/overlap_merchants.json)
yuklu degilse atlanir. Guvenlik esigi mutlak: hicbir zor negatif otomatik
birlesmez. Geri cagirma esigi 2026-09-24 olcumunun (2 oto + 3 kuyruk) alti
degildir; dusmesi gerileme demektir.
"""

from __future__ import annotations

import psycopg
import pytest

from db.connection import database_url
from resolve.overlap_eval import evaluate

pytestmark = pytest.mark.integration


@pytest.fixture
def conn():
    try:
        connection = psycopg.connect(database_url())
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with connection:
        row = connection.execute(
            "SELECT count(*) FROM merchant"
            " WHERE slug IN ('vionine', 'sasha-kozmetik', 'stanley-turkiye')"
        ).fetchone()
        if not row or row[0] < 3:
            pytest.skip("overlap corpus yuklu degil")
        yield connection


def test_no_hard_negative_is_auto_merged(conn: psycopg.Connection) -> None:
    result = evaluate(conn)
    assert result.counts["fp_auto"] == 0


def test_true_positive_side_does_not_regress(conn: psycopg.Connection) -> None:
    result = evaluate(conn)
    assert result.counts["tp_auto"] + result.counts["tp_queued"] >= 5
