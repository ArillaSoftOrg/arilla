"""arilla_healthcheck.py testleri (ag yok, docker yok): python3 infra/vps/bin/test_arilla_healthcheck.py"""

import contextlib
import io
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


def verify_state(days=1, status="ok", scope="latest", reason=None):
    return {"scope": scope, "status": status, "ok": status == "ok", "reason": reason,
            "finished_at": (NOW - timedelta(days=days)).isoformat(), "duration_s": 900,
            "read_bytes_min": 35 << 30, "cpu_max_pct": 88.0, "archive_ready_max": 2}


def facts(**over):
    base = {"disk": {"/opt/arilla": 40.0}, "containers": dict(HEALTHY, backup="healthy"),
            "backup_configured": True, "pg": pg(),
            "backup_info": info(("full", timedelta(days=2)), ("diff", timedelta(hours=10))),
            "restore_test": {"ok": True, "finished_at": (NOW - timedelta(days=3)).isoformat(), "result": {"rto_s": 42}},
            "verify_latest": verify_state(days=2), "verify_all": verify_state(days=10, scope="all"),
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

    def test_verify_states(self):
        lv = lambda **o: levels(hc.evaluate(facts(**o), NOW))  # noqa: E731
        self.assertEqual(lv()["backup:verify"], hc.OK)
        self.assertEqual(lv(verify_latest=None)["backup:verify"], hc.WARN)
        self.assertEqual(lv(verify_latest=verify_state(days=9))["backup:verify"], hc.WARN)
        self.assertEqual(lv(verify_latest=verify_state(status="failed", reason="pgbackrest exit 1"))["backup:verify"], hc.CRIT)
        # Koruyucu sinirla durdurulan dogrulama bozulma DEGILDIR: uyari
        inc = verify_state(status="incomplete", reason="wal_backlog")
        self.assertEqual(lv(verify_latest=inc)["backup:verify"], hc.WARN)
        self.assertEqual(lv(verify_all=None)["backup:verify-all"], hc.WARN)
        self.assertEqual(lv(verify_all=verify_state(days=36, scope="all"))["backup:verify-all"], hc.WARN)
        self.assertEqual(lv(verify_all=verify_state(status="failed", scope="all"))["backup:verify-all"], hc.CRIT)
        # Eski bicim (op/ok) dosyasi okunmaz: "henuz yapilmadi"
        self.assertEqual(lv(verify_latest={"op": "verify", "ok": True})["backup:verify"], hc.WARN)

    def test_restore_capacity(self):
        G = 1 << 30
        ok = facts(root_free_bytes=200 * G, pg=pg(cluster_bytes=75 * G))
        lv = levels(hc.evaluate(ok, NOW))
        self.assertEqual(lv["restore-capacity"], hc.OK)
        self.assertNotIn("restore-test:partial", lv)
        # Uretim 11 Kas: 59 GB bos, 75 GB kume -> tam prova guvenli degil, acikca UYARI
        low = facts(root_free_bytes=59 * G, pg=pg(cluster_bytes=75 * G))
        checks = {c.name: c for c in hc.evaluate(low, NOW)}
        self.assertEqual(checks["restore-capacity"].level, hc.WARN)
        self.assertIn("guvenli DEGIL", checks["restore-capacity"].message)
        self.assertIn("gerekli 121 GB", checks["restore-capacity"].message)
        self.assertEqual(checks["restore-test:partial"].level, hc.WARN)  # kismi prova da yok
        # Sinir tam esik
        edge = facts(root_free_bytes=75 * G + hc.RESTORE_WAL_BUDGET_BYTES + hc.RESTORE_MIN_FREE_BYTES,
                     pg=pg(cluster_bytes=75 * G))
        self.assertEqual(levels(hc.evaluate(edge, NOW))["restore-capacity"], hc.OK)
        # Olculemiyorsa kontrol yok (yanlis guven de yanlis alarm da uretmez)
        self.assertNotIn("restore-capacity", levels(hc.evaluate(facts(), NOW)))

    def test_partial_restore_is_reported_as_partial(self):
        G = 1 << 30
        part = {"ok": True, "finished_at": (NOW - timedelta(days=3)).isoformat(), "result": {"proof": "partial"}}
        checks = {c.name: c for c in hc.evaluate(
            facts(root_free_bytes=59 * G, pg=pg(cluster_bytes=75 * G), restore_partial=part), NOW)}
        self.assertEqual(checks["restore-test:partial"].level, hc.OK)
        self.assertIn("tam kanit DEGIL", checks["restore-test:partial"].message)
        self.assertEqual(checks["restore-capacity"].level, hc.WARN)  # kismi prova bunu ORTADAN KALDIRMAZ
        bad = dict(part, ok=False, result={"error": "koruyucu sinir: max_dir"})
        lv = levels(hc.evaluate(facts(restore_partial=bad), NOW))
        self.assertEqual(lv["restore-test:partial"], hc.CRIT)
        # Kismi prova TAM provanin yerine gecmez
        lv = levels(hc.evaluate(facts(restore_test=None, restore_partial=part), NOW))
        self.assertEqual(lv["restore-test"], hc.WARN)

    def test_restore_constants_match_script(self):
        text = (Path(__file__).resolve().parent / "pg-restore-test").read_text(encoding="utf-8")
        self.assertIn("MIN_FREE=${ARILLA_RESTORE_MIN_FREE_BYTES:-$((30 * GiB))}", text)
        self.assertIn("WAL_BUDGET=${ARILLA_RESTORE_WAL_BUDGET_BYTES:-$((16 * GiB))}", text)
        self.assertEqual(hc.RESTORE_MIN_FREE_BYTES, 30 << 30)
        self.assertEqual(hc.RESTORE_WAL_BUDGET_BYTES, 16 << 30)

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
                if "psql" in cmd and "'feed_daily'" in cmd[-1]:
                    return 0, "partial|feed_7:truncated|100|40|1760400000|false|ok|1760400100\n"
                if "psql" in cmd and "from job_run" in cmd[-1]:
                    return 0, "resolve|1760400000\nsimilarity_edges|1760400100\n"
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
            self.assertEqual(f["pipeline_failures"], {})
            self.assertEqual(set(f["pipeline_last_ran"]), {"resolve", "similarity_edges"})
            self.assertEqual(f["feeds_recent"][0]["status"], "partial")
            self.assertEqual(f["feeds_recent"][0]["offers_fresh"], 40)


# ------------------------------------------------------------- katalog hatti (karar 0174, PR1c)
UNIT = "arilla-catalog-pipeline.service"
SINCE = datetime(2026, 11, 9, 2, 33, 1, tzinfo=timezone.utc)


def row(job, outcome, started, status="partial", reason=None):
    return {"job": job, "status": status, "outcome": outcome, "reason": reason, "started": started}


TONIGHT = SINCE + timedelta(seconds=20)
LAST_NIGHT = SINCE - timedelta(days=1)


class PipelineClassifyTest(unittest.TestCase):
    def classify(self, exec_status, rows, since=SINCE):
        return hc.classify_pipeline_failure(exec_status, since, rows)

    def test_single_lock_skip_is_info(self):
        rows = [row("resolve", "skipped_locked", TONIGHT, reason="lock_busy"),
                row("resolve", "no_input", LAST_NIGHT, status="success")]
        level, msg = self.classify(75, rows)
        self.assertEqual(level, hc.INFO)
        self.assertIn("resolve=skipped_locked (lock_busy)", msg)

    def test_similarity_lock_skip_after_resolve_ran_is_info(self):
        rows = [row("similarity_edges", "skipped_locked", TONIGHT + timedelta(minutes=3), reason="lock_busy"),
                row("resolve", "completed", TONIGHT, status="success"),
                row("similarity_edges", "blocked_upstream", LAST_NIGHT)]
        self.assertEqual(self.classify(75, rows)[0], hc.INFO)

    def test_second_consecutive_lock_skip_is_crit(self):
        rows = [row("resolve", "skipped_locked", TONIGHT), row("resolve", "skipped_locked", LAST_NIGHT)]
        level, msg = self.classify(75, rows)
        self.assertEqual(level, hc.CRIT)
        self.assertIn("art arda", msg)

    def test_exit_75_without_matching_outcome_is_crit(self):
        self.assertEqual(self.classify(75, [row("resolve", "failed", TONIGHT, status="failed")])[0], hc.CRIT)
        # skipped_locked ama cikis 1: kod/sozlesme uyusmazligi, susturulmaz
        self.assertEqual(self.classify(1, [row("resolve", "skipped_locked", TONIGHT)])[0], hc.CRIT)

    def test_errors_and_failures_are_crit(self):
        for outcome in ("partial", "failed", "invalid_outcome"):
            with self.subTest(outcome=outcome):
                level, msg = self.classify(1, [row("resolve", outcome, TONIGHT)])
                self.assertEqual(level, hc.CRIT)
                self.assertIn(f"resolve={outcome}", msg)

    def test_no_row_for_this_invocation_is_crit(self):
        level, msg = self.classify(75, [row("resolve", "skipped_locked", LAST_NIGHT)])
        self.assertEqual(level, hc.CRIT)
        self.assertIn("kaydi yok", msg)
        self.assertEqual(self.classify(1, [])[0], hc.CRIT)

    def test_legacy_row_without_outcome_is_crit(self):
        level, msg = self.classify(1, [row("resolve", None, TONIGHT, status="partial")])
        self.assertEqual(level, hc.CRIT)
        self.assertIn("status=partial", msg)

    def test_step_failed_before_writing_a_row(self):
        level, msg = self.classify(1, [row("resolve", "completed", TONIGHT, status="success")])
        self.assertEqual(level, hc.CRIT)
        self.assertIn("kayit acmadan", msg)

    def test_unreadable_state_fails_closed(self):
        self.assertEqual(self.classify(None, [])[0], hc.CRIT)
        self.assertEqual(self.classify(75, [], since=None)[0], hc.CRIT)
        self.assertEqual(self.classify(75, None)[0], hc.CRIT)

    def test_info_does_not_raise_overall_level_or_fingerprint(self):
        checks = hc.evaluate(facts(failed_units=[UNIT], pipeline_failures={UNIT: (hc.INFO, "atlandi")}), NOW)
        lv = levels(checks)
        self.assertEqual(lv["systemd"], hc.OK)
        self.assertEqual(lv[f"systemd:{UNIT}"], hc.INFO)
        self.assertEqual(hc.overall(checks), hc.OK)
        self.assertEqual(hc.fingerprint(checks), "")
        self.assertIsNone(hc.decide_webhook(None, checks, NOW))  # hatirlatma yok

    def test_crit_classification_alerts(self):
        checks = hc.evaluate(facts(failed_units=[UNIT, "arilla-backup-diff.service"],
                                   pipeline_failures={UNIT: (hc.CRIT, "resolve=failed")}), NOW)
        lv = levels(checks)
        self.assertEqual(lv["systemd"], hc.CRIT)  # siniflandirilmayan birim aynen kritik
        self.assertEqual(lv[f"systemd:{UNIT}"], hc.CRIT)
        self.assertIn(f"systemd:{UNIT}:crit", hc.fingerprint(checks))


class PipelineFreshnessTest(unittest.TestCase):
    def level(self, last_ran):
        return levels(hc.evaluate(facts(pipeline_last_ran=last_ran), NOW))["pipeline:freshness"]

    def test_thresholds(self):
        fresh = {"resolve": NOW - timedelta(hours=49), "similarity_edges": NOW - timedelta(hours=2)}
        self.assertEqual(self.level(fresh), hc.OK)
        stale = dict(fresh, resolve=NOW - timedelta(hours=51))
        self.assertEqual(self.level(stale), hc.CRIT)

    def test_missing_and_unreadable(self):
        self.assertEqual(self.level({"resolve": None, "similarity_edges": NOW}), hc.WARN)
        self.assertEqual(self.level(None), hc.CRIT)

    def test_sql_counts_blocked_upstream_as_ran(self):
        self.assertIn("'blocked_upstream'", hc.PIPELINE_LAST_RAN_SQL)
        self.assertNotIn("'skipped_locked'", hc.PIPELINE_LAST_RAN_SQL)
        self.assertNotIn("'failed'", hc.PIPELINE_LAST_RAN_SQL)

    def test_sql_jobs_rejects_non_constant_names(self):
        self.assertEqual(hc.sql_jobs(("resolve", "similarity_edges")), "'resolve', 'similarity_edges'")
        with self.assertRaises(ValueError):
            hc.sql_jobs(("resolve'; drop table x; --",))


class UnitShowTest(unittest.TestCase):
    def test_parse(self):
        out = "ExecMainStatus=75\nInactiveExitTimestamp=Mon 2026-11-09 02:33:01 UTC\n"
        self.assertEqual(hc.parse_unit_show(out), (75, SINCE))

    def test_parse_missing_or_local_time(self):
        self.assertEqual(hc.parse_unit_show("ExecMainStatus=0\nInactiveExitTimestamp=\n"), (0, None))
        self.assertEqual(hc.parse_unit_show("ExecMainStatus=1\nInactiveExitTimestamp=Mon 2026-11-09 05:33:01 +03\n"),
                         (1, None))
        self.assertEqual(hc.parse_unit_show(""), (None, None))


class UnitFailedMessageTest(unittest.TestCase):
    def collector(self, show, psql_out, psql_rc=0):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)

        def run(cmd, timeout):
            if cmd[:2] == ["systemctl", "show"]:
                return 0, show
            if "psql" in cmd:
                return psql_rc, psql_out
            return 1, ""

        return hc.Collector(root, run=run)

    def test_info_message(self):
        c = self.collector("ExecMainStatus=75\nInactiveExitTimestamp=Mon 2026-11-09 02:33:01 UTC\n",
                           f"resolve|partial|skipped_locked|lock_busy|{int(TONIGHT.timestamp())}\n")
        level, text, _send = hc.unit_failed_message(UNIT, "h", c)
        self.assertEqual(level, hc.INFO)
        self.assertTrue(text.startswith("[ManiCepte h] BILGI"))

    def test_query_failure_is_crit(self):
        c = self.collector("ExecMainStatus=75\nInactiveExitTimestamp=Mon 2026-11-09 02:33:01 UTC\n", "", psql_rc=1)
        level, text, _send = hc.unit_failed_message(UNIT, "h", c)
        self.assertEqual(level, hc.CRIT)
        self.assertTrue(text.startswith("[ManiCepte h] SORUN"))

    def test_other_units_unchanged(self):
        level, text, _send = hc.unit_failed_message("arilla-backup-diff.service", "h", None)
        self.assertEqual(level, hc.CRIT)
        self.assertIn("CRIT systemd: arilla-backup-diff.service basarisiz", text)

    def test_no_send_sends_nothing(self):
        sent = []
        orig_post, orig_ping, orig_msg = hc.post_json, hc.ping, hc.unit_failed_message
        orig_state = hc.Collector.unit_active_state
        hc.post_json = lambda *a, **k: sent.append("post") or True
        hc.ping = lambda *a, **k: sent.append("ping") or True
        hc.unit_failed_message = lambda unit, host, collector: (hc.CRIT, "x", True)
        hc.Collector.unit_active_state = lambda self, unit: "failed"
        try:
            with tempfile.TemporaryDirectory() as d:
                (Path(d) / "env").mkdir()
                (Path(d) / "env" / "alert.env").write_text("ALERT_WEBHOOK_URL=https://x\nHEALTHCHECK_PING_URL=https://y\n")
                self.assertEqual(hc.main(["--root", d, "--unit-failed", UNIT, "--no-send"]), 0)
                self.assertEqual(sent, [])
                hc.unit_failed_message = lambda unit, host, collector: (hc.INFO, "x", True)
                hc.main(["--root", d, "--unit-failed", UNIT])
                self.assertEqual(sent, ["post"])  # BILGI: webhook evet, olu adam /fail hayir
        finally:
            hc.post_json, hc.ping, hc.unit_failed_message = orig_post, orig_ping, orig_msg
            hc.Collector.unit_active_state = orig_state

    def run_no_send(self, state):
        """--no-send teshisi; (cikis kodu, cikti, siniflandirma cagrildi mi)."""
        called = []
        orig_msg, orig_state = hc.unit_failed_message, hc.Collector.unit_active_state
        hc.unit_failed_message = lambda unit, host, collector: called.append(unit) or (hc.CRIT, "SINIF", True)
        hc.Collector.unit_active_state = lambda self, unit: state
        out = io.StringIO()
        try:
            with tempfile.TemporaryDirectory() as d, contextlib.redirect_stdout(out):
                rc = hc.main(["--root", d, "--unit-failed", UNIT, "--no-send"])
        finally:
            hc.unit_failed_message, hc.Collector.unit_active_state = orig_msg, orig_state
        return rc, out.getvalue(), bool(called)

    def test_no_send_healthy_unit_is_not_a_problem(self):
        rc, out, classified = self.run_no_send("inactive")
        self.assertEqual(rc, 0)
        self.assertFalse(classified)
        self.assertIn("TESHIS", out)
        self.assertIn("basarisiz degil (ActiveState=inactive)", out)
        self.assertNotIn("SORUN", out)

    def test_no_send_failed_or_unknown_state_classifies(self):
        for state in ("failed", None):
            rc, out, classified = self.run_no_send(state)
            self.assertTrue(classified, state)
            self.assertIn("SINIF", out)

    def test_unit_active_state_parsing(self):
        c = hc.Collector(Path("."), run=lambda cmd, t: (0, "failed\n"))
        self.assertEqual(c.unit_active_state(UNIT), "failed")
        self.assertIsNone(hc.Collector(Path("."), run=lambda cmd, t: (1, "")).unit_active_state(UNIT))
        self.assertIsNone(hc.Collector(Path("."), run=lambda cmd, t: (0, "\n")).unit_active_state(UNIT))


