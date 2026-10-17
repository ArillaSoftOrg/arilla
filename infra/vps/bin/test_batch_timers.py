"""Toplu is zamanlayicilarinin tutarliligi (ag yok, docker yok): python3 infra/vps/bin/test_batch_timers.py"""

import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SYSTEMD = HERE.parent / "systemd"
COMPOSE = HERE.parent.parent / "compose.prod.yml"

# Zamanlanabilen ucretsiz moduller. enrich (Jina) ve feeds (buyuk indirme) bilerek yok.
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
            if "run --rm" in p.read_text(encoding="utf-8") and " feeds python -m " in p.read_text(encoding="utf-8")
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
