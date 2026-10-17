"""arilla_healthcheck.py testleri (ag yok, docker yok): python3 infra/vps/bin/test_arilla_healthcheck.py"""

import json
import tempfile
import unittest
from collections import namedtuple
from datetime import datetime, timedelta, timezone
from pathlib import Path

import arilla_healthcheck as hc

NOW = datetime(2026, 10, 14, 12, 0, tzinfo=timezone.utc)
Usage = namedtuple("Usage", "total used free")
HEALTHY = {s: "healthy" for s in hc.CORE_SERVICES}


def pg(**over):
    base = {"archive_mode": "on", "connections": 10, "max_connections": 60, "ready_count": 0,
            "oldest_ready_s": 0, "wal_bytes": 64 << 20, "failed_count": 0,
            "last_failed": None, "last_archived": "2026-10-14 11:58:00+00"}
    base.update(over)
    return base


def info(*backups, code=0):
    return [{"name": "arilla", "status": {"code": code, "message": "ok" if code == 0 else "depo erisilemez"},
             "backup": [{"type": t, "timestamp": {"stop": int((NOW - age).timestamp())}} for t, age in backups]}]


def facts(**over):
    base = {"disk": {"/opt/arilla": 40.0}, "containers": dict(HEALTHY, backup="healthy"),
            "backup_configured": True, "pg": pg(),
            "backup_info": info(("full", timedelta(days=2)), ("diff", timedelta(hours=10))),
            "restore_test": {"ok": True, "finished_at": (NOW - timedelta(days=3)).isoformat(), "result": {"rto_s": 42}},
            "failed_units": []}
    base.update(over)
    return base


def levels(checks):
    return {c.name: c.level for c in checks}


class EvaluateTest(unittest.TestCase):
    def test_all_ok(self):
        checks = hc.evaluate(facts(), NOW)
        self.assertEqual(hc.overall(checks), hc.OK, [c for c in checks if c.level != hc.OK])

    def test_disk_thresholds(self):
        self.assertEqual(levels(hc.evaluate(facts(disk={"/": 72.0}), NOW))["disk:/"], hc.WARN)
        self.assertEqual(levels(hc.evaluate(facts(disk={"/": 85.0}), NOW))["disk:/"], hc.CRIT)

    def test_unhealthy_core_service(self):
        c = dict(HEALTHY, backup="healthy", web="unhealthy")
        self.assertEqual(levels(hc.evaluate(facts(containers=c), NOW))["containers"], hc.CRIT)

    def test_postgres_unreachable(self):
        self.assertEqual(levels(hc.evaluate(facts(pg=None), NOW))["postgres"], hc.CRIT)

    def test_archive_not_enabled_before_activation_is_warning(self):
        f = facts(backup_configured=False, pg=pg(archive_mode="off"), containers=dict(HEALTHY), backup_info=None, restore_test=None)
        lv = levels(hc.evaluate(f, NOW))
        self.assertEqual(lv["wal-archive"], hc.WARN)
        self.assertNotIn("backup:last", lv)  # etkinlestirilmemisken yedek yasi alarmi yok

    def test_archive_off_but_configured_is_critical(self):
        self.assertEqual(levels(hc.evaluate(facts(pg=pg(archive_mode="off")), NOW))["wal-archive"], hc.CRIT)

    def test_archive_backlog(self):
        self.assertEqual(levels(hc.evaluate(facts(pg=pg(ready_count=5)), NOW))["wal-archive"], hc.WARN)
        self.assertEqual(levels(hc.evaluate(facts(pg=pg(ready_count=20)), NOW))["wal-archive"], hc.CRIT)
        # tek dosya bile 15 dakikadir bekliyorsa kritik (depo erisilemez)
        self.assertEqual(levels(hc.evaluate(facts(pg=pg(ready_count=1, oldest_ready_s=1200)), NOW))["wal-archive"], hc.CRIT)

    def test_bulk_publish_window_raises_ready_threshold(self):
        live = {"ready_crit": 128, "until": (NOW + timedelta(minutes=5)).timestamp()}
        stale = {"ready_crit": 128, "until": (NOW - timedelta(seconds=1)).timestamp()}
        lv = lambda **o: levels(hc.evaluate(facts(**o), NOW))["wal-archive"]  # noqa: E731
        self.assertEqual(lv(pg=pg(ready_count=60), bulk_window=live), hc.OK)
        self.assertEqual(lv(pg=pg(ready_count=70), bulk_window=live), hc.WARN)
        self.assertEqual(lv(pg=pg(ready_count=128), bulk_window=live), hc.CRIT)
        # bayat kalp atisi (bekci oldu) normal esiklere doner
        self.assertEqual(lv(pg=pg(ready_count=20), bulk_window=stale), hc.CRIT)
        # depo erisilemez kurali pencerede de gecerli
        self.assertEqual(lv(pg=pg(ready_count=2, oldest_ready_s=1200), bulk_window=live), hc.CRIT)
        # bozuk / asiri deger
        self.assertEqual(lv(pg=pg(ready_count=20), bulk_window={"until": "x"}), hc.CRIT)
        huge = dict(live, ready_crit=10**9)
        self.assertEqual(lv(pg=pg(ready_count=hc.BULK_WINDOW_MAX_READY), bulk_window=huge), hc.CRIT)

    def test_recent_failure_is_warning(self):
        p = pg(failed_count=3, last_failed="2026-10-14 11:59:00+00", last_archived="2026-10-14 11:00:00+00")
        self.assertEqual(levels(hc.evaluate(facts(pg=p), NOW))["wal-archive"], hc.WARN)

    def test_idle_database_is_not_alarmed(self):
        # Bos veritabaninda yeni WAL yok: eski last_archived TEK BASINA alarm degildir.
        p = pg(last_archived="2026-10-10 00:00:00+00")
        self.assertEqual(levels(hc.evaluate(facts(pg=p), NOW))["wal-archive"], hc.OK)

    def test_backup_age(self):
        old = info(("full", timedelta(days=9)), ("diff", timedelta(days=2)))
        lv = levels(hc.evaluate(facts(backup_info=old), NOW))
        self.assertEqual(lv["backup:last"], hc.CRIT)
        self.assertEqual(lv["backup:full"], hc.CRIT)

    def test_no_backup(self):
        self.assertEqual(levels(hc.evaluate(facts(backup_info=info()), NOW))["backup:last"], hc.CRIT)

    def test_stanza_error(self):
        lv = levels(hc.evaluate(facts(backup_info=info(("full", timedelta(days=1)), code=99)), NOW))
        self.assertEqual(lv["backup:stanza"], hc.CRIT)

    def test_backup_container_down(self):
        self.assertEqual(levels(hc.evaluate(facts(containers=dict(HEALTHY)), NOW))["backup:container"], hc.CRIT)

    def test_restore_test(self):
        self.assertEqual(levels(hc.evaluate(facts(restore_test=None), NOW))["restore-test"], hc.WARN)
        stale = {"ok": True, "finished_at": (NOW - timedelta(days=40)).isoformat()}
        self.assertEqual(levels(hc.evaluate(facts(restore_test=stale), NOW))["restore-test"], hc.WARN)
        bad = {"ok": False, "finished_at": NOW.isoformat()}
        self.assertEqual(levels(hc.evaluate(facts(restore_test=bad), NOW))["restore-test"], hc.CRIT)

    def test_failed_units(self):
        self.assertEqual(levels(hc.evaluate(facts(failed_units=["arilla-backup-diff.service"]), NOW))["systemd"], hc.CRIT)

    def test_connections(self):
        self.assertEqual(levels(hc.evaluate(facts(pg=pg(connections=55)), NOW))["postgres:connections"], hc.CRIT)