# ------------------------------------------------------------- gunluk besleme (karar 0182)
FEEDS_UNIT = "arilla-feeds-daily.service"
FSINCE = datetime(2026, 11, 10, 18, 31, 47, tzinfo=timezone.utc)
FNOW = FSINCE + timedelta(hours=2, minutes=35)


def frow(started, status="partial", problems="feed_7:truncated; feed_7:behind", active=12_935_843,
         fresh=5_237_074, last_success=None, fx_stale=False, discovery="ok"):
    return {"status": status, "problems": problems, "offers_active": active, "offers_fresh": fresh,
            "last_success": last_success if last_success is not None else started + timedelta(hours=1),
            "fx_stale": fx_stale, "discovery": discovery, "started": started}


CUR = FSINCE + timedelta(seconds=2)
PREV = FSINCE - timedelta(hours=12)


class FeedsClassifyTest(unittest.TestCase):
    def lvl(self, rows, exec_status=1, since=FSINCE, now=FNOW):
        return hc.classify_feeds_failure(exec_status, since, rows, now)

    def test_source_side_partial_with_fresh_prices_is_info(self):
        level, msg = self.lvl([frow(CUR), frow(PREV)])
        self.assertEqual(level, hc.INFO, msg)
        self.assertIn("feed_7:truncated", msg)

    def test_production_nov_8_zero_fresh_is_crit(self):
        level, msg = self.lvl([frow(CUR, fresh=0, problems="feed_14:too_few_records; feed_7:behind")])
        self.assertEqual(level, hc.CRIT)
        self.assertIn("taze teklif %0", msg)

    def test_ratio_threshold(self):
        self.assertEqual(self.lvl([frow(CUR, active=100, fresh=25)])[0], hc.INFO)
        self.assertEqual(self.lvl([frow(CUR, active=100, fresh=24)])[0], hc.CRIT)

    def test_old_last_success_is_crit(self):
        old = FNOW - timedelta(hours=37)
        self.assertEqual(self.lvl([frow(CUR, last_success=old)])[0], hc.CRIT)
        ok = FNOW - timedelta(hours=35)
        self.assertEqual(self.lvl([frow(CUR, last_success=ok)])[0], hc.INFO)

    def test_crit_cases(self):
        cases = {
            "failed": frow(CUR, status="failed"),
            "fx": frow(CUR, fx_stale=True, problems="feed_7:behind; fx_stale"),
            "fx_flag_only": frow(CUR, fx_stale=True),
            "discovery": frow(CUR, discovery="failed", problems="discovery_failed:admitad"),
            "gone": frow(CUR, problems="feed_7:behind; feeds_gone"),
            "no_problems": frow(CUR, problems=None),
            "no_ratio": frow(CUR, active=None),
            "zero_active": frow(CUR, active=0),
            "running": frow(CUR, status="running"),
        }
        for name, r in cases.items():
            self.assertEqual(self.lvl([r])[0], hc.CRIT, name)

    def test_unreadable_is_crit(self):
        self.assertEqual(self.lvl(None)[0], hc.CRIT)
        self.assertEqual(self.lvl([frow(CUR)], exec_status=None)[0], hc.CRIT)
        self.assertEqual(self.lvl([frow(CUR)], since=None)[0], hc.CRIT)

    def test_no_row_for_this_invocation_is_crit(self):
        level, msg = self.lvl([frow(PREV)])
        self.assertEqual(level, hc.CRIT)
        self.assertIn("bu kosuya ait", msg)

    def test_unexpected_exit_code_is_crit(self):
        self.assertEqual(self.lvl([frow(CUR)], exec_status=2)[0], hc.CRIT)

    def test_feed_level_only(self):
        self.assertTrue(hc.feed_level_only("feed_14:too_few_records; feed_7:behind"))
        for bad in ("", None, "fx_stale", "feed_7", "feed_x:behind", "feeds_gone", "feed_7:behind; fx_stale"):
            self.assertFalse(hc.feed_level_only(bad), bad)

    def test_repeat(self):
        self.assertTrue(hc.feeds_info_repeats(FSINCE, [frow(CUR), frow(PREV)], FNOW))
        changed = frow(PREV, problems="feed_14:too_few_records")
        self.assertFalse(hc.feeds_info_repeats(FSINCE, [frow(CUR), changed], FNOW))
        crit_prev = frow(PREV, fresh=0)
        self.assertFalse(hc.feeds_info_repeats(FSINCE, [frow(CUR), crit_prev], FNOW))
        self.assertFalse(hc.feeds_info_repeats(FSINCE, [frow(CUR)], FNOW))
        self.assertFalse(hc.feeds_info_repeats(FSINCE, None, FNOW))


