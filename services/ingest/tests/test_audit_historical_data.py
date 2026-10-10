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
