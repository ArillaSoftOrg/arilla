"""pre_migrate_dumps.py testleri (docker/PostgreSQL yok; sahte calistirici). Linux (fcntl)."""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from collections import namedtuple
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows: dosya kilidi testi yalniz Linux'ta (VPS ve CI)
    raise unittest.SkipTest("fcntl yok") from None

import pre_migrate_dumps as pmd

Usage = namedtuple("Usage", "total used free")
GOOD_TOC = (
    ";\n; Archive created at 2026-11-12 17:11:00 UTC\n;     Format: CUSTOM\n"
    "3; 2615 2200 SCHEMA - public pg_database_owner\n"
    "5001; 0 16400 TABLE DATA public offer arilla\n"
    "5002; 0 16401 TABLE DATA public schema_migration arilla\n"
)


class FakeDocker:
    """`docker compose ps`, `docker inspect`, `docker run ... pg_restore`: dosya icerigine gore sonuc."""

    def __init__(self):
        self.calls = []

    def __call__(self, cmd, stdin_path=None, timeout=0):
        self.calls.append((cmd, stdin_path))
        if cmd[:2] == ["docker", "compose"]:
            return 0, "cid123\n"
        if cmd[:2] == ["docker", "inspect"]:
            return 0, "arilla-postgres@sha256:abc\n"
        if cmd[:2] == ["docker", "run"]:
            assert "--network" in cmd and cmd[cmd.index("--network") + 1] == "none"
            assert "--read-only" in cmd and stdin_path is not None
            data = Path(stdin_path).read_bytes()
            if b"CORRUPT" in data:
                return 1, "pg_restore: error: could not uncompress data"
            if "-l" in cmd:
                if b"NO_SCHEMA_MIGRATION" in data:
                    return 0, GOOD_TOC.replace("schema_migration", "other_table")
                if b"FEWER" in data:
                    return 0, ";\n5001; 0 16400 TABLE DATA public schema_migration arilla\n"
                return 0, GOOD_TOC
            return 0, ""
        return 1, "beklenmeyen komut"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "backups").mkdir()
        (self.root / "logs").mkdir()
        self.free = 500 * pmd.GiB
        self.fake = FakeDocker()
        self.d = pmd.Dumps(self.root, run=self.fake, disk_usage=lambda p: Usage(10**13, 0, self.free))

    def tearDown(self):
        self.tmp.cleanup()

    def name(self, i: int) -> str:
        return f"pre-migrate-202611{i:02d}-120000-{i:012x}.dump"

    def make(self, i: int, content: bytes = b"PGDMP data", status: str | None = "success", full: bool | None = True):
        path = self.root / "backups" / self.name(i)
        path.write_bytes(content * 10)
        if status is not None:
            self.d.begin(path, f"202611{i:02d}-120000", "a" * 40, [f"01{i:02d}_x.sql"])
            ok, meta = self.d.finish(path)
            if status != "created" and ok:
                meta = self.d.set_status(path, status)
            if full is not None:
                meta["verify"] = {"full_read": {"ok": full, "at": "2026-11-12T00:00:00Z", "seconds": 1}}
                self.d.write_meta(path, meta)
        return path


class CapacityTest(Base):
    def test_first_dump_uses_database_ratio(self):
        res = self.d.capacity(db_bytes=75 * 10**9, reserve=30 * pmd.GiB)
        self.assertEqual(res["estimate"], int(75 * 10**9 * pmd.FIRST_RATIO))
        self.assertTrue(res["ok"])

    def test_estimate_from_newest_dumps_and_insufficient(self):
        self.make(1, b"x" * 1000, status=None)
        self.make(2, b"y" * 2000, status=None)
        res = self.d.capacity(db_bytes=1, reserve=0)
        self.assertEqual(res["estimate"], int(20000 * pmd.GROWTH))
        self.free = 30 * pmd.GiB
        res = self.d.capacity(db_bytes=1)  # varsayilan taban 30 GiB + tahmin > 30 GiB bos
        self.assertFalse(res["ok"])

    def test_cli_insufficient_exit_2_and_message(self):
        err = io.StringIO()
        os.environ["ARILLA_DUMP_RESERVE_BYTES"] = str(10**15)
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
                rc = pmd.main(["--root", str(self.root), "capacity", "--db-bytes", "1000"])
        finally:
            del os.environ["ARILLA_DUMP_RESERVE_BYTES"]
        self.assertEqual(rc, 2)
        self.assertIn("Migration BASLATILMADI", err.getvalue())


