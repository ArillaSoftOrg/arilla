#!/usr/bin/env python3
"""WAL kaynagi raporu (karar 0185, Asama B/C). Yalniz standart kutuphane; ROOT ile. SALT OKUNUR.

    wal_report.py snapshot [--label etiket]   # anlik goruntu -> /opt/arilla/state/wal/<zaman>[-etiket].json
    wal_report.py diff [A B]                  # iki goruntu arasi (varsayilan: son iki)
    wal_report.py list

Goruntu: `pg_stat_wal` (WAL bayti, tam sayfa goruntusu = FPI), checkpoint sayaclari, WAL'a gore
ilk 200 ifade (`pg_stat_statements`; sorgu metni zaten parametrelenmis, deger icermez, 200 karaktere
kirpilir), izlenen tablolarin guncelleme/HOT sayaclari ve boyutlari, `search_outbox` tahmini.
`diff` gun basina WAL, FPI payi, tablo HOT orani ve en cok WAL ureten ifadeleri verir.

Hicbir sayac SIFIRLANMAZ (`pg_stat_statements_reset` yok); farklar iki goruntu arasindan hesaplanir.
Veritabanina yazmaz: her sorgu `BEGIN READ ONLY` icindedir.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import arilla_healthcheck as hc  # noqa: E402 - ayni dizin; psql cagrisi tek yerde

#: Asama B'nin izledigi tablolar (ayrica guncellemeye gore ilk 10 tablo eklenir).
TABLES = ("offer", "product", "feed_source_offer", "search_outbox", "offer_image", "seller",
          "match_decision_log", "product_classification")
TOP_STATEMENTS = 200
KEEP = 400

PGSS_SCHEMA_SQL = ("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace "
                   "WHERE e.extname = 'pg_stat_statements'")

SNAPSHOT_SQL = """
SELECT json_build_object(
  'lsn', pg_current_wal_lsn()::text,
  'now', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'wal', (SELECT json_build_object('records', wal_records, 'fpi', wal_fpi, 'bytes', wal_bytes::bigint,
                                   'stats_reset', stats_reset) FROM pg_stat_wal),
  'checkpoints', (SELECT json_build_object('timed', checkpoints_timed, 'requested', checkpoints_req)
                    FROM pg_stat_bgwriter),
  'tables', (SELECT coalesce(json_agg(t ORDER BY t.name), '[]'::json) FROM (
      SELECT s.relname AS name, s.n_tup_ins AS ins, s.n_tup_upd AS upd, s.n_tup_hot_upd AS hot,
             s.n_tup_del AS del, s.n_live_tup AS live, s.n_dead_tup AS dead,
             pg_total_relation_size(s.relid) AS bytes
        FROM pg_stat_user_tables s
       WHERE s.schemaname = 'public'
         AND (s.relname = ANY(%(tables)s) OR s.relid IN (
              SELECT relid FROM pg_stat_user_tables WHERE schemaname = 'public'
               ORDER BY n_tup_upd DESC LIMIT 10))) t),
  'outbox', (SELECT json_build_object('rows_estimate', c.reltuples::bigint,
                                      'bytes', pg_total_relation_size(c.oid))
               FROM pg_class c WHERE c.oid = to_regclass('public.search_outbox')),
  'statements', %(statements)s
)
"""

STATEMENTS_SQL = """(SELECT coalesce(json_agg(q ORDER BY q.wal_bytes DESC), '[]'::json) FROM (
      SELECT queryid::text AS id, calls, rows, wal_records, wal_fpi, wal_bytes::bigint AS wal_bytes,
             left(regexp_replace(query, '\\s+', ' ', 'g'), 200) AS query
        FROM {schema}.pg_stat_statements
       ORDER BY wal_bytes DESC LIMIT {limit}) q)"""


def read_only(sql: str) -> str:
    return f"BEGIN READ ONLY; {sql}; COMMIT;"


def sql_text_array(items: tuple[str, ...]) -> str:
    for item in items:
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", item):
            raise ValueError(item)
    return "ARRAY[" + ", ".join(f"'{i}'" for i in items) + "]::name[]"


def take_snapshot(collector: hc.Collector) -> dict:
    rc, out = collector.psql(read_only(PGSS_SCHEMA_SQL))
    schema = out.strip().splitlines()[0].strip() if rc == 0 and out.strip() else ""
    if schema and not re.fullmatch(r"[a-z_][a-z0-9_]*", schema):
        raise RuntimeError("beklenmeyen pg_stat_statements semasi")
    statements = (STATEMENTS_SQL.format(schema=schema, limit=TOP_STATEMENTS) if schema else "'[]'::json")
    sql = SNAPSHOT_SQL.replace("%(tables)s", sql_text_array(TABLES)).replace("%(statements)s", statements)
    rc, out = collector.psql(read_only(sql))
    if rc != 0 or not out.strip():
        raise RuntimeError(f"anlik goruntu sorgusu basarisiz (rc={rc})")
    # json_agg ogeler arasina satir sonu koyar: ciktinin TAMAMI tek JSON degeridir.
    snap = json.loads(out.strip())
    snap["pg_stat_statements"] = bool(schema)
    return snap


def gb(n: float) -> str:
    return f"{n / 1e9:.2f} GB"


def diff(a: dict, b: dict) -> dict:
    """Iki goruntu arasi; saf fonksiyon (testli)."""
    t0 = datetime.fromisoformat(a["now"].replace("Z", "+00:00"))
    t1 = datetime.fromisoformat(b["now"].replace("Z", "+00:00"))
    hours = max((t1 - t0).total_seconds() / 3600, 1e-9)
    reset = a["wal"].get("stats_reset") != b["wal"].get("stats_reset")
    wal_bytes = b["wal"]["bytes"] - a["wal"]["bytes"]
    fpi = b["wal"]["fpi"] - a["wal"]["fpi"]
    records = b["wal"]["records"] - a["wal"]["records"]
    ta = {t["name"]: t for t in a.get("tables", [])}
    tables = []
    for t in b.get("tables", []):
        p = ta.get(t["name"])
        if not p:
            continue
        upd, hot = t["upd"] - p["upd"], t["hot"] - p["hot"]
        tables.append({"name": t["name"], "ins": t["ins"] - p["ins"], "upd": upd, "hot": hot,
                       "hot_pct": round(100 * hot / upd, 1) if upd > 0 else None,
                       "bytes_delta": t["bytes"] - p["bytes"]})
    tables.sort(key=lambda r: r["upd"] + r["ins"], reverse=True)
    sa = {s["id"]: s for s in a.get("statements", [])}
    stmts = []
    for s in b.get("statements", []):
        p = sa.get(s["id"])
        d = s["wal_bytes"] - (p["wal_bytes"] if p else 0)
        if d <= 0:
            continue
        stmts.append({"id": s["id"], "wal_bytes": d, "wal_fpi": s["wal_fpi"] - (p["wal_fpi"] if p else 0),
                      "calls": s["calls"] - (p["calls"] if p else 0), "rows": s["rows"] - (p["rows"] if p else 0),
                      "share_pct": round(100 * d / wal_bytes, 1) if wal_bytes > 0 else None,
                      "new_in_top": p is None, "query": s["query"]})
    stmts.sort(key=lambda r: r["wal_bytes"], reverse=True)
    oa, ob = a.get("outbox") or {}, b.get("outbox") or {}
    return {
        "from": a["now"], "to": b["now"], "hours": round(hours, 2), "stats_reset_between": reset,
        "wal_bytes": wal_bytes, "wal_bytes_per_day": int(wal_bytes * 24 / hours),
        "wal_fpi": fpi, "wal_records": records,
        "fpi_per_record_pct": round(100 * fpi / records, 2) if records > 0 else None,
        "checkpoints_timed": (b.get("checkpoints") or {}).get("timed", 0) - (a.get("checkpoints") or {}).get("timed", 0),
        "checkpoints_requested": (b.get("checkpoints") or {}).get("requested", 0)
        - (a.get("checkpoints") or {}).get("requested", 0),
        "tables": tables, "statements": stmts[:25],
        "statements_coverage_pct": round(100 * sum(s["wal_bytes"] for s in stmts) / wal_bytes, 1)
        if wal_bytes > 0 else None,
        "outbox_rows_per_day": int(((ob.get("rows_estimate") or 0) - (oa.get("rows_estimate") or 0)) * 24 / hours),
        "outbox_bytes_per_day": int(((ob.get("bytes") or 0) - (oa.get("bytes") or 0)) * 24 / hours),
    }


def render(d: dict) -> str:
    lines = [f"{d['from']} -> {d['to']} ({d['hours']} sa)"]
    if d["stats_reset_between"]:
        lines.append("UYARI: arada pg_stat_wal sifirlanmis; farklar gecersiz")
    lines.append(f"WAL {gb(d['wal_bytes'])} (gunluk {gb(d['wal_bytes_per_day'])}), FPI {d['wal_fpi']} "
                 f"(kayitlarin %{d['fpi_per_record_pct']}), checkpoint zamanli {d['checkpoints_timed']} / "
                 f"istenen {d['checkpoints_requested']}")
    lines.append(f"search_outbox: gunluk ~{d['outbox_rows_per_day']} satir, ~{gb(d['outbox_bytes_per_day'])}")
    lines.append("tablolar (ekleme | guncelleme | HOT %):")
    for t in d["tables"][:10]:
        lines.append(f"  {t['name']:<28} {t['ins']:>12} | {t['upd']:>12} | {t['hot_pct']}")
    lines.append(f"ifadeler (WAL'in %{d['statements_coverage_pct']}'i ilk 200 ifadede):")
    for s in d["statements"][:15]:
        lines.append(f"  {gb(s['wal_bytes']):>10} %{s['share_pct']:<5} cagri {s['calls']:<6} {s['query'][:110]}")
    return "\n".join(lines)


def snapshots(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.json"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="/opt/arilla")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot")
    s.add_argument("--label", default="")
    d = sub.add_parser("diff")
    d.add_argument("files", nargs="*")
    d.add_argument("--json", action="store_true")
    sub.add_parser("list")
    args = ap.parse_args(argv)
    root = Path(args.root)
    directory = root / "state" / "wal"

    if args.cmd == "snapshot":
        if args.label and not re.fullmatch(r"[a-z0-9-]{1,40}", args.label):
            print("etiket: kucuk harf, rakam, tire (en fazla 40)", file=sys.stderr)
            return 64
        try:
            snap = take_snapshot(hc.Collector(root))
        except (RuntimeError, ValueError, json.JSONDecodeError) as error:
            print(f"HATA: {error}", file=sys.stderr)
            return 1
        snap["label"] = args.label or None
        directory.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = directory / (stamp + (f"-{args.label}" if args.label else "") + ".json")
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(snap), encoding="utf-8")
        tmp.replace(path)
        for old in snapshots(directory)[:-KEEP]:
            old.unlink(missing_ok=True)
        print(path)
        return 0

    if args.cmd == "list":
        for p in snapshots(directory):
            print(p.name)
        return 0

    files = [Path(f) if "/" in f else directory / f for f in args.files] if args.files else snapshots(directory)[-2:]
    if len(files) != 2:
        print("iki goruntu gerekli (wal_report.py snapshot)", file=sys.stderr)
        return 64
    a, b = (json.loads(f.read_text(encoding="utf-8")) for f in files)
    result = diff(a, b)
    print(json.dumps(result, ensure_ascii=False) if args.json else render(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
