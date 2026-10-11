"""Gecmis veri denetim betigi: yanlis birlesmeyi bulur ve ASLA yazamaz (PR #86)."""

from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest

from db.connection import database_url

pytestmark = pytest.mark.integration

DOMAIN = "test-audit-gecmis.example"
SCRIPT = Path(__file__).parents[1] / "scripts" / "audit_historical_data.py"
CLEANUP = (
    """DELETE FROM offer WHERE merchant_id IN (
        SELECT id FROM merchant WHERE domain LIKE 'test-audit-gecmis%%')""",
    "DELETE FROM product WHERE slug LIKE 'test-audit-gecmis-%%'",
    "DELETE FROM merchant WHERE domain LIKE 'test-audit-gecmis%%'",
)


def _load():
    spec = importlib.util.spec_from_file_location("audit_historical_data", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def merged_product() -> Iterator[int]:
    try:
        owner = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement)
            cur.execute(
                """INSERT INTO product (slug, title)
                   VALUES ('test-audit-gecmis-1', 'Eski Yanlis Birlesme') RETURNING id"""
            )
            product_id = int(cur.fetchone()[0])
            for index, volume in enumerate(("100 ml", "10 ml")):
                cur.execute(
                    """INSERT INTO merchant (slug, name, domain, source_type)
                       VALUES (%s, 'Audit', %s, 'xml_feed') RETURNING id""",
                    (f"test-audit-gecmis-{index}", f"test-audit-gecmis{index}.example"),
                )
                merchant_id = int(cur.fetchone()[0])
                cur.execute(
                    """INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                                          brand_raw, current_price, in_stock)
                       VALUES (%s, %s, %s, %s, %s, 'Anua', 100000, TRUE)""",
                    (
                        merchant_id,
                        product_id,
                        f"a-{index}",
                        f"https://{DOMAIN}/{index}",
                        f"Anua Cleansing Oil {volume}",
                    ),
                )
        owner.commit()
        yield product_id
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement)
        owner.commit()


def test_finds_a_product_merged_from_different_sizes(merged_product: int, capsys) -> None:
    module = _load()
    with psycopg.connect(database_url("DATABASE_URL_OWNER")) as conn:
        found = module.scan_merged_products(conn, 50)
    assert found >= 1
    assert f"urun {merged_product}" in capsys.readouterr().out


def test_the_script_connection_is_read_only(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load()

    def try_to_write(conn: psycopg.Connection, *_args) -> int:
        conn.execute("UPDATE product SET title = title WHERE id = -1")
        return 0

    monkeypatch.setattr(module, "scan_merged_products", try_to_write)
    with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
        module.main(["--limit", "1"])


def test_veto_categories_group_by_reason_prefix() -> None:
    module = _load()
    assert module.veto_category("hacim: 100ml != 10ml") == "hacim"
    assert module.veto_category("sayisal kimlik: ['23'] != ['22']") == "sayisal kimlik"
    assert module.veto_category("") == "diger"


def test_price_scan_counts_suspicious_offers_and_never_writes(merged_product: int, capsys) -> None:
    def owner() -> psycopg.Connection:
        return psycopg.connect(database_url("DATABASE_URL_OWNER"), autocommit=True)

    with owner() as conn:
        conn.execute(
            "UPDATE offer SET current_price = 0 "
            "WHERE external_id = 'a-0' AND merchant_id IN "
            "(SELECT id FROM merchant WHERE domain LIKE 'test-audit-gecmis%')"
        )
        before = conn.execute(
            "SELECT count(*), coalesce(sum(current_price), 0) FROM offer"
        ).fetchone()
    module = _load()
    with psycopg.connect(database_url("DATABASE_URL_OWNER")) as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        found = module.scan_prices(conn, 5)
        conn.rollback()
    out = capsys.readouterr().out
    assert found >= 1
    assert "guncel fiyat <= 0:" in out
    with owner() as conn:
        after = conn.execute(
            "SELECT count(*), coalesce(sum(current_price), 0) FROM offer"
        ).fetchone()
    assert after == before


def test_enter_read_only_makes_writes_fail_and_is_verified() -> None:
    module = _load()
    with psycopg.connect(database_url("DATABASE_URL_OWNER")) as conn:
        module.enter_read_only(conn)
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            conn.execute("UPDATE product SET title = title WHERE false")
        conn.rollback()


def test_enter_read_only_refuses_when_the_setting_cannot_be_confirmed() -> None:
    module = _load()

    class FakeCursor:
        def __init__(self, value):
            self.value = value

        def fetchone(self):
            return self.value

    class FakeConn:
        def execute(self, statement):
            return FakeCursor(("off",) if statement.startswith("SHOW") else None)

    with pytest.raises(module.NotReadOnlyError):
        module.enter_read_only(FakeConn())