class CatalogGateTest(Base):
    """Karar 0188: dokumden sonra bos alan katalog esiginin (70 GiB) altina dusecekse deploy durur."""

    def setUp(self):
        super().setUp()
        self.make(1, b"x" * 1000, status=None)  # tahmin = 1150 bayt

    def test_gate_blocks_when_dump_would_cross_catalog_threshold(self):
        self.free = 73 * pmd.GiB  # 13 Kasim: 73 GiB bos, yeni dokum ~11 GB
        res = self.d.capacity(db_bytes=1, reserve=0, catalog_gate=73 * pmd.GiB)
        self.assertFalse(res["catalog_gate_ok"])
        self.assertFalse(res["ok"])

    def test_gate_ok_with_room(self):
        self.free = 90 * pmd.GiB
        res = self.d.capacity(db_bytes=1, reserve=0)
        self.assertTrue(res["catalog_gate_ok"])
        self.assertTrue(res["ok"])

    def test_explicit_override_allows_but_reports(self):
        self.free = 70 * pmd.GiB
        res = self.d.capacity(db_bytes=1, reserve=0, allow_below_gate=True)
        self.assertFalse(res["catalog_gate_ok"])
        self.assertTrue(res["ok"])

    def _cli(self, allow: bool):
        self.free = 70 * pmd.GiB
        err = io.StringIO()
        os.environ["ARILLA_DUMP_RESERVE_BYTES"] = "0"
        if allow:
            os.environ["ARILLA_DEPLOY_ALLOW_BELOW_CATALOG_GATE"] = "1"
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
                rc = pmd.main(["--root", str(self.root), "capacity", "--db-bytes", "1000"])
        finally:
            os.environ.pop("ARILLA_DUMP_RESERVE_BYTES", None)
            os.environ.pop("ARILLA_DEPLOY_ALLOW_BELOW_CATALOG_GATE", None)
        return rc, err.getvalue()

    def test_cli_gate_exit_2_with_message(self):
        rc, err = self._cli(allow=False)
        self.assertEqual(rc, 2)
        self.assertIn("KATALOG ESIGI", err)
        self.assertIn("Migration BASLATILMADI", err)

    def test_cli_gate_override_exit_0_and_warns(self):
        rc, err = self._cli(allow=True)
        self.assertEqual(rc, 0)
        self.assertIn("bilincli devam", err)

    def test_gate_matches_catalog_guard(self):
        guard = (Path(__file__).resolve().parent / "catalog-auto-guard").read_text(encoding="utf-8")
        self.assertIn(f"START_FREE_GB=${{START_FREE_GB:-{pmd.CATALOG_GATE_GIB}}}", guard)


class LifecycleTest(Base):
    def test_good_dump_metadata(self):
        path = self.make(3, status="created", full=None)
        meta = self.d.read_meta(path)
        self.assertEqual(meta["status"], "created")
        self.assertEqual(meta["sha256"], pmd.Dumps.sha256(path))
        self.assertEqual(meta["size"], path.stat().st_size)
        self.assertEqual(meta["deploy_id"], "20261103-120000")
        self.assertEqual(meta["migrations"], ["0103_x.sql"])
        self.assertEqual(meta["toc"], {"entries": 3, "table_data": 2, "has_schema_migration": True})
        self.assertEqual(oct(os.stat(self.d.meta_path(path)).st_mode & 0o777), "0o600")

    def test_empty_corrupt_and_missing_schema_migration_fail(self):
        for i, content, reason in ((4, b"", "bos"), (5, b"CORRUPT", "pg_restore -l"),
                                   (6, b"NO_SCHEMA_MIGRATION", "schema_migration")):
            path = self.root / "backups" / self.name(i)
            path.write_bytes(content)
            self.d.begin(path, "20261112-120000", "a" * 40, [])
            ok, meta = self.d.finish(path)
            self.assertFalse(ok, i)
            self.assertEqual(meta["status"], "dump_failed")
            self.assertIn(reason, meta["reason"])

    def test_fewer_tables_is_not_corruption(self):
        path = self.root / "backups" / self.name(7)
        path.write_bytes(b"FEWER")
        self.d.begin(path, "20261112-120000", "a" * 40, [])
        ok, meta = self.d.finish(path)
        self.assertTrue(ok)  # mesru sema degisikligi: tablo sayisi kiyaslanmaz
        self.assertEqual(meta["toc"]["table_data"], 1)

    def test_failed_does_not_override_dump_failed_or_success(self):
        bad = self.root / "backups" / self.name(8)
        bad.write_bytes(b"")
        self.d.begin(bad, "20261112-120000", "a" * 40, [])
        self.d.finish(bad)
        self.assertEqual(self.d.set_status(bad, "failed")["status"], "dump_failed")
        ok = self.make(9, status="success", full=None)
        self.assertEqual(self.d.set_status(ok, "failed")["status"], "success")
        mig = self.make(10, status="migrated", full=None)
        self.assertEqual(self.d.set_status(mig, "failed")["status"], "failed")

    def test_verify_detects_changed_file_and_writes_state_note(self):
        path = self.make(11, full=None)
        self.assertTrue(self.d.verify(path, full=True)["ok"])
        path.write_bytes(b"PGDMP tampered!!" * 10)
        res = self.d.verify(path, full=False)
        self.assertFalse(res["sha256_ok"])
        self.assertFalse(res["ok"])
        with contextlib.redirect_stdout(io.StringIO()):
            pmd.main(["--root", str(self.root), "verify", "--newest", "--state"])
        state = json.loads((self.root / "state" / "pre-migrate-verify.json").read_text())
        self.assertIn("gercek PostgreSQL geri yukleme kaniti DEGIL", state["note"])