class NotifyTest(unittest.TestCase):
    def test_webhook_decisions(self):
        bad = [hc.Check("disk:/", hc.CRIT, "x")]
        good = [hc.Check("disk:/", hc.OK, "x")]
        self.assertEqual(hc.decide_webhook(None, bad, NOW), "problem")
        sent = {"fingerprint": hc.fingerprint(bad), "sent_at": NOW.isoformat()}
        self.assertIsNone(hc.decide_webhook(sent, bad, NOW + timedelta(hours=1)))
        self.assertEqual(hc.decide_webhook(sent, bad, NOW + timedelta(hours=7)), "reminder")
        self.assertEqual(hc.decide_webhook(sent, good, NOW), "recovered")
        self.assertIsNone(hc.decide_webhook(None, good, NOW))

    def test_message_has_no_ok_lines(self):
        msg = hc.format_message("problem", [hc.Check("a", hc.OK, "iyi"), hc.Check("b", hc.CRIT, "kotu")], "h")
        self.assertIn("CRIT b: kotu", msg)
        self.assertNotIn("iyi", msg)


class ParseTest(unittest.TestCase):
    def test_parse_ts(self):
        self.assertEqual(hc.parse_ts("2026-10-14 11:58:00+00"), datetime(2026, 10, 14, 11, 58, tzinfo=timezone.utc))
        self.assertEqual(hc.parse_ts("2026-10-14T11:58:00Z").hour, 11)
        self.assertIsNone(hc.parse_ts(""))
        self.assertIsNone(hc.parse_ts("bozuk"))


class CollectorTest(unittest.TestCase):
    def test_collect_with_fake_runner(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "env").mkdir()
            (root / "env" / "postgres.env").write_text("POSTGRES_USER=arilla\nPOSTGRES_DB=arilla\n")
            (root / "backup" / "pg").mkdir(parents=True)
            (root / "backup" / "pg" / "archive.conf").write_text("archive_mode = on\n")

            def run(cmd, timeout):
                if "ps" in cmd:
                    return 0, "\n".join(f"{s}=healthy" for s in [*hc.CORE_SERVICES, "backup"])
                if "psql" in cmd:
                    return 0, "on|12|60|0|0|67108864|0||2026-10-14 11:58:00+00\n"
                if "info" in cmd:
                    return 0, json.dumps(info(("full", timedelta(days=1))))
                if "systemctl" in cmd:
                    return 0, "arilla-healthcheck.service loaded failed failed x\narilla-backup-full.service loaded failed failed y\n"
                return 1, ""

            f = hc.Collector(root, run=run, disk_usage=lambda p: Usage(100, 50, 50)).collect()
            self.assertTrue(f["backup_configured"])
            self.assertEqual(f["pg"]["max_connections"], 60)
            self.assertEqual(f["failed_units"], ["arilla-backup-full.service"])  # kendi birimi haric
            self.assertIsNotNone(f["backup_info"])


if __name__ == "__main__":
    unittest.main()
