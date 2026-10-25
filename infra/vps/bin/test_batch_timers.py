"""Toplu is zamanlayicilarinin tutarliligi (ag yok, docker yok): python3 infra/vps/bin/test_batch_timers.py"""

import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SYSTEMD = HERE.parent / "systemd"
COMPOSE = HERE.parent.parent / "compose.prod.yml"

# Zamanlanabilen ucretsiz moduller. enrich (Jina) ve feeds (buyuk indirme) bilerek yok.
# Gunluk besleme tazeleme (karar 0145) AYRI bir zamanlayicidir: `feeds-timers`, onayli etkinlestirme.
OPT_IN_UNITS = {"arilla-feeds-daily"}
ALLOWED_MODULES = {"resolve", "similarity", "pricing", "affiliate"}
RUN_PREFIX = (
    "/usr/bin/docker compose --env-file /opt/arilla/compose.env -f /opt/arilla/compose.prod.yml "
    "--profile feeds run --rm -e JOB_RUN_TRIGGER=cron feeds python -m "
)


def script_timers() -> list[str]:
    text = (HERE / "batch-timers").read_text(encoding="utf-8")
    match = re.search(r'^TIMERS="([^"]+)"', text, re.MULTILINE)
    assert match, "batch-timers icinde TIMERS yok"
    return match.group(1).split()


def directives(path: Path) -> list[tuple[str, str]]:
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith(("#", "[")) or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out.append((key, value))
    return out


class BatchTimersTest(unittest.TestCase):
    def test_script_lists_every_batch_unit(self):
        batch_units = sorted(
            p.stem
            for p in SYSTEMD.glob("arilla-*.service")
            if "run --rm" in p.read_text(encoding="utf-8")
            and " feeds python -m " in p.read_text(encoding="utf-8")
            and p.stem not in OPT_IN_UNITS
        )
        self.assertEqual(sorted(script_timers()), batch_units)

    def test_units_are_well_formed(self):
        for name in script_timers():
            service = directives(SYSTEMD / f"{name}.service")
            timer = directives(SYSTEMD / f"{name}.timer")
            keys = dict(service)
            self.assertEqual(keys.get("Type"), "oneshot", name)
            self.assertEqual(keys.get("OnFailure"), "arilla-alert@%n.service", name)
            self.assertIn("TimeoutStartSec", keys, name)
            starts = [v for k, v in service if k == "ExecStart"]
            self.assertTrue(starts, name)
            for start in starts:
                self.assertTrue(start.startswith(RUN_PREFIX), start)
                module = start[len(RUN_PREFIX) :].split()[0]
                self.assertIn(module, ALLOWED_MODULES, start)
            self.assertEqual(dict(timer).get("Persistent"), "true", name)
            self.assertIn("OnCalendar", dict(timer), name)

    def test_feeds_daily_is_opt_in_never_in_batch_timers(self):
        """Gunluk besleme zamanlayicisi `batch-timers install` ile SESSIZCE etkinlesemez."""
        self.assertNotIn("arilla-feeds-daily", script_timers())
        text = (HERE / "feeds-timers").read_text(encoding="utf-8")
        self.assertIn("--confirm", text)
        self.assertIn('UNIT=arilla-feeds-daily', text)
        self.assertIn("preflight", text)

    def test_feeds_daily_units(self):
        service = directives(SYSTEMD / "arilla-feeds-daily.service")
        timer = directives(SYSTEMD / "arilla-feeds-daily.timer")
        keys = dict(service)
        self.assertEqual(keys.get("Type"), "oneshot")
        self.assertEqual(keys.get("OnFailure"), "arilla-alert@%n.service")
        self.assertIn("TimeoutStartSec", keys)
        starts = [v for k, v in service if k == "ExecStart"]
        self.assertEqual(
            starts, [RUN_PREFIX + "feeds daily --merchant aliexpress"]
        )
        # Gunde iki tetik; Persistent: kacan kosu acilista yakalanir.
        self.assertEqual(len([v for k, v in timer if k == "OnCalendar"]), 2)
        self.assertEqual(dict(timer).get("Persistent"), "true")
        # Ornek mod / zorlama bayragi zamanlayicida OLMAZ.
        for flag in ("--force", "--max-records", "--skip-discovery"):
            self.assertNotIn(flag, starts[0])

    def test_job_run_trigger_is_known(self):
        # services/ingest/db/job_run.py TRIGGERS; bilinmeyen deger sessizce 'manual' olurdu.
        ingest = HERE.parent.parent.parent / "services" / "ingest" / "db" / "job_run.py"
        self.assertIn('"cron"', ingest.read_text(encoding="utf-8"))

    def test_feeds_service_exists_with_profile(self):
        text = COMPOSE.read_text(encoding="utf-8")
        block = text.split("\n  feeds:\n", 1)
        self.assertEqual(len(block), 2, "compose.prod.yml icinde feeds servisi yok")
        self.assertIn('profiles: ["feeds"]', block[1].split("\n  cron:\n", 1)[0])


if __name__ == "__main__":
    unittest.main()