class ClassifyTest(Base):
    def test_keep_newest_two_valid_and_protect_others(self):
        for i in (1, 2, 3):
            self.make(i)  # success + dogrulanmis
        self.make(4, status="failed")
        (self.root / "backups" / self.name(5)).write_bytes(b"legacy")  # metadata yok
        self.make(6, full=None)  # basarili ama tam okunmamis
        self.make(7, status="migrated")  # yarim kalmis
        rows = {r["file"]: r for r in self.d.classify()}
        self.assertTrue(rows[self.name(1)]["candidate"])
        self.assertFalse(rows[self.name(2)]["candidate"])
        self.assertFalse(rows[self.name(3)]["candidate"])
        self.assertIn("en yeni 2", rows[self.name(3)]["reason"])
        self.assertIn("insan karari", rows[self.name(4)]["reason"])
        self.assertIn("metadata yok", rows[self.name(5)]["reason"])
        self.assertIn("tam veri okumasi", rows[self.name(6)]["reason"])
        self.assertIn("insan karari", rows[self.name(7)]["reason"])
        self.assertEqual(sum(r["candidate"] for r in rows.values()), 1)

    def test_newest_two_kept_regardless_of_age_and_no_candidate_below_two(self):
        self.make(1)
        rows = self.d.classify()
        self.assertFalse(any(r["candidate"] for r in rows))
        self.make(2)
        self.assertFalse(any(r["candidate"] for r in self.d.classify()))


class PruneTest(Base):
    def setUp(self):
        super().setUp()
        for i in (1, 2, 3, 4, 5):
            self.make(i)

    def test_without_confirm_deletes_nothing(self):
        rep = self.d.prune(confirm=False)
        self.assertEqual(rep["candidates"], [self.name(1), self.name(2), self.name(3)])
        self.assertEqual(rep["deleted"], [])
        self.assertEqual(len(self.d.files()), 5)

    def test_confirm_verifies_all_then_deletes_with_audit(self):
        rep = self.d.prune(confirm=True)
        self.assertEqual(rep["deleted"], [self.name(1), self.name(2), self.name(3)])
        self.assertEqual([p.name for p in self.d.files()], [self.name(4), self.name(5)])
        self.assertFalse(self.d.meta_path(self.root / "backups" / self.name(1)).exists())
        audit = [json.loads(x) for x in (self.root / "state" / "pre-migrate-prune.log").read_text().splitlines()]
        self.assertEqual([a["file"] for a in audit], rep["deleted"])
        self.assertEqual(audit[0]["kept"], [self.name(4), self.name(5)])
        self.assertTrue(all(a["sha256"] for a in audit))
        full_reads = [c for c, _ in self.fake.calls if c[:2] == ["docker", "run"] and "/dev/null" in c]
        self.assertEqual(len(full_reads), 5)  # 3 aday + korunan 2: hepsi silmeden once tam okundu

    def test_changed_candidate_stops_before_any_delete(self):
        (self.root / "backups" / self.name(2)).write_bytes(b"degisti" * 10)
        with self.assertRaises(RuntimeError):
            self.d.prune(confirm=True)
        self.assertEqual(len(self.d.files()), 5)

    def test_corrupt_kept_dump_stops_prune(self):
        p = self.root / "backups" / self.name(5)
        meta = self.d.read_meta(p)
        p.write_bytes(b"CORRUPT" * 10)
        meta["sha256"], meta["size"] = pmd.Dumps.sha256(p), p.stat().st_size
        self.d.write_meta(p, meta)
        with self.assertRaises(RuntimeError):
            self.d.prune(confirm=True)
        self.assertEqual(len(self.d.files()), 5)

    def test_concurrent_deploy_lock_blocks(self):
        with open(self.root / ".deploy.lock", "a") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(RuntimeError) as ctx:
                self.d.prune(confirm=True)
        self.assertIn("kilit", str(ctx.exception))
        self.assertEqual(len(self.d.files()), 5)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with open(self.root / ".deploy.lock", "a") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(pmd.main(["--root", str(self.root), "prune", "--confirm"]), 75)

    def test_only_must_be_candidate(self):
        with self.assertRaises(ValueError):
            self.d.prune(confirm=True, only=[self.name(5)])  # korunan
        rep = self.d.prune(confirm=True, only=[self.name(1)])
        self.assertEqual(rep["deleted"], [self.name(1)])

    def test_symlink_and_bad_paths_rejected(self):
        target = self.root / "baska.dump"
        target.write_bytes(b"x")
        link = self.root / "backups" / self.name(9)
        link.symlink_to(target)
        with self.assertRaises(ValueError):
            self.d.safe_path(self.name(9))
        for bad in ("../x.dump", "pre-migrate-1.dump", "/etc/passwd", self.name(1) + "/../../x"):
            with self.assertRaises(ValueError, msg=bad):
                self.d.safe_path(bad)
        self.assertNotIn(self.name(9), [p.name for p in self.d.files()])  # baglanti listelenmez
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            rc = pmd.main(["--root", str(self.root), "set-status", "--dump", "/tmp/" + self.name(1), "--status", "failed"])
        self.assertEqual(rc, 1)
        self.assertIn("backups disinda", err.getvalue())
        self.assertTrue(target.exists())