class FeedsFreshnessTest(unittest.TestCase):
    def check(self, feeds, now=FNOW):
        f = facts()
        f["feeds_recent"] = feeds
        return {c.name: c for c in hc.evaluate(f, now)}.get("feeds:freshness")

    def test_recent_run_ok(self):
        self.assertEqual(self.check([frow(CUR)]).level, hc.OK)

    def test_stale_run_crit(self):
        self.assertEqual(self.check([frow(CUR)], now=CUR + timedelta(hours=31)).level, hc.CRIT)

    def test_unreadable_crit_and_absent_skipped(self):
        self.assertEqual(self.check(None).level, hc.CRIT)
        self.assertIsNone(self.check([]))

    def test_info_unit_not_in_generic_systemd(self):
        f = facts()
        f["failed_units"] = [FEEDS_UNIT]
        f["pipeline_failures"] = {FEEDS_UNIT: (hc.INFO, "x")}
        checks = {c.name: c for c in hc.evaluate(f, FNOW)}
        self.assertEqual(checks["systemd"].level, hc.OK)
        self.assertEqual(checks[f"systemd:{FEEDS_UNIT}"].level, hc.INFO)
        self.assertEqual(hc.overall(list(checks.values())), hc.overall(
            [c for n, c in checks.items() if n != f"systemd:{FEEDS_UNIT}"]))


