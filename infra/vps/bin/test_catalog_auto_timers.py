"""Otomatik katalog hatti birimlerinin tutarliligi (ag yok, docker yok):
python3 infra/vps/bin/test_catalog_auto_timers.py
"""

import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SYSTEMD = HERE.parent / "systemd"
INGEST = HERE.parent.parent.parent / "services" / "ingest" / "catalog_build"
RUN_PREFIX = (
    "/usr/bin/docker compose --env-file /opt/arilla/compose.env -f /opt/arilla/compose.prod.yml "
    "--profile feeds run --rm -e JOB_RUN_TRIGGER=cron "
)


def directives(path: Path) -> list[tuple[str, str]]:
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith(("#", "[")) or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out.append((key, value))
    return out


def seconds(value: str) -> int:
    total = 0
    for amount, unit in re.findall(r"(\d+)\s*(h|min|m|s)?", value):
        total += int(amount) * {"h": 3600, "min": 60, "m": 60, "s": 1, "": 1}[unit]
    return total


class CatalogAutoUnitsTest(unittest.TestCase):
    def setUp(self):
        self.service = directives(SYSTEMD / "arilla-catalog-auto.service")
        self.timer = directives(SYSTEMD / "arilla-catalog-auto.timer")
        self.keys = dict(self.service)

    def test_service_is_oneshot_with_alert_and_guard(self):
        self.assertEqual(self.keys.get("Type"), "oneshot")
        self.assertEqual(self.keys.get("OnFailure"), "arilla-alert@%n.service")
        self.assertEqual(self.keys.get("ExecCondition"), "/opt/arilla/vps/bin/catalog-auto-guard")
        self.assertIn("arilla-feeds-daily.service", dict(self.service)["After"])
        # WAL durdurmasi (3) ve mesgul (4) hata sayilmaz.
        self.assertEqual(self.keys.get("SuccessExitStatus"), "3 4")

    def test_exec_start_runs_the_auto_command_with_explicit_flags(self):
        starts = [v for k, v in self.service if k == "ExecStart"]
        self.assertEqual(len(starts), 1)
        command = starts[0]
        self.assertTrue(command.startswith(RUN_PREFIX), command)
        rest = command[len(RUN_PREFIX) :]
        self.assertIn("-e CATALOG_PUBLISH_FOREIGN_APPROVED=true feeds python -m catalog_build auto", rest)
        for flag in ("--merchant aliexpress", "--confirm", "--allow-foreign"):
            self.assertIn(flag, rest)
        # Tehlikeli / elle bayraklar zamanlayicida olmaz.
        for flag in ("--rescan", "--require-category", "--dry-run"):
            self.assertNotIn(flag, rest)

    def test_run_budget_ends_before_the_unit_timeout_and_next_writers(self):
        command = [v for k, v in self.service if k == "ExecStart"][0]
        budget = int(re.search(r"--max-seconds (\d+)", command).group(1))
        timeout = seconds(self.keys["TimeoutStartSec"])
        self.assertLess(budget, timeout)
        self.assertGreaterEqual(timeout - budget, 5 * 60)  # kapanis payi
        # Zamanlayici gecikmesiyle bile sonraki besleme tetigine (06:30/21:30) ve yedege
        # (01:30) dayanmayacak kadar kisa.
        self.assertLessEqual(timeout, 3 * 3600)

    def test_timer_is_a_safety_net_outside_other_writers(self):
        calendars = [v for k, v in self.timer if k == "OnCalendar"]
        self.assertEqual(len(calendars), 2)
        self.assertEqual(dict(self.timer).get("Persistent"), "true")
        hours = sorted(int(re.search(r" (\d\d):(\d\d)", c).group(1)) for c in calendars)
        # Karar 0188: sabah beslemesi 06:30 (+ en fazla 4,5 sa => 11:00) sonrasi 12:15; gece
        # beslemesi 21:30 (yeni besleme en gec 23:50), yedek 01:20-02:05 ve gece hatti 02:30
        # sonrasi 03:00.
        self.assertEqual(hours, [3, 12])
        timeout_min = seconds(self.keys["TimeoutStartSec"]) // 60
        # 12:15 + sinir (+ 5 dk gecikme) < 21:25 (gece beslemesi);
        # 03:00 + sinir (+ 5 dk) < 06:25 (sabah beslemesi); 03:00 > 02:05 + gece hatti 02:35.
        self.assertLess(12 * 60 + 15 + 5 + timeout_min, 21 * 60 + 25)
        self.assertLess(3 * 60 + 5 + timeout_min, 6 * 60 + 25)
        self.assertGreater(3 * 60, 2 * 60 + 35)

    def test_guard_script_skips_with_exit_one_not_failure(self):
        text = (HERE / "catalog-auto-guard").read_text(encoding="utf-8")
        for unit in (
            "arilla-feeds-daily",
            "arilla-catalog-pipeline",
            "arilla-backup-full",
            "arilla-backup-diff",
        ):
            self.assertIn(unit, text)
        self.assertIn("exit 1", text)
        self.assertTrue(text.startswith("#!/usr/bin/env bash"))

    def test_installer_is_opt_in_reversible_and_never_edits_the_feeds_unit(self):
        text = (HERE / "catalog-auto-timers").read_text(encoding="utf-8")
        self.assertIn("--confirm", text)
        self.assertIn("UNIT=arilla-catalog-auto", text)
        for command in ("preflight)", "install)", "status)", "disable)"):
            self.assertIn(command, text)
        # Besleme birimi degistirilmez: yalniz drop-in yazilir ve disable ile silinir.
        self.assertIn("DROPIN_DIR=/etc/systemd/system/arilla-feeds-daily.service.d", text)
        self.assertIn("DROPIN=$DROPIN_DIR/catalog-auto.conf", text)
        self.assertNotIn("cp ", text)  # besleme birimi kopyalanip ezilmez
        self.assertIn('rm -f "$DROPIN"', text)
        self.assertNotIn("sed -i", text)
        self.assertIn("backlog --merchant aliexpress", text)

    def test_python_job_names_and_exit_codes_match_the_unit(self):
        auto = (INGEST / "auto.py").read_text(encoding="utf-8")
        self.assertIn("EXIT_WAL_BACKPRESSURE = 3", auto)
        self.assertIn("EXIT_BUSY = 4", auto)
        main = (INGEST / "__main__.py").read_text(encoding="utf-8")
        self.assertIn('job_run.track("catalog_auto")', main)

    def test_alert_unit_exists(self):
        self.assertTrue((SYSTEMD / "arilla-alert@.service").exists())


if __name__ == "__main__":
    unittest.main()