class AdoptTest(Base):
    def test_adopt_from_deploy_log(self):
        old = self.root / "backups" / self.name(8)
        old.write_bytes(b"PGDMP legacy" * 5)
        lost = self.root / "backups" / self.name(9)
        lost.write_bytes(b"PGDMP lost" * 5)
        (self.root / "logs" / "deploy-20261108-120000.log").write_text(
            "2026-11-08T12:00:01Z [deploy] bekleyen migration: 1 dosya (0108_x.sql ...)\n"
            f"2026-11-08T12:09:00Z [deploy] migration oncesi yedek: /opt/arilla/backups/{old.name} (60 bayt)\n"
            f"DEPLOY_RESULT=success sha={'b' * 40} changed=web\n")
        preview = self.d.adopt(confirm=False)
        self.assertIsNone(self.d.read_meta(old))
        self.assertEqual({r["file"]: r["status"] for r in preview}, {old.name: "success", lost.name: "failed"})
        self.d.adopt(confirm=True)
        meta = self.d.read_meta(old)
        self.assertEqual((meta["status"], meta["sha"], meta["migrations"], meta["legacy"]),
                         ("success", "b" * 40, ["0108_x.sql"], True))
        self.assertEqual(meta["sha256"], pmd.Dumps.sha256(old))
        self.assertEqual(self.d.read_meta(lost)["status"], "failed")  # gunluksuz: korunur
        rows = {r["file"]: r for r in self.d.classify()}
        self.assertFalse(rows[old.name]["candidate"])  # tam okunmadan aday olmaz


@unittest.skipIf(sys.platform.startswith("win"), "yalniz Linux")
class HealthcheckTest(unittest.TestCase):
    def test_levels(self):
        import arilla_healthcheck as hc

        now = datetime(2026, 11, 20, tzinfo=timezone.utc)
        base = {"file": "f", "size": 10**9, "status": "success", "meta": True, "candidate": False,
                "created_at": (now - timedelta(days=1)).isoformat()}
        self.assertIsNone(hc.pre_migrate_check([], now))
        ok = hc.pre_migrate_check([dict(base, full_read_ok=True)], now)
        self.assertEqual(ok.level, hc.OK)
        self.assertIn("yalniz prune --confirm", ok.message)
        self.assertEqual(hc.pre_migrate_check([dict(base, full_read_ok=False)], now).level, hc.CRIT)
        old = dict(base, full_read_ok=None, created_at=(now - timedelta(days=9)).isoformat())
        self.assertEqual(hc.pre_migrate_check([old], now).level, hc.WARN)
        fresh = dict(base, full_read_ok=None)  # yeni deploy dokumu: haftalik okumayi bekler, alarm yok
        self.assertEqual(hc.pre_migrate_check([fresh], now).level, hc.OK)
        pending = dict(base, status="failed", full_read_ok=True)
        self.assertEqual(hc.pre_migrate_check([pending, dict(base, full_read_ok=True)], now).level, hc.WARN)
        legacy = dict(base, meta=False, status=None, full_read_ok=None)
        self.assertEqual(hc.pre_migrate_check([legacy, dict(base, full_read_ok=True)], now).level, hc.WARN)


if __name__ == "__main__":
    unittest.main()
