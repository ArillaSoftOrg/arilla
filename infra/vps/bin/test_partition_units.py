"""price_point bolum birimlerinin tutarliligi (ag yok, docker yok; karar 0188):
python3 infra/vps/bin/test_partition_units.py
"""

import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SYSTEMD = HERE.parent / "systemd"
SCRIPT = "node scripts/partitions.ts"
#: Yedek penceresi (UTC dk) ve gece hatti; feeds.daily / catalog_build.auto ile ayni.
BACKUP_WINDOW = (1 * 60 + 20, 2 * 60 + 5)
PIPELINE = 2 * 60 + 30
MORNING_FEED = 6 * 60 + 30


def directives(path: Path) -> list[tuple[str, str]]:
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith(("#", "[")) or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out.append((key, value))
    return out


def calendar_minutes(timer: str) -> int:
    cal = dict(directives(SYSTEMD / timer))["OnCalendar"]
    m = re.search(r" (\d\d):(\d\d):00 UTC$", cal)
    assert m, cal
    return int(m.group(1)) * 60 + int(m.group(2))


def delay_minutes(timer: str) -> int:
    return int(dict(directives(SYSTEMD / timer)).get("RandomizedDelaySec", "0")) // 60


class PartitionUnitsTest(unittest.TestCase):
    def test_creation_unit_creates_then_checks_read_only_and_alerts(self):
        d = directives(SYSTEMD / "arilla-partitions.service")
        starts = [v for k, v in d if k == "ExecStart"]
        posts = [v for k, v in d if k == "ExecStartPost"]
        self.assertEqual(len(starts), 1)
        self.assertTrue(starts[0].endswith(f"run --rm migrate {SCRIPT}"), starts[0])
        self.assertEqual(len(posts), 1)
        self.assertTrue(posts[0].endswith(f"run --rm migrate {SCRIPT} --check"), posts[0])
        self.assertEqual(dict(d).get("OnFailure"), "arilla-alert@%n.service")

    def test_check_unit_never_writes(self):
        d = directives(SYSTEMD / "arilla-partitions-check.service")
        commands = [v for k, v in d if k.startswith("Exec")]
        self.assertEqual(len(commands), 1)
        self.assertTrue(commands[0].endswith(f"{SCRIPT} --check"), commands[0])
        self.assertEqual(dict(d).get("OnFailure"), "arilla-alert@%n.service")
        ts = (HERE.parents[2] / "packages" / "db" / "scripts" / "partitions.ts").read_text(encoding="utf-8")
        self.assertIn("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY", ts)

    def test_monthly_creation_runs_after_backup_window_before_pipeline(self):
        start = calendar_minutes("arilla-partitions.timer")
        self.assertGreaterEqual(start, BACKUP_WINDOW[1])
        self.assertLess(start + delay_minutes("arilla-partitions.timer") + 5, PIPELINE)
        cal = dict(directives(SYSTEMD / "arilla-partitions.timer"))
        self.assertTrue(cal["OnCalendar"].startswith("*-*-01 "))
        self.assertEqual(cal.get("Persistent"), "true")

    def test_daily_check_before_morning_feed(self):
        start = calendar_minutes("arilla-partitions-check.timer")
        self.assertLess(start + delay_minutes("arilla-partitions-check.timer") + 2, MORNING_FEED)
        self.assertEqual(dict(directives(SYSTEMD / "arilla-partitions-check.timer")).get("Persistent"), "true")

    def test_not_installed_by_batch_installers(self):
        # Sahip kimligiyle sema degistiren is yalniz bilincli, elle kurulur (docs/ops.md).
        for installer in ("batch-timers", "feeds-timers", "catalog-auto-timers"):
            self.assertNotIn("arilla-partitions", (HERE / installer).read_text(encoding="utf-8"), installer)


if __name__ == "__main__":
    unittest.main()