class FeedsUnitFailedTest(unittest.TestCase):
    def collector(self, psql_out, psql_rc=0):
        show = "ExecMainStatus=1\nInactiveExitTimestamp=Tue 2026-11-10 18:31:47 UTC\n"

        def run(cmd, timeout):
            if cmd[:2] == ["systemctl", "show"]:
                return 0, show
            if "psql" in cmd:
                return psql_rc, psql_out
            return 1, ""

        return hc.Collector(Path("."), run=run)

    @staticmethod
    def line(started, problems="feed_7:truncated; feed_7:behind", fresh=5237074):
        last = int((started + timedelta(hours=1)).timestamp())
        return f"partial|{problems}|12935843|{fresh}|{last}|false|ok|{int(started.timestamp())}"

    def at_fnow(self, c):
        """Sabit saat: siniflandirma `FNOW`'a gore yapilir."""
        c.classify_unit = lambda unit, now=None: hc.Collector.classify_unit(c, unit, FNOW)
        c.feeds_repeat = lambda unit, now=None: hc.Collector.feeds_repeat(c, unit, FNOW)
        return c

    def test_first_info_is_sent(self):
        c = self.at_fnow(self.collector(self.line(CUR) + "\n"))
        level, text, send = hc.unit_failed_message(FEEDS_UNIT, "h", c)
        self.assertEqual(level, hc.INFO, text)
        self.assertTrue(send)

    def test_repeat_info_not_sent(self):
        c = self.at_fnow(self.collector(self.line(CUR) + "\n" + self.line(PREV) + "\n"))
        level, text, send = hc.unit_failed_message(FEEDS_UNIT, "h", c)
        self.assertEqual(level, hc.INFO)
        self.assertFalse(send)
        self.assertTrue(text.startswith("[ManiCepte h] BILGI"))
        self.assertIn("tekrar gonderilmedi", text)

    def test_changed_problems_sent(self):
        c = self.at_fnow(self.collector(self.line(CUR) + "\n" + self.line(PREV, problems="feed_14:behind") + "\n"))
        level, _text, send = hc.unit_failed_message(FEEDS_UNIT, "h", c)
        self.assertEqual(level, hc.INFO)
        self.assertTrue(send)

    def test_query_failure_crit_and_sent(self):
        level, text, send = hc.unit_failed_message(FEEDS_UNIT, "h", self.collector("", psql_rc=1))
        self.assertEqual(level, hc.CRIT)
        self.assertTrue(send)
        self.assertTrue(text.startswith("[ManiCepte h] SORUN"))

    def test_bad_row_is_unreadable(self):
        c = self.collector("partial|x|abc|1|2|false|ok|123\n")
        self.assertIsNone(c.feeds_recent())
        self.assertIsNone(self.collector("partial|x\n").feeds_recent())

    def test_main_suppresses_repeat_webhook_but_no_fail_ping(self):
        sent = []
        orig_post, orig_ping, orig_msg = hc.post_json, hc.ping, hc.unit_failed_message
        hc.post_json = lambda *a, **k: sent.append("post") or True
        hc.ping = lambda *a, **k: sent.append("ping") or True
        hc.unit_failed_message = lambda unit, host, collector: (hc.INFO, "x", False)
        try:
            with tempfile.TemporaryDirectory() as d:
                (Path(d) / "env").mkdir()
                (Path(d) / "env" / "alert.env").write_text("ALERT_WEBHOOK_URL=https://x\nHEALTHCHECK_PING_URL=https://y\n")
                with contextlib.redirect_stdout(io.StringIO()):
                    hc.main(["--root", d, "--unit-failed", FEEDS_UNIT])
                self.assertEqual(sent, [])
        finally:
            hc.post_json, hc.ping, hc.unit_failed_message = orig_post, orig_ping, orig_msg


if __name__ == "__main__":
    unittest.main()
