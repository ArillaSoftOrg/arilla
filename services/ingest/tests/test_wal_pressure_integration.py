"""WAL geri basinci (karar 0134): GERCEK arsivleyen PostgreSQL ile.

`WAL_LAB_DATABASE_URL` (superuser) arsivi ACIK, `archive_command`'i denetlenebilir bir
laboratuvar sunucusunu gostermelidir; yoksa testler atlanir. Kurulum ve calistirma:
`infra/vps/bin/test-wal-backpressure.sh` (yerel Docker). Laboratuvar komutu:

    archive_command = 'sh -c ''d=$(cat /tmp/archive_delay 2>/dev/null || echo 0); sleep $d;
                       test ! -f /tmp/archive_fail && cp %p /archive/%f'''

Gecikme ve hata, superuser `COPY ... TO PROGRAM` ile acilip kapatilir.
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterator

import psycopg
import pytest
from test_catalog_build import POLICY, SLUG, _app, add_offer, world  # noqa: F401 - fikstur

from catalog_build import __main__ as cli
from catalog_build import build as build_mod
from catalog_build import gate as gate_mod
from catalog_build import publish as publish_mod
from db.wal_pressure import MIB, WalGovernor, WalPolicy, read_sample

pytestmark = pytest.mark.integration

LAB_URL = os.environ.get("WAL_LAB_DATABASE_URL")

CLASSIFY = """
WITH s AS (SELECT setting::bigint AS seg FROM pg_settings WHERE name = 'wal_segment_size'),
lsn AS (SELECT floor((pg_current_wal_insert_lsn() - '0/0'::pg_lsn) / s.seg) AS cur,
               floor(((SELECT redo_lsn FROM pg_control_checkpoint()) - '0/0'::pg_lsn) / s.seg)
                 AS redo,
               s.seg FROM s),
st AS (SELECT left(name, 24) AS name, bool_or(name LIKE '%.ready') AS ready
         FROM pg_ls_archive_statusdir() GROUP BY 1),
f AS (SELECT w.size, st.ready,
             ('x' || substr(w.name, 9, 8))::bit(32)::bigint * (4294967296 / lsn.seg)
             + ('x' || substr(w.name, 17, 8))::bit(32)::bigint AS segno
        FROM pg_ls_waldir() w LEFT JOIN st USING (name), lsn
       WHERE w.name ~ '^[0-9A-F]{24}$')
SELECT sum(size),
       coalesce(sum(size) FILTER (WHERE segno > lsn.cur), 0),
       coalesce(sum(size) FILTER (WHERE segno < lsn.redo AND NOT coalesce(ready, false)), 0),
       coalesce(sum(size) FILTER (WHERE ready), 0)
  FROM f, lsn GROUP BY lsn.cur, lsn.redo
