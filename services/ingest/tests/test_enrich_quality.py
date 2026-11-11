"""Karar 0184 (E2-C): salt okunur, ornekleme ile veri kalitesi araci."""

from __future__ import annotations

import json
import re

import pytest

from enrich import quality

PARAMS = {"sample_percent": 0.2, "seed": 183, "max_rows": 20000, "statement_timeout_ms": 60000}


def _plan(node_type: str, relation: str, rows: float, children=()) -> list:
    node = {"Node Type": node_type, "Relation Name": relation, "Plan Rows": rows, "Total Cost": 1.0}
    if children:
        node["Plans"] = list(children)
    return [{"Plan": node}]


def test_plan_gate_blocks_unsampled_full_scan_of_big_tables() -> None:
    assert quality.plan_problem(_plan("Seq Scan", "product", 12_000_000)) == (
        "product Seq Scan ~12000000 satir"
    )
    assert quality.plan_problem(_plan("Sample Scan", "product", 24_000)) is None
    assert quality.plan_problem(_plan("Seq Scan", "brand", 900_000)) is None  # kucuk/sozluk tablosu
    nested = _plan(
        "Hash Join", "", 1, [{"Node Type": "Seq Scan", "Relation Name": "offer", "Plan Rows": 9e6}]
    )
    assert "offer" in quality.plan_problem(nested)


def test_queries_touch_big_tables_only_through_sampling_or_keys() -> None:
    for query in quality.queries(PARAMS):
        sql = " ".join(query.sql.split())
        for table in ("product", "offer"):
            for match in re.finditer(rf"FROM {table} (\w+)", sql):
                tail = sql[match.end() : match.end() + 45]
                assert tail.startswith(" TABLESAMPLE SYSTEM (0.2) REPEATABLE (183)"), (
                    query.name,
                    tail,
                )
        assert not re.search(r"\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b", sql), (
            query.name
        )
        if "TABLESAMPLE" in sql:
            assert "LIMIT 20000" in sql, query.name


def test_emitted_script_is_read_only_and_explains_before_running() -> None:
    script = quality.emit_sql(PARAMS)
    lines = script.splitlines()
    assert "BEGIN READ ONLY;" in lines and lines[-1] == "COMMIT;"
    assert "SET LOCAL statement_timeout = 60000;" in lines
    explained = [i for i, line in enumerate(lines) if line.startswith("EXPLAIN (FORMAT JSON)")]
    assert len(explained) == sum(1 for q in quality.queries(PARAMS) if q.explain)
    for i in explained:  # her EXPLAIN'i ayni sorgunun kendisi izler
        assert lines[i + 1].startswith("SELECT json_build_object('name'")


def test_render_reports_method_scope_and_skipped_queries() -> None:
    results = {
        "params": PARAMS,
        "measured_at": "2026-11-11T00:00:00+00:00",
        "estimates": {
            "product": {"reltuples": 12_000_000, "table_bytes": 9e9, "total_bytes": 2e10}
        },
        "product_fill": {"sampled": 1000, "eligible": 400, "brand": 100, "title_len": {"p50": 40}},
        "plans": {"product_fill": {"total_cost": 10.0, "scans": ["Sample Scan(product)"]}},
        "skipped": {"offer_attribute_keys": "offer Seq Scan ~9000000 satir"},
    }
    report = quality.render_markdown(results, source="test")
    assert "TABLESAMPLE SYSTEM (0.2%) REPEATABLE (183)" in report
    assert "ORNEK icindir; tum katalog icin kesin degildir" in report
    assert "| Marka (brand_id) | %25.0 (%95 GA %21.0–29.5; 100/400) |" in report
    assert "| offer_attribute_keys | CALISTIRILMADI | offer Seq Scan ~9000000 satir |" in report


def test_wilson_interval_is_bounded_and_widens_for_small_samples() -> None:
    low, high = quality.wilson(0, 19)
    assert low == 0.0 and 0.15 < high < 0.18
    small = quality.wilson(5, 10)
    large = quality.wilson(500, 1000)
    assert small[1] - small[0] > large[1] - large[0]


def test_psql_output_roundtrip_and_plan_gate() -> None:
    plan_ok = json.dumps(_plan("Sample Scan", "product", 10), indent=2)
    plan_bad = json.dumps(_plan("Seq Scan", "offer", 9e6), indent=2)
    out = "\n".join(
        [
            json.dumps({"params": PARAMS, "measured_at": "t"}),
            json.dumps({"name": "estimates", "value": {"product": {"reltuples": 1}}}),
            plan_ok,
            json.dumps({"name": "product_fill", "value": {"eligible": 1}}),
            plan_ok,
            json.dumps({"name": "product_attribute_keys", "value": []}),
            plan_bad,
            json.dumps({"name": "offer_attribute_keys", "value": {"sampled": 1}}),
        ]
    )
    parsed = quality.parse_psql_output(out)
    assert parsed["product_fill"] == {"eligible": 1}
    assert "offer_attribute_keys" not in parsed  # plan kapisi sonradan da uygulanir
    assert parsed["skipped"]["offer_attribute_keys"].startswith("offer Seq Scan")


@pytest.mark.integration
def test_runs_read_only_against_real_database() -> None:
    import psycopg

    from db.connection import database_url

    with psycopg.connect(database_url()) as conn:
        results = quality.run(conn, {**PARAMS, "sample_percent": 100, "max_rows": 500})
        with conn.cursor() as cur:  # islem kapandi; ayni baglanti yazilabilir durumda kalir
            cur.execute("SHOW transaction_read_only")
            assert cur.fetchone()[0] == "off"
    assert results["skipped"] == {}
    assert set(results["plans"]) == {
        "product_fill",
        "product_attribute_keys",
        "offer_attribute_keys",
        "product_vs_source_offer",
    }
    assert results["product_fill"]["sampled"] >= results["product_fill"]["eligible"] >= 0
    assert "product" in results["estimates"]
    assert "# E2-C" in quality.render_markdown(results, source="test")
