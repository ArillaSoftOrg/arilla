"""Gece zamanlama plani (karar 0188): takvimlerin tutarliligi ve en kotu durum zaman cizelgesi.

Ag yok, docker yok, systemd yok: python3 infra/vps/bin/test_night_schedule.py
Gercek systemd davranisi (Persistent yakalama, cift kosu, OnSuccess, ExecCondition) ayrica
test-night-schedule-units.sh ile sinanir.
"""

import re
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SYSTEMD = HERE.parent / "systemd"
REPO = HERE.parent.parent.parent
DAILY = REPO / "services" / "ingest" / "feeds" / "daily.py"
AUTO = REPO / "services" / "ingest" / "catalog_build" / "auto.py"
#: Turkiye saati: UTC+3, yaz saati yok (2016'dan beri sabit).
TR = timezone(timedelta(hours=3))
#: 14 gunluk olcum (12 Kasim): en buyuk besleme (feed 7) en fazla 75 dk surdu.
MAX_FEED_MINUTES = 75


def directives(path: Path) -> list[tuple[str, str]]:
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith(("#", "[")) or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out.append((key, value))
    return out


def calendars(name: str) -> list[str]:
    return [v for k, v in directives(SYSTEMD / name) if k == "OnCalendar"]


def hm(calendar: str) -> tuple[int, int]:
    m = re.search(r" (\d\d):(\d\d):00 UTC$", calendar)
    assert m, calendar
    return int(m.group(1)), int(m.group(2))


def minutes(calendar: str) -> int:
    h, m = hm(calendar)
    return h * 60 + m


def random_delay_min(name: str) -> int:
    value = dict(directives(SYSTEMD / name)).get("RandomizedDelaySec", "0")
    return int(value) // 60


def to_tr(hhmm: tuple[int, int]) -> str:
    utc = datetime(2026, 11, 12, *hhmm, tzinfo=timezone.utc)
    return utc.astimezone(TR).strftime("%H:%M")


class TimezoneTest(unittest.TestCase):
    def test_every_arilla_calendar_is_explicit_utc(self):
        # Sunucu saati UTC'dir ama birim yerel saate guvenmez: tasima/saat dilimi degisikligine dayanikli.
        found = 0
        for path in sorted(SYSTEMD.glob("arilla-*.timer")):
            for key, value in directives(path):
                if key == "OnCalendar" and value != "hourly":  # saat basi: saat diliminden bagimsiz
                    found += 1
                    self.assertTrue(value.endswith(" UTC"), f"{path.name}: {value}")
        self.assertGreater(found, 10)

    def test_turkey_offset_has_no_dst(self):
        try:
            from zoneinfo import ZoneInfo, ZoneInfoNotFoundError  # noqa: PLC0415
        except ImportError:  # pragma: no cover
            self.skipTest("zoneinfo yok")
        try:
            ist = ZoneInfo("Europe/Istanbul")
        except ZoneInfoNotFoundError:
            self.skipTest("tz veritabani yok")
        for month in (1, 4, 7, 11):
            self.assertEqual(datetime(2027, month, 15, 12, tzinfo=ist).utcoffset(), timedelta(hours=3))

    def test_documented_turkey_times(self):
        self.assertEqual([to_tr(hm(c)) for c in calendars("arilla-feeds-daily.timer")], ["09:30", "00:30"])
        self.assertEqual([to_tr(hm(c)) for c in calendars("arilla-catalog-auto.timer")], ["15:15", "06:00"])
        self.assertEqual([to_tr(hm(c)) for c in calendars("arilla-backup-diff.timer")], ["04:30"])
        self.assertEqual([to_tr(hm(c)) for c in calendars("arilla-catalog-pipeline.timer")], ["05:30"])