"""


@pytest.fixture
def lab() -> Iterator[psycopg.Connection]:
    if not LAB_URL:
        pytest.skip("WAL_LAB_DATABASE_URL yok (arsivleyen laboratuvar sunucusu)")
    try:
        conn = psycopg.connect(LAB_URL, autocommit=True)
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"laboratuvar sunucusu yok: {error}")
    with conn:
        if conn.execute("SHOW archive_mode").fetchone() != ("on",):
            pytest.skip("laboratuvarda archive_mode=on degil")
        set_archive(conn, delay_s=0, fail=False)
        conn.execute("CREATE TABLE IF NOT EXISTS wal_lab_load (id bigserial PRIMARY KEY, v text)")
        drain(conn)
        yield conn
        set_archive(conn, delay_s=0, fail=False)
        conn.execute("TRUNCATE wal_lab_load")
        drain(conn)


def set_archive(conn: psycopg.Connection, *, delay_s: float, fail: bool) -> None:
    conn.execute(f"COPY (SELECT 1 WHERE false) TO PROGRAM 'echo {delay_s} > /tmp/archive_delay'")
    action = "touch /tmp/archive_fail" if fail else "rm -f /tmp/archive_fail"
    conn.execute(f"COPY (SELECT 1 WHERE false) TO PROGRAM '{action}'")


def write_wal(conn: psycopg.Connection, mb: int) -> None:
    """Yaklasik `mb` MB WAL (yayin partisi gibi tek islemde satir + indeks yazimi)."""
    conn.execute(
        "INSERT INTO wal_lab_load (v) SELECT repeat(md5(random()::text), 8) "
        "FROM generate_series(1, %s)",
        (mb * 3000,),
    )


def lag_bytes(conn: psycopg.Connection) -> int:
    s = read_sample(conn) if not conn.autocommit else _sample_autocommit(conn)
    assert s.lag_bytes is not None
    return s.lag_bytes


def _sample_autocommit(conn: psycopg.Connection):
    conn.autocommit = False
    try:
        return read_sample(conn)
    finally:
        conn.autocommit = True


def drain(conn: psycopg.Connection, timeout_s: float = 120) -> None:
    """Acik segmenti kapatir ve arsivin yetismesini bekler."""
    conn.execute("SELECT pg_switch_wal()")
    end = time.monotonic() + timeout_s
    while time.monotonic() < end:
        ready = conn.execute(
            "SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready'"
        ).fetchone()
        failing = conn.execute(
            "SELECT coalesce(last_failed_time > last_archived_time, false) FROM pg_stat_archiver"
        ).fetchone()
        if ready == (0,) and failing == (False,):
            return
        time.sleep(0.5)
    raise AssertionError("arsiv laboratuvarda bosalmadi")


def app_conn(lab: psycopg.Connection) -> psycopg.Connection:
    """Olcu baglantisi: UYGULAMA rolu (superuser degil) - uretimdeki `arilla_app` gibi."""
    url = os.environ.get("DATABASE_URL")
    if url:
        try:
            conn = psycopg.connect(url)
        except psycopg.OperationalError:
            conn = None
        if conn is not None:
            same = conn.execute("SELECT system_identifier FROM pg_control_system()").fetchone()
            conn.commit()
            if same == lab.execute("SELECT system_identifier FROM pg_control_system()").fetchone():
                return conn
            conn.close()
    pytest.skip("DATABASE_URL laboratuvar sunucusundaki uygulama rolunu gostermiyor")


def test_sample_works_without_superuser(lab: psycopg.Connection) -> None:
    with app_conn(lab) as conn:
        assert conn.execute(
            "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"
        ).fetchone() == (False,)
        conn.commit()
        s = read_sample(conn)
    assert s.archive_mode == "on"
    assert s.archived_upto is not None and s.lag_bytes is not None
    assert s.lag_bytes < 2 * s.seg_size
    assert not s.archive_failing


def test_slow_archive_is_paced_and_lag_stays_bounded(lab: psycopg.Connection) -> None:
    """Disk hizindan bagimsiz: once arsiv durdurulup hedef ile duraklama arasinda birikim kurulur,
    sonra arsiv yazimdan kesinlikle yavas (segment basina 4 sn ~ 4 MB/sn) acilir."""
    policy = WalPolicy(
        target_bytes=48 * MIB,
        pause_bytes=128 * MIB,
        resume_bytes=24 * MIB,
        max_sleep_s=5,
        max_pause_s=300,
        poll_s=0.5,
        rate_window_s=30,
    )
    set_archive(lab, delay_s=0, fail=True)
    write_wal(lab, 72)
    lab.execute("SELECT pg_switch_wal()")
    set_archive(lab, delay_s=4, fail=False)
    with app_conn(lab) as conn:
        gov = WalGovernor.for_connection(conn, policy)
        worst = 0
        started = time.monotonic()
        for _ in range(12):
            assert gov.before_batch()
            write_wal(lab, 8)
            worst = max(worst, lag_bytes(lab))
        elapsed = time.monotonic() - started
    assert gov.stopped_reason is None
    # Hedefin ustunde yavaslatma devreye girer; gecikme duraklama sinirinin altinda kalir
    # (bir parti + acik segment payi).
    assert gov.stats.paced_sleeps > 0, gov.stats
    assert worst < policy.pause_bytes + 8 * MIB + 32 * MIB, worst // MIB
    assert elapsed < 300


def test_resume_does_not_need_checkpoint(lab: psycopg.Connection) -> None:
    """Kok neden regresyonu: yuk sonrasi arsiv bosalinca pg_wal hala buyuktur (geri
    donusturulmus + checkpoint'te silinecek segmentler). Yonetici CHECKPOINT beklemeden
    tam hizla devam eder."""
    lab.execute("CHECKPOINT")
    for _ in range(12):
        write_wal(lab, 16)
    drain(lab)
    total, recycled, removable, ready = lab.execute(CLASSIFY).fetchone()
    assert ready == 0
    assert recycled + removable > 0, "dizinde arsiv borcu olmayan WAL olmali"
    with app_conn(lab) as conn:
        gov = WalGovernor.for_connection(
            conn, WalPolicy(target_bytes=48 * MIB, pause_bytes=96 * MIB, resume_bytes=24 * MIB)
        )
        t0 = time.monotonic()
        assert gov.before_batch()
        write_wal(lab, 4)
        assert gov.before_batch()
        assert time.monotonic() - t0 < 30  # yalniz takilma korumasi; asil olcu istatistik
    assert gov.stats.pauses == 0 and gov.stats.paced_sleeps == 0, (
        gov.stats,
        total,
        recycled,
        removable,
    )
    # Eski bekci olcusu (pg_wal toplami) burada yuksek kalir: yonetici onu kullanmaz.
    assert total > ready


def test_archive_failure_blocks_then_stops_after_grace(lab: psycopg.Connection) -> None:
    set_archive(lab, delay_s=0, fail=True)
    write_wal(lab, 2)
    lab.execute("SELECT pg_switch_wal()")
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if lab.execute(
            "SELECT coalesce(last_failed_time > last_archived_time, false) FROM pg_stat_archiver"
        ).fetchone() == (True,):
            break
        time.sleep(0.5)
    else:
        pytest.fail("laboratuvar arsiv hatasini gostermedi")
    policy = WalPolicy(
        target_bytes=48 * MIB,
        pause_bytes=96 * MIB,
        resume_bytes=24 * MIB,
        failing_grace_s=4,
        poll_s=0.5,
    )
    with app_conn(lab) as conn:
        gov = WalGovernor.for_connection(conn, policy)
        t0 = time.monotonic()
        assert not gov.before_batch()
        assert 4 <= time.monotonic() - t0 < 10
    assert gov.stopped_reason is not None and "basarisiz" in gov.stopped_reason
    # Duzelince yeni kosu yazabilir.
    set_archive(lab, delay_s=0, fail=False)
    drain(lab)
    with app_conn(lab) as conn:
        assert WalGovernor.for_connection(conn, policy).before_batch()


def test_stop_request_during_failure_wait_is_prompt(lab: psycopg.Connection) -> None:
    set_archive(lab, delay_s=0, fail=True)
    write_wal(lab, 2)
    lab.execute("SELECT pg_switch_wal()")
    time.sleep(2)
    stop_at = time.monotonic() + 1.5
    with app_conn(lab) as conn:
        gov = WalGovernor.for_connection(
            conn,
            WalPolicy(failing_grace_s=600, poll_s=0.5),
            should_stop=lambda: time.monotonic() >= stop_at,
        )
        assert not gov.before_batch()
    assert time.monotonic() - stop_at < 1.5
    assert gov.stopped_reason is None


# --- uctan uca: catalog_build publish (CLI giris noktasi, ayni surec) ------------------------
# test_catalog_build dunyasi (kendi magazasi + politikasi; gercek AliExpress kaydina dokunmaz).


def _same_server(lab: psycopg.Connection) -> None:
    with _app() as conn:
        mine = conn.execute("SELECT system_identifier FROM pg_control_system()").fetchone()
    if mine != lab.execute("SELECT system_identifier FROM pg_control_system()").fetchone():
        pytest.skip("DATABASE_URL laboratuvar sunucusunda degil")


def _states(merchant_id: int) -> dict[str, int]:
    with _app() as c:
        rows = c.execute(
            "SELECT publication_state, count(*) FROM product WHERE source_merchant_id = %s"
            " GROUP BY 1",
            (merchant_id,),
        ).fetchall()
    return {str(s): int(n) for s, n in rows}


@pytest.fixture
def ready_world(lab, world, monkeypatch) -> int:  # noqa: F811
    _same_server(lab)
    m = world[SLUG]
    with psycopg.connect(os.environ["DATABASE_URL_OWNER"]) as owner, owner.cursor() as cur:
        for n in range(1, 41):
            add_offer(cur, m, n)
    with _app() as conn:
        build_mod.build_source_products(conn, merchant_slug=SLUG, policy=POLICY)
        gate_mod.run_gate(conn, allow_foreign=True)
    monkeypatch.setitem(publish_mod.POLICIES, SLUG, POLICY)
    monkeypatch.setenv(publish_mod.FOREIGN_APPROVAL_ENV, "true")
    monkeypatch.setattr(cli, "_stop", False)
    assert _states(m) == {"ready": 40}
    return m


def _publish(*extra: str) -> int:
    return cli.main(
        ["publish", "--limit", "100000", "--confirm", "--merchant", SLUG, "--allow-foreign", *extra]
    )


def _last_publish_run() -> tuple[str, str | None, dict]:
    with _app() as c:
        row = c.execute(
            "SELECT status, error_summary, detail FROM job_run WHERE job = 'catalog_publish'"
            " ORDER BY id DESC LIMIT 1"
        ).fetchone()
    assert row is not None
    return str(row[0]), row[1], dict(row[2] or {})


def test_publish_exits_3_on_archive_failure_and_resumes(lab, ready_world) -> None:
    set_archive(lab, delay_s=0, fail=True)
    write_wal(lab, 2)
    lab.execute("SELECT pg_switch_wal()")
    time.sleep(2)
    assert _publish("--wal-failing-grace-s", "3") == cli.EXIT_WAL_BACKPRESSURE
    assert _states(ready_world) == {"ready": 40}, "arsiv basarisizken hicbir sey yazilmaz"
    status, summary, detail = _last_publish_run()
    assert status == "partial" and summary is not None and "WAL" in summary
    assert detail["wal_archive_failing_s"] >= 3

    set_archive(lab, delay_s=0, fail=False)
    drain(lab)
    assert _publish() == 0
    assert _states(ready_world) == {"published": 40}
    status, _, detail = _last_publish_run()
    assert status == "success" and detail["wal_pauses"] == 0


def test_publish_sigterm_mid_run_then_resume_without_duplicates(
    lab, ready_world, monkeypatch
) -> None:
    """SIGTERM isleyicisi (`_request_stop`) 3. parti oncesi gelir: tamamlanan 2 parti kalir,
    kalanlar `ready` kalir; ayni komut kaldigi yerden tamamlar, karar kaydi cift yazilmaz."""
    original = cli._governor
    calls = {"n": 0}

    def governor_with_signal(conn, args):
        gov = original(conn, args)
        inner = gov.before_batch

        def before() -> bool:
            calls["n"] += 1
            if calls["n"] == 3:
                cli._request_stop(15, None)
            return inner()

        gov.before_batch = before  # type: ignore[method-assign]
        return gov

    monkeypatch.setattr(cli, "_governor", governor_with_signal)
    assert _publish("--batch", "5") == 0
    assert _states(ready_world) == {"published": 10, "ready": 30}

    monkeypatch.setattr(cli, "_governor", original)
    monkeypatch.setattr(cli, "_stop", False)
    assert _publish("--batch", "5") == 0
    assert _states(ready_world) == {"published": 40}
    with _app() as c:
        dup = c.execute(
            "SELECT count(*) FROM (SELECT m.offer_id FROM match_decision_log m JOIN offer o"
            " ON o.id = m.offer_id WHERE o.merchant_id = %s AND m.decision = 'link'"
            " GROUP BY m.offer_id HAVING count(*) > 1) d",
            (ready_world,),
        ).fetchone()
        linked = c.execute(
            "SELECT count(*) FROM offer WHERE merchant_id = %s AND product_id IS NOT NULL",
            (ready_world,),
        ).fetchone()
    assert dup == (0,) and linked == (40,)
