"""backup_monitor.py testleri (docker yok): python3 -m unittest test_backup_monitor"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

import backup_monitor as bm

G = 1 << 30


class ParseTest(unittest.TestCase):
    def test_sizes(self):
        self.assertEqual(bm.parse_size("512MiB"), 512 << 20)
        self.assertEqual(bm.parse_size("1.5GB"), 1_500_000_000)
        self.assertEqual(bm.parse_size("30kB"), 30_000)
        self.assertEqual(bm.parse_size("0B"), 0)
        self.assertIsNone(bm.parse_size("x"))
        self.assertIsNone(bm.parse_size("12 parsecs"))

    def test_stats_line(self):
        s = bm.parse_stats("87.35%|120.4MiB / 512MiB|3.2GB / 41.5MB")
        self.assertEqual(s["cpu_pct"], 87.35)
        self.assertEqual(s["mem_bytes"], int(120.4 * (1 << 20)))
        self.assertEqual(s["rx_bytes"], 3_200_000_000)
        self.assertIsNone(bm.parse_stats("--|--|--"))
        self.assertIsNone(bm.parse_stats(""))


class BreachTest(unittest.TestCase):
    def test_order_and_thresholds(self):
        lim = bm.Limits(min_free=30 * G, max_dir=8 * G, abort_ready=64, abort_oldest_s=600, deadline_s=100)
        self.assertIsNone(bm.breach({"free_bytes": 31 * G, "dir_bytes": G, "archive_ready": 3, "archive_oldest_s": 20}, lim, 10))
        self.assertEqual(bm.breach({"free_bytes": 29 * G}, lim, 10), "min_free")
        self.assertEqual(bm.breach({"dir_bytes": 9 * G}, lim, 10), "max_dir")
        self.assertEqual(bm.breach({"archive_ready": 64}, lim, 10), "wal_backlog")
        self.assertEqual(bm.breach({"archive_ready": 1, "archive_oldest_s": 600}, lim, 10), "wal_backlog")
        # bekleyen dosya yokken "en eski yas" anlamsiz
        self.assertIsNone(bm.breach({"archive_ready": 0, "archive_oldest_s": 900}, lim, 10))
        self.assertEqual(bm.breach({}, lim, 100), "deadline")
        # olculemeyen deger sinir asimi sayilmaz (yalniz olculeni uygula)
        self.assertIsNone(bm.breach({"free_bytes": None, "dir_bytes": None}, lim, 0))

    def test_no_limits(self):
        self.assertIsNone(bm.breach({"free_bytes": 0, "archive_ready": 10**6}, bm.Limits(), 10**9))


class FakeDocker:
    """Konteyner yasam dongusu: `appear_after` sorgudan sonra calisir, `run_for` ornekten sonra biter."""

    def __init__(self, appear_after=1, run_for=3, stats="50.0%|100MiB / 512MiB|1GB / 1MB", archive="0|0"):
        self.calls, self.queries, self.samples = [], 0, 0
        self.appear_after, self.run_for, self.stats, self.archive = appear_after, run_for, stats, archive
        self.killed = False

    def __call__(self, cmd, timeout):
        self.calls.append(cmd)
        if cmd[:2] == ["docker", "inspect"]:
            self.queries += 1
            if self.queries <= self.appear_after:
                return 1, ""
            running = not self.killed and self.samples < self.run_for
            return 0, "true\n" if running else "false\n"
        if cmd[:2] == ["docker", "stats"]:
            self.samples += 1
            return 0, self.stats + "\n"
        if cmd[:2] == ["docker", "kill"]:
            self.killed = True
            return 0, ""
        if "psql" in cmd:
            return 0, self.archive + "\n"
        return 1, ""


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


class WatchTest(unittest.TestCase):
    def root(self):
        d = tempfile.mkdtemp()
        (Path(d) / "env").mkdir()
        (Path(d) / "env" / "postgres.env").write_text("POSTGRES_USER=arilla\nPOSTGRES_DB=arilla\n")
        return Path(d)

    def test_completes_and_summarizes(self):
        fake, clock = FakeDocker(run_for=3, archive="2|30"), Clock()
        r = bm.watch("c1", bm.Limits(abort_ready=64), interval=15, root=self.root(), run=fake,
                     sleep=clock.sleep, clock=clock)
        self.assertTrue(r["container_seen"])
        self.assertIsNone(r["aborted"])
        self.assertEqual(r["samples"], 3)
        self.assertEqual(r["cpu_max_pct"], 50.0)
        self.assertEqual(r["mem_max_bytes"], 100 << 20)
        self.assertEqual(r["read_bytes_min"], 1_000_000_000)
        self.assertEqual(r["archive_ready_baseline"], 2)
        self.assertEqual(r["archive_ready_max"], 2)
        self.assertFalse(fake.killed)

    def test_wal_backlog_kills_container(self):
        fake, clock = FakeDocker(run_for=50, archive="80|30"), Clock()
        r = bm.watch("c1", bm.Limits(abort_ready=64), interval=15, root=self.root(), run=fake,
                     sleep=clock.sleep, clock=clock)
        self.assertEqual(r["aborted"], "wal_backlog")
        self.assertTrue(fake.killed)
        self.assertIn(["docker", "kill", "c1"], fake.calls)

    def test_deadline(self):
        fake, clock = FakeDocker(run_for=10**6), Clock()
        r = bm.watch("c1", bm.Limits(deadline_s=60), interval=15, run=fake, sleep=clock.sleep, clock=clock)
        self.assertEqual(r["aborted"], "deadline")
        self.assertTrue(fake.killed)

    def test_disk_floor_and_dir_budget(self):
        d = Path(tempfile.mkdtemp())
        (d / "f").write_bytes(b"x" * 200_000)
        fake, clock = FakeDocker(run_for=10), Clock()
        r = bm.watch("c1", bm.Limits(max_dir=100_000), interval=15, dir_path=d, run=fake,
                     sleep=clock.sleep, clock=clock)
        self.assertEqual(r["aborted"], "max_dir")
        fake2, clock2 = FakeDocker(run_for=10), Clock()
        r = bm.watch("c1", bm.Limits(min_free=1 << 62), interval=15, free_path=d, run=fake2,
                     sleep=clock2.sleep, clock=clock2)
        self.assertEqual(r["aborted"], "min_free")

    def test_container_never_appears(self):
        fake, clock = FakeDocker(appear_after=10**6), Clock()
        r = bm.watch("c1", bm.Limits(), interval=15, run=fake, sleep=clock.sleep, clock=clock, start_wait_s=5)
        self.assertFalse(r["container_seen"])
        self.assertEqual(r["samples"], 0)
        # fail-closed: hic gorunmeyen konteyner "tamam" sayilmaz; sonradan baslarsa diye durdurulur
        self.assertEqual(r["aborted"], "not_started")
        self.assertIn(["docker", "kill", "c1"], fake.calls)

    def test_unreadable_wal_status_stops_after_three_samples(self):
        class NoPsql(FakeDocker):
            def __call__(self, cmd, timeout):
                if "psql" in cmd:
                    return 2, ""
                return super().__call__(cmd, timeout)

        fake, clock = NoPsql(run_for=100), Clock()
        r = bm.watch("c1", bm.Limits(abort_ready=64), interval=15, root=self.root(), run=fake,
                     sleep=clock.sleep, clock=clock)
        self.assertEqual(r["aborted"], "wal_status_unknown")
        self.assertEqual(r["samples"], 3)
        self.assertTrue(fake.killed)

    def test_transient_wal_read_error_resets(self):
        class Flaky(FakeDocker):
            n = 0

            def __call__(self, cmd, timeout):
                if "psql" in cmd:
                    Flaky.n += 1
                    return (2, "") if Flaky.n % 2 == 0 else (0, "0|0\n")
                return super().__call__(cmd, timeout)

        fake, clock = Flaky(run_for=8), Clock()
        r = bm.watch("c1", bm.Limits(abort_ready=64), interval=15, root=self.root(), run=fake,
                     sleep=clock.sleep, clock=clock)
        self.assertIsNone(r["aborted"])
        self.assertFalse(fake.killed)

    def test_main_rejects_bad_name_and_writes_json(self):
        self.assertEqual(bm.main(["watch", "--container", "bad name;rm", "--out", os.devnull]), 64)

    @unittest.skipUnless(sys.platform.startswith("linux"), "seyrek dosya: Linux")
    def test_sparse_files_count_allocated_blocks_only(self):
        d = Path(tempfile.mkdtemp())
        with open(d / "sparse", "wb") as fh:
            fh.truncate(5 * G)  # seyrek: 5 GiB gorunur, ~0 ayrilmis
        self.assertLess(bm.allocated_bytes(d), 1 << 20)


if __name__ == "__main__":
    unittest.main()
