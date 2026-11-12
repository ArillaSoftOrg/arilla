"""wal_report.py testleri (docker/PostgreSQL yok): python3 -m unittest test_wal_report"""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import wal_report as wr


def snap(now, wal_bytes, fpi, records, tables=(), statements=(), outbox=(0, 0), reset="2026-10-13", ckpt=(0, 0)):
    return {
        "now": now, "lsn": "0/0",
        "wal": {"bytes": wal_bytes, "fpi": fpi, "records": records, "stats_reset": reset},
        "checkpoints": {"timed": ckpt[0], "requested": ckpt[1]},
        "tables": [dict(name=n, ins=i, upd=u, hot=h, **{"del": 0}, live=0, dead=0, bytes=b) for n, i, u, h, b in tables],
        "statements": [dict(id=q, calls=c, rows=r, wal_records=0, wal_fpi=f, wal_bytes=w, query=t)
                       for q, c, r, f, w, t in statements],
        "outbox": {"rows_estimate": outbox[0], "bytes": outbox[1]},
    }


A = snap("2026-11-12T00:00:00Z", 100 * 10**9, 1000, 10000,
         tables=[("offer", 10, 100, 0, 5000), ("feed_source_offer", 0, 50, 48, 100)],
         statements=[("1", 10, 100, 5, 40 * 10**9, "WITH prev AS (merge)"), ("2", 1, 1, 0, 10**9, "SELECT count(*)")],
         outbox=(1000, 10**6), ckpt=(10, 1))
B = snap("2026-11-12T12:00:00Z", 112 * 10**9, 1600, 13000,
         tables=[("offer", 20, 400, 150, 5500), ("feed_source_offer", 0, 150, 146, 120)],
         statements=[("1", 20, 300, 9, 49 * 10**9, "WITH prev AS (merge)"), ("2", 1, 1, 0, 10**9, "SELECT count(*)"),
                     ("3", 4, 4, 1, 2 * 10**9, "UPDATE product p SET")],
         outbox=(1500, 2 * 10**6), ckpt=(58, 1))


class DiffTest(unittest.TestCase):
    def test_rates_and_shares(self):
        d = wr.diff(A, B)
        self.assertEqual(d["hours"], 12.0)
        self.assertEqual(d["wal_bytes"], 12 * 10**9)
        self.assertEqual(d["wal_bytes_per_day"], 24 * 10**9)
        self.assertEqual(d["wal_fpi"], 600)
        self.assertEqual(d["fpi_per_record_pct"], 20.0)
        self.assertEqual(d["checkpoints_timed"], 48)
        self.assertFalse(d["stats_reset_between"])
        self.assertEqual(d["outbox_rows_per_day"], 1000)

    def test_tables_hot_ratio(self):
        t = {r["name"]: r for r in wr.diff(A, B)["tables"]}
        self.assertEqual(t["offer"]["upd"], 300)
        self.assertEqual(t["offer"]["hot_pct"], 50.0)
        self.assertEqual(t["feed_source_offer"]["hot_pct"], 98.0)

    def test_statements_delta_new_and_unchanged(self):
        s = wr.diff(A, B)["statements"]
        self.assertEqual([x["id"] for x in s], ["1", "3"])  # degismeyen "2" yok
        self.assertEqual(s[0]["wal_bytes"], 9 * 10**9)
        self.assertEqual(s[0]["share_pct"], 75.0)
        self.assertTrue(s[1]["new_in_top"])
        self.assertEqual(wr.diff(A, B)["statements_coverage_pct"], 91.7)

    def test_reset_flagged(self):
        b = json.loads(json.dumps(B))
        b["wal"]["stats_reset"] = "2026-11-12"
        d = wr.diff(A, b)
        self.assertTrue(d["stats_reset_between"])
        self.assertIn("sifirlanmis", wr.render(d))


class SnapshotTest(unittest.TestCase):
    def collector(self, outputs):
        calls = []

        def run(cmd, timeout):
            calls.append(cmd[-1])
            return outputs.pop(0)

        with tempfile.TemporaryDirectory() as d:
            c = wr.hc.Collector(Path(d), run=run)
        return c, calls

    def test_read_only_and_schema(self):
        payload = json.dumps(snap("2026-11-12T00:00:00Z", 1, 1, 1))
        c, calls = self.collector([(0, "monitoring\n"), (0, payload + "\n")])
        s = wr.take_snapshot(c)
        self.assertTrue(s["pg_stat_statements"])
        self.assertTrue(all(q.startswith("BEGIN READ ONLY;") and q.rstrip().endswith("COMMIT;") for q in calls))
        self.assertIn("monitoring.pg_stat_statements", calls[1])
        self.assertNotIn("pg_stat_statements_reset", calls[1])
        self.assertIn("ARRAY['offer'", calls[1])

    def test_without_pg_stat_statements(self):
        payload = json.dumps(snap("2026-11-12T00:00:00Z", 1, 1, 1))
        c, calls = self.collector([(0, "\n"), (0, payload)])
        s = wr.take_snapshot(c)
        self.assertFalse(s["pg_stat_statements"])
        self.assertIn("'[]'::json", calls[1])

    def test_bad_schema_and_failure(self):
        c, _ = self.collector([(0, "evil;drop\n")])
        with self.assertRaises(RuntimeError):
            wr.take_snapshot(c)
        c, _ = self.collector([(0, "monitoring\n"), (1, "")])
        with self.assertRaises(RuntimeError):
            wr.take_snapshot(c)


class CliTest(unittest.TestCase):
    def test_diff_last_two_and_list(self):
        with tempfile.TemporaryDirectory() as d:
            wal = Path(d) / "state" / "wal"
            wal.mkdir(parents=True)
            (wal / "20261112T000000Z.json").write_text(json.dumps(A))
            (wal / "20261112T120000Z-after.json").write_text(json.dumps(B))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(wr.main(["--root", d, "diff"]), 0)
            self.assertIn("gunluk 24.00 GB", out.getvalue())
            self.assertIn("WITH prev AS (merge)", out.getvalue())
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(wr.main(["--root", d, "diff", "--json"]), 0)
            self.assertEqual(json.loads(out.getvalue())["wal_fpi"], 600)

    def test_label_validation_and_missing(self):
        with tempfile.TemporaryDirectory() as d:
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(wr.main(["--root", d, "snapshot", "--label", "Kotu Etiket"]), 64)
                self.assertEqual(wr.main(["--root", d, "diff"]), 64)


if __name__ == "__main__":
    unittest.main()