class NightPlanTest(unittest.TestCase):
    def setUp(self):
        daily = DAILY.read_text(encoding="utf-8")
        m = re.search(r"BACKUP_WINDOW_UTC = \(dt_time\((\d+), (\d+)\), dt_time\((\d+), (\d+)\)\)", daily)
        self.assertIsNotNone(m, "feeds.daily.BACKUP_WINDOW_UTC bulunamadi")
        self.window_start = int(m.group(1)) * 60 + int(m.group(2))
        self.window_end = int(m.group(3)) * 60 + int(m.group(4))
        margin = re.search(r"DEFAULT_BACKUP_MARGIN = timedelta\(minutes=(\d+)\)", daily)
        self.assertIsNotNone(margin)
        self.margin = int(margin.group(1))
        self.cutoff = self.window_start - self.margin + 24 * 60  # ertesi gun takvimi icin +24 sa

    def test_feeds_schedule_keeps_morning_and_moves_evening_to_night(self):
        self.assertEqual(calendars("arilla-feeds-daily.timer"), ["*-*-* 06:30:00 UTC", "*-*-* 21:30:00 UTC"])
        keys = dict(directives(SYSTEMD / "arilla-feeds-daily.timer"))
        self.assertEqual(keys.get("Persistent"), "true")
        self.assertLessEqual(random_delay_min("arilla-feeds-daily.timer"), 5)

    def test_catalog_safety_net_schedule(self):
        self.assertEqual(calendars("arilla-catalog-auto.timer"), ["*-*-* 12:15:00 UTC", "*-*-* 03:00:00 UTC"])
        self.assertEqual(dict(directives(SYSTEMD / "arilla-catalog-auto.timer")).get("Persistent"), "true")

    def test_backup_window_matches_backup_timers_and_catalog_line(self):
        auto = AUTO.read_text(encoding="utf-8")
        self.assertIn("BACKUP_WINDOW_UTC = (dtime(1, 20), dtime(2, 5))", auto)
        for unit in ("arilla-backup-diff.timer", "arilla-backup-full.timer"):
            start = minutes(calendars(unit)[0])
            self.assertGreaterEqual(start, self.window_start, unit)
            # Yedek 7-13 dk; rastgele gecikmeyle bile pencere icinde baslar.
            self.assertLess(start + random_delay_min(unit), self.window_end, unit)

    def test_night_feed_worst_case_ends_before_backup_window(self):
        night = minutes(calendars("arilla-feeds-daily.timer")[1])
        latest_start = night + random_delay_min("arilla-feeds-daily.timer")
        self.assertLess(latest_start, self.cutoff, "gece kosusu kesmeden once baslamali")
        # Kesmeden hemen once acilan en buyuk besleme bile yedek penceresinden once biter.
        self.assertLess(self.cutoff + MAX_FEED_MINUTES, self.window_start + 24 * 60)

    def test_night_feed_has_room_for_typical_run_and_retries(self):
        night = minutes(calendars("arilla-feeds-daily.timer")[1])
        # Tipik kosu: kesif ~20 dk + feed 14 (<=49) + feed 7 (<=75) ve en az bir yeniden deneme
        # turu (10 dk bekleme); son yeni besleme kesmeden once baslayabilmeli.
        last_feed_start = night + 5 + 20 + 49 + 10
        self.assertLessEqual(last_feed_start, self.cutoff)

    def test_morning_feed_unaffected_by_cutoff(self):
        morning = minutes(calendars("arilla-feeds-daily.timer")[0])
        budget_end = morning + 5 + 4 * 60  # 4 sa butce (karar 0162)
        self.assertLess(budget_end, self.cutoff)  # ayni gun 23:50'den once: kesme etkisiz

    def test_order_backup_then_pipeline_then_catalog_net_then_morning_feed(self):
        backup_latest_end = self.window_end
        pipeline = minutes(calendars("arilla-catalog-pipeline.timer")[0])
        net = minutes(calendars("arilla-catalog-auto.timer")[1])
        morning = minutes(calendars("arilla-feeds-daily.timer")[0])
        self.assertGreater(pipeline, backup_latest_end)
        self.assertGreater(net, pipeline + random_delay_min("arilla-catalog-pipeline.timer"))
        timeout = 150  # arilla-catalog-auto.service TimeoutStartSec=2h30min
        self.assertIn("TimeoutStartSec=2h30min", (SYSTEMD / "arilla-catalog-auto.service").read_text())
        self.assertLess(net + random_delay_min("arilla-catalog-auto.timer") + timeout, morning)

    def test_old_evening_safety_net_removed(self):
        # 21:15 gece beslemesinin (21:30) 15 dk onune duserdi ve her baslangicta durmak zorunda kalirdi.
        self.assertNotIn("*-*-* 21:15:00 UTC", calendars("arilla-catalog-auto.timer"))
        self.assertNotIn("*-*-* 18:30:00 UTC", calendars("arilla-feeds-daily.timer"))

    def test_feeds_staleness_alert_still_two_missed_runs(self):
        import arilla_healthcheck as hc  # noqa: PLC0415

        times = sorted(minutes(c) for c in calendars("arilla-feeds-daily.timer"))
        gaps = [times[1] - times[0], times[0] + 24 * 60 - times[1]]  # 15 sa ve 9 sa
        stale = hc.THRESHOLDS["feeds_run_stale_crit_s"] // 60
        # Tek kacan kosu: son kosudan sonraki kosuya iki aralik (24 sa) + 5 dk gecikme -> CRIT YOK.
        self.assertGreater(stale, sum(gaps) + 5)
        # Iki kacan kosu: en kisa durumda bile uc aralik (>= 33 sa) -> CRIT.
        self.assertLess(stale, sum(gaps) + min(gaps))


if __name__ == "__main__":
    unittest.main()
