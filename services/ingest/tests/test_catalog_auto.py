"""Otomatik katalog hatti: yeni teklif -> yayinlanmis urun (karar 0163).

Birim testler veritabanisiz. Entegrasyon testleri gercek PostgreSQL ile: kurulum SAHIP rolle,
hat UYGULAMA rolu baglantisiyla (uretimdeki gibi). Kosular test magazalariyla sinirlidir.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import psycopg
import pytest

from catalog_build import auto as auto_mod
from catalog_build import build as build_mod
from catalog_build import gate as gate_mod
from catalog_build.policy import SourcePolicy
from db.connection import database_url

SLUG = "test-auto-src"
OTHER_SLUG = "test-auto-other"
DOMAIN = "shop.test-auto.example"
POLICY = SourcePolicy(
    merchant_slug=SLUG,
    id_pattern=re.compile(r"^[0-9]{10,20}$"),
    url_pattern=re.compile(r"^https://shop\.test-auto\.example/item/([0-9]{10,20})\.html$"),
)
OTHER_POLICY = SourcePolicy(
    merchant_slug=OTHER_SLUG,
    id_pattern=re.compile(r"^[0-9]{10,20}$"),
    url_pattern=re.compile(r"^https://shop\.test-auto\.example/item/([0-9]{10,20})\.html$"),
)
POLICIES = {SLUG: POLICY, OTHER_SLUG: OTHER_POLICY}
BASE_ID = 3_000_000_000_000

SRC_A = "Home & Garden > Kitchen"
SRC_B = "Consumer Electronics > Gadgets"
SRC_REVIEW = "Mixed > Review Me"


def ext(n: int) -> str:
    return str(BASE_ID + n)


# --- birim testler (veritabanisiz) ---------------------------------------------------------


def test_lock_constants_match_the_writers_they_guard() -> None:
    from classify import run as classify_run
    from feeds import daily, sync
    from similarity import edges

    assert auto_mod.FEED_SYNC_LOCK_NAMESPACE == sync.LOCK_NAMESPACE
    assert auto_mod.FEEDS_DAILY_LOCK_NAMESPACE == daily.DAILY_LOCK_NAMESPACE
    assert auto_mod.SIMILARITY_EDGES_LOCK_KEY == edges.EDGE_LOCK_KEY
    assert auto_mod.CLASSIFY_LOCK_KEY == classify_run.LOCK_KEY
    assert auto_mod.AUTO_LOCK_KEY not in {
        auto_mod.CLASSIFY_LOCK_KEY,
        auto_mod.SIMILARITY_EDGES_LOCK_KEY,
        auto_mod.FEED_SYNC_LOCK_NAMESPACE,
        auto_mod.FEEDS_DAILY_LOCK_NAMESPACE,
    }


def test_backup_window_is_utc_and_half_open() -> None:
    def at(h: int, m: int) -> datetime:
        return datetime(2026, 11, 1, h, m, tzinfo=UTC)

    assert not auto_mod.in_backup_window(at(1, 19))
    assert auto_mod.in_backup_window(at(1, 20))
    assert auto_mod.in_backup_window(at(2, 4))
    assert not auto_mod.in_backup_window(at(2, 5))
    assert not auto_mod.in_backup_window(at(12, 0))


def test_stage_budgets_share_remaining_time_and_unused_time_flows_forward() -> None:
    clock = {"t": 0.0}
    now = lambda: clock["t"]  # noqa: E731
    stages = list(auto_mod.STAGES)
    first = auto_mod._stage_deadline("build", stages, 1000.0, now)
    assert first == pytest.approx(350.0)
    clock["t"] = 100.0  # build erken bitti
    second = auto_mod._stage_deadline("parents", stages[1:], 1000.0, now)
    assert second - 100.0 == pytest.approx(900.0 * 0.20 / 0.65)
    clock["t"] = 900.0
    last = auto_mod._stage_deadline("publish", ["publish"], 1000.0, now)
    assert last == pytest.approx(1000.0)


def test_guard_stops_on_signal_deadline_and_environment_change() -> None:
    clock = {"t": 0.0}
    reasons: list[str | None] = [None, None, "feed_sync_running"]
    calls: list[bool] = []

    def check(starting: bool) -> str | None:
        calls.append(starting)
        return reasons.pop(0) if reasons else None

    guard = auto_mod.Guard(check, clock=lambda: clock["t"], deadline=100.0)
    assert guard.start_reason() is None
    assert not guard.should_stop()  # ilk denetim
    clock["t"] = 5.0
    assert not guard.should_stop()  # aralik dolmadi: yeniden denetlenmez
    clock["t"] = 20.0
    assert guard.should_stop()  # ortam degisti
    assert guard.reason == "feed_sync_running"
    assert calls == [True, False, False]

    late = auto_mod.Guard(lambda _s: None, clock=lambda: 150.0, deadline=100.0)
    assert late.should_stop() and late.reason == "time"
    killed = auto_mod.Guard(lambda _s: None, external_stop=lambda: True)
    assert killed.should_stop() and killed.reason == "signal"


def test_result_detail_is_flat_and_small() -> None:
    result = auto_mod.AutoResult(rescan=True, gate_cursor=7)
    for name in auto_mod.STAGES:
        result.stages.append(
            auto_mod.StageResult(
                name=name,
                status="success",
                seconds=12.4,
                counters={"scanned": 1, "created": 2, "held_stale_source_offer": 3, "held": 3},
            )
        )
    detail = result.detail()
    assert len(detail) < 40
    assert all(isinstance(v, (int, float, bool, str)) for v in detail.values())
    assert "build_held_stale_source_offer" not in detail  # ayrinti adimin kendi kaydinda
    assert detail["gate_held"] == 3


def test_disk_thresholds_default_to_the_publish_watchdog_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CATALOG_AUTO_START_FREE_GB", raising=False)
    monkeypatch.delenv("CATALOG_AUTO_RESERVE_FREE_GB", raising=False)
    assert auto_mod.disk_thresholds_from_env() == (70, 40)
    monkeypatch.setenv("CATALOG_AUTO_START_FREE_GB", "5")
    monkeypatch.setenv("CATALOG_AUTO_RESERVE_FREE_GB", "oops")
    assert auto_mod.disk_thresholds_from_env() == (5, 40)  # bozuk deger varsayilana duser


def test_gate_sql_scopes_states_and_merchant() -> None:
    assert "ANY(%(states)s)" in gate_mod.GATE_BATCH
    assert "%(merchant_id)s" in gate_mod.GATE_BATCH
    assert "category_missing" in gate_mod.GATE_BATCH


# --- entegrasyon testleri ------------------------------------------------------------------


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


CLEANUP = (
    """DELETE FROM search_outbox WHERE entity = 'product' AND entity_id IN (
        SELECT id FROM product WHERE source_merchant_id IN
            (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s)))""",
    """DELETE FROM match_decision_log WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id WHERE m.slug = ANY(%(slugs)s))""",
    """UPDATE offer SET product_id = NULL WHERE merchant_id IN
        (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))""",
    """DELETE FROM price_point WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id WHERE m.slug = ANY(%(slugs)s))""",
    """DELETE FROM product WHERE source_merchant_id IN
        (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))""",
    "DELETE FROM product_classification_state WHERE scope LIKE 'merchant:test-auto%%'",
    "DELETE FROM catalog_build_state WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))",
    "DELETE FROM merchant WHERE slug = ANY(%(slugs)s)",
    "DELETE FROM job_run WHERE detail->>'via' = 'catalog_auto'",
)


def _cleanup(cur: psycopg.Cursor) -> None:
    for statement in CLEANUP:
        cur.execute(statement, {"slugs": [SLUG, OTHER_SLUG]})


def add_offer(
    cur: psycopg.Cursor,
    merchant_id: int,
    n: int,
    *,
    category_raw: str | None = SRC_A,
    title: str | None = None,
    price: int | None = 1999,
    currency: str = "USD",
    seen_days_ago: int = 0,
) -> int:
    e = ext(n)
    cur.execute(
        """INSERT INTO offer (merchant_id, external_id, url, title_raw, category_raw, image_url,
                              current_price, currency, is_active, last_seen_at)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, true, now() - make_interval(days => %s))
           RETURNING id""",
        (
            merchant_id,
            e,
            f"https://{DOMAIN}/item/{e}.html",
            title
            if title is not None
            else f"Portable Blender Cup Model Number {n} USB Rechargeable",
            category_raw,
            f"https://img.{DOMAIN}/{e}.jpg",
            price,
            currency,
            seen_days_ago,
        ),
    )
    row = cur.fetchone()
    assert row is not None
    return int(row[0])


@pytest.fixture
def world() -> Iterator[dict[str, int]]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            _cleanup(cur)
            ids: dict[str, int] = {}
            for slug in (SLUG, OTHER_SLUG):
                cur.execute(
                    """INSERT INTO merchant (slug, name, domain, source_type, is_active)
                       VALUES (%s, 'Test Auto', %s, 'xml_feed', true) RETURNING id""",
                    (slug, f"{slug}.example"),
                )
                row = cur.fetchone()
                assert row is not None
                ids[slug] = int(row[0])
        owner.commit()
        yield ids
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()


@pytest.fixture
def map_file(tmp_path: Path) -> Path:
    path = tmp_path / "map.tsv"
    path.write_text(
        "\n".join(
            [
                "# test haritasi",
                f"{SRC_A}\tyuksek\tev-yasam/mutfak\t\ttest",
                f"{SRC_B}\tyuksek\telektronik/telefon\t\ttest",
                f"{SRC_REVIEW}\tinceleme\t\tev-yasam\ttest",
            ]
        ),
        encoding="utf-8",
    )
    return path


@pytest.fixture(autouse=True)
def _foreign_approved(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CATALOG_PUBLISH_FOREIGN_APPROVED", "true")


def fetch(sql: str, *params):
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def run(world, map_file: Path, *, check=None, **overrides) -> auto_mod.AutoResult:
    options = {
        "merchant": SLUG,
        "allow_foreign": True,
        "sleep_ms": 0,
        "build_batch": 3,
        "parents_batch": 3,
        "gate_batch": 3,
        "publish_batch": 2,
        "rescan_days": 0,
        "max_seconds": 120.0,
    }
    options.update(overrides)
    guard = auto_mod.Guard(check or (lambda _starting: None))
    with _app() as conn:
        return auto_mod.run_auto(
            conn,
            auto_mod.AutoOptions(**options),  # type: ignore[arg-type]
            guard,
            None,
            policy=POLICY,
            policies=POLICIES,
            map_path=map_file,
        )


def seed(world) -> dict[str, int]:
    m = world[SLUG]
    ids: dict[str, int] = {}
    with _owner() as owner, owner.cursor() as cur:
        for n in (1, 2, 3):
            ids[f"a{n}"] = add_offer(cur, m, n, category_raw=SRC_A)
        ids["review"] = add_offer(cur, m, 4, category_raw=SRC_REVIEW)
        ids["stale"] = add_offer(cur, m, 5, seen_days_ago=5)
        ids["badtitle"] = add_offer(cur, m, 6, title="abc")
        ids["try"] = add_offer(cur, m, 7, category_raw=SRC_B, currency="TRY", price=25000)
        # Gecmis fiyat noktalari: hat bunlara DOKUNMAMALI.
        for k, days in (("a1", 3), ("a1", 1), ("try", 2)):
            cur.execute(
                """INSERT INTO price_point (offer_id, observed_at, price, in_stock)
                   VALUES (%s, now() - make_interval(days => %s), %s, true)""",
                (ids[k], days, 1500 + days),
            )
        owner.commit()
    return ids


def snapshot_invariants(world):
    prices = fetch(
        """SELECT pp.offer_id, pp.observed_at, pp.price FROM price_point pp
           JOIN offer o ON o.id = pp.offer_id WHERE o.merchant_id = %s ORDER BY 1, 2""",
        world[SLUG],
    )
    offers = fetch(
        """SELECT id, external_id, current_price, currency, is_active, title_raw, last_seen_at
             FROM offer WHERE merchant_id = %s ORDER BY id""",
        world[SLUG],
    )
    return prices, offers


def products(world, merchant: str = SLUG):
    return {
        row[0]: row[1:]
        for row in fetch(
            """SELECT source_external_id, publication_state, hold_reason, category_id,
                      min_price, foreign_offer_count, offer_count
                 FROM product WHERE source_merchant_id = %s""",
            world[merchant],
        )
    }


MUTFAK, TELEFON = 30, 21


@pytest.mark.integration
def test_new_offers_become_published_products_and_rerun_is_idempotent(world, map_file):
    ids = seed(world)
    before = snapshot_invariants(world)

    first = run(world, map_file)

    assert first.exit_code == 0 and first.status == "success", first.stages
    by_stage = {s.name: s for s in first.stages}
    assert by_stage["build"].counters["created"] == 6  # kotu baslikli teklif urun olmaz
    assert by_stage["build"].counters["skipped"] == 1
    assert by_stage["parents"].counters["category_set"] == 5  # a1-a3, bayat urun, try
    assert by_stage["publish"].counters["published"] == 5

    got = products(world)
    assert set(got) == {ext(n) for n in (1, 2, 3, 4, 5, 7)}
    for n in (1, 2, 3):
        state, reason, cat, *_ = got[ext(n)]
        assert (state, reason, cat) == ("published", None, MUTFAK)
    assert got[ext(4)][0:3] == ("published", None, None)  # inceleme yolu: kategori YAZILMAZ
    assert got[ext(5)][0:2] == ("held", "stale_source_offer")  # bayat teklif yayinlanmaz
    # TRY urun fiyat ozetini alir; USD urun min_price'i kirletmez ve yurt disi sayilir.
    try_state, _, try_cat, try_min, try_foreign, try_offers = got[ext(7)]
    assert (try_state, try_cat, try_min, try_foreign, try_offers) == (
        "published",
        TELEFON,
        25000,
        0,
        1,
    )
    assert got[ext(1)][3:] == (None, 1, 0)

    linked = fetch(
        "SELECT count(*) FROM offer WHERE merchant_id = %s AND product_id IS NOT NULL",
        world[SLUG],
    )
    assert linked == [(5,)]
    assert fetch(
        "SELECT count(*) FROM product WHERE source_merchant_id = %s AND publication_state = 'draft'",
        world[SLUG],
    ) == [(0,)]

    # Fiyat gecmisi ve teklif alanlari degismedi (yalniz offer.product_id baglandi).
    assert snapshot_invariants(world) == before

    # Ikinci kosu: hicbir sey degismez (idempotent).
    state_before = fetch(
        "SELECT id, publication_state, hold_reason, category_id, updated_at FROM product "
        "WHERE source_merchant_id = %s ORDER BY id",
        world[SLUG],
    )
    second = run(world, map_file)
    assert second.exit_code == 0
    by_stage = {s.name: s for s in second.stages}
    assert by_stage["build"].counters["created"] == 0
    assert by_stage["parents"].counters["category_set"] == 0
    assert by_stage["publish"].counters["published"] == 0
    assert (
        fetch(
            "SELECT id, publication_state, hold_reason, category_id, updated_at FROM product "
            "WHERE source_merchant_id = %s ORDER BY id",
            world[SLUG],
        )
        == state_before
    )
    assert snapshot_invariants(world) == before
    # Teklif kimlikleri korundu: ayni id'ler hala ayni urunlere bagli.
    assert {
        row[0] for row in fetch("SELECT id FROM offer WHERE merchant_id = %s", world[SLUG])
    } == set(ids.values())


@pytest.mark.integration
def test_new_offer_and_revived_stale_offer_follow_on_the_next_run(world, map_file):
    seed(world)
    run(world, map_file)
    prices_before, _ = snapshot_invariants(world)

    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        add_offer(cur, m, 20, category_raw=SRC_B)  # yeni teklif (daha buyuk id)
        # Bayat teklif kaynakta geri dondu (besleme `last_seen_at`i tazeledi).
        cur.execute(
            "UPDATE offer SET last_seen_at = now() WHERE merchant_id = %s AND external_id = %s",
            (m, ext(5)),
        )
        owner.commit()

    result = run(world, map_file)
    got = products(world)
    assert result.status == "success", result.stages
    assert got[ext(20)][0:3] == ("published", None, TELEFON)  # yeni teklif -> yayinlanmis urun
    assert got[ext(5)][0:2] == ("published", None)  # held -> ready -> published
    prices_after, _ = snapshot_invariants(world)
    assert prices_after == prices_before  # price_point yalniz INSERT-only; hat eklemedi/silmedi


@pytest.mark.integration
def test_unapproved_foreign_stays_ready_and_run_is_reported_partial(world, map_file, monkeypatch):
    monkeypatch.delenv("CATALOG_PUBLISH_FOREIGN_APPROVED", raising=False)
    seed(world)
    result = run(world, map_file)
    got = products(world)
    assert result.status == "partial"
    publish = {s.name: s for s in result.stages}["publish"]
    assert publish.status == "partial" and publish.counters["foreign_not_approved"] == 4
    assert got[ext(7)][0] == "published"  # TRY urun yayinlanir
    assert got[ext(1)][0] == "ready"  # USD urun onay gelene kadar hazir bekler (held degil)


@pytest.mark.integration
def test_require_category_holds_products_without_trusted_category(world, map_file):
    seed(world)
    run(world, map_file, require_category=True)
    got = products(world)
    assert got[ext(4)][0:2] == ("held", "category_missing")
    assert got[ext(1)][0] == "published"


@pytest.mark.integration
def test_busy_writer_skips_the_run_without_writing(world, map_file):
    seed(world)
    holder = psycopg.connect(database_url("DATABASE_URL_OWNER"), autocommit=True)
    try:
        holder.execute("SELECT pg_advisory_lock(%s, %s)", (auto_mod.FEED_SYNC_LOCK_NAMESPACE, 999))
        stub = auto_mod.AutoOptions(disk_path=".", start_free_gb=0, reserve_free_gb=0)

        def check(starting: bool) -> str | None:
            with psycopg.connect(database_url("DATABASE_URL_OWNER"), autocommit=True) as g:
                return auto_mod.environment_reason(
                    g, [0], stub, datetime(2026, 11, 1, 12, 0, tzinfo=UTC), starting=starting
                )

        result = run(world, map_file, check=check)
    finally:
        holder.close()
    assert result.exit_code == auto_mod.EXIT_BUSY
    assert result.skipped == "feed_sync_running"
    assert products(world) == {}  # hicbir urun yazilmadi


@pytest.mark.integration
def test_other_merchants_products_are_not_gated_or_published(world, map_file):
    seed(world)
    with _owner() as owner, owner.cursor() as cur:
        add_offer(cur, world[OTHER_SLUG], 50)
        owner.commit()
    with _app() as conn:
        build_mod.build_source_products(conn, merchant_slug=OTHER_SLUG, policy=OTHER_POLICY)
    assert products(world, OTHER_SLUG)[ext(50)][0] == "draft"

    run(world, map_file)

    assert products(world, OTHER_SLUG)[ext(50)][0:2] == ("draft", None)


@pytest.mark.integration
def test_publish_limit_bounds_one_run_and_the_next_run_continues(world, map_file):
    seed(world)
    first = run(world, map_file, publish_limit=2)
    published_first = {s.name: s for s in first.stages}["publish"].counters["published"]
    assert published_first == 2
    second = run(world, map_file, publish_limit=100)
    published_second = {s.name: s for s in second.stages}["publish"].counters["published"]
    assert published_first + published_second == 5


@pytest.mark.integration
def test_backlog_counts_pending_work_read_only(world, map_file):
    seed(world)
    with _app() as conn:
        report = auto_mod.backlog(conn, SLUG, deep=True)
    assert report.offers_total == 7
    assert report.offers_without_product_row == 7
    assert report.products == {}
    run(world, map_file)
    with _app() as conn:
        report = auto_mod.backlog(conn, SLUG, deep=True)
        text = auto_mod.format_backlog(report)
    assert report.products == {"published": 5, "held": 1}
    assert report.held_by_reason == {"stale_source_offer": 1}
    assert report.categorised["published"] == 4
    assert report.offers_without_product_row == 1  # kotu baslikli teklif
    assert report.offers_linked == 5
    assert "stale_source_offer" in text and "kategorili 4" in text
