"""Kaynak ilanindan katalog: aktarim, kapi, yayin (karar 0121). Gercek PostgreSQL.

Kurulum SAHIP rolle; aktarim/kapi/yayin UYGULAMA rolu baglantisiyla (uretimdeki gibi).
Test magazasi kendi politikasiyla calisir; gercek `aliexpress` kaydina dokunulmaz.
"""

from __future__ import annotations

import re
from collections.abc import Iterator

import psycopg
import pytest

from catalog_build import build as build_mod
from catalog_build import gate as gate_mod
from catalog_build import publish as publish_mod
from catalog_build.policy import SourcePolicy
from db.connection import database_url
from resolve import candidates as candidate_channels

pytestmark = pytest.mark.integration

SLUG = "test-cb-source"
OTHER_SLUG = "test-cb-other"
POLICY = SourcePolicy(
    merchant_slug=SLUG,
    id_pattern=re.compile(r"^[0-9]{10,20}$"),
    url_pattern=re.compile(r"^https://shop\.test-cb\.example/item/([0-9]{10,20})\.html$"),
)
POLICIES = {SLUG: POLICY}
BASE_ID = 2_000_000_000_000


def ext(n: int) -> str:
    return str(BASE_ID + n)


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


CLEANUP = (
    """DELETE FROM search_outbox WHERE entity = 'product' AND entity_id IN (
        SELECT id FROM product WHERE source_merchant_id IN
            (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s)) OR slug LIKE 'test-cb-%%')""",
    """DELETE FROM match_decision_log WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id WHERE m.slug = ANY(%(slugs)s))""",
    """UPDATE offer SET product_id = NULL WHERE merchant_id IN
        (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))""",
    """DELETE FROM price_point WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id WHERE m.slug = ANY(%(slugs)s))""",
    """DELETE FROM product WHERE source_merchant_id IN
        (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s)) OR slug LIKE 'test-cb-%%'""",
    "DELETE FROM catalog_build_state WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))",
    "DELETE FROM merchant WHERE slug = ANY(%(slugs)s)",
)


def _cleanup(cur: psycopg.Cursor) -> None:
    for statement in CLEANUP:
        cur.execute(statement, {"slugs": [SLUG, OTHER_SLUG]})


def add_offer(
    cur: psycopg.Cursor,
    merchant_id: int,
    n: int,
    *,
    title: str | None = None,
    price: int | None = 1999,
    currency: str = "USD",
    image: str | None = "https://img.test-cb.example/a.jpg",
    active: bool = True,
    url: str | None = None,
    external_id: str | None = None,
    seen_days_ago: int = 0,
) -> int:
    ext_id = external_id or ext(n)
    cur.execute(
        """INSERT INTO offer (merchant_id, external_id, url, title_raw, image_url, current_price,
                              currency, is_active, last_seen_at)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now() - make_interval(days => %s)) RETURNING id""",
        (
            merchant_id,
            ext_id,
            url or f"https://shop.test-cb.example/item/{ext_id}.html",
            title
            if title is not None
            else f"Portable Blender Cup Model Number {n} USB Rechargeable",
            image,
            price,
            currency,
            active,
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
                       VALUES (%s, 'Test CB', %s, 'xml_feed', true) RETURNING id""",
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


def fetch(sql: str, *params):
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def build(world, **kwargs) -> build_mod.BuildCounts:
    with _app() as conn:
        return build_mod.build_source_products(conn, merchant_slug=SLUG, policy=POLICY, **kwargs)


def seed_basic(world) -> dict[str, int]:
    """4 uygun + her atlama nedeninden bir tane."""
    m = world[SLUG]
    ids: dict[str, int] = {}
    with _owner() as owner, owner.cursor() as cur:
        for n in (1, 2, 3, 4):
            ids[f"ok{n}"] = add_offer(cur, m, n)
        ids["inactive"] = add_offer(cur, m, 10, active=False)
        ids["noimg"] = add_offer(cur, m, 11, image=None)
        ids["noprice"] = add_offer(cur, m, 12, price=None)
        ids["shorttitle"] = add_offer(cur, m, 13, title="abc")
        ids["badid"] = add_offer(
            cur,
            m,
            14,
            external_id="notanumber",
            url="https://shop.test-cb.example/item/notanumber.html",
        )
        ids["mismatch"] = add_offer(
            cur, m, 15, url=f"https://shop.test-cb.example/item/{ext(99)}.html"
        )
        owner.commit()
    return ids


def test_build_creates_only_safe_drafts_and_never_touches_offers(world):
    ids = seed_basic(world)
    before = fetch(
        "SELECT id, product_id, current_price, currency, is_active, title_raw, image_url, "
        "last_seen_at, first_seen_at, last_changed_at, fingerprint FROM offer "
        "WHERE merchant_id = %s ORDER BY id",
        world[SLUG],
    )
    counts = build(world, batch_size=3)
    after = fetch(
        "SELECT id, product_id, current_price, currency, is_active, title_raw, image_url, "
        "last_seen_at, first_seen_at, last_changed_at, fingerprint FROM offer "
        "WHERE merchant_id = %s ORDER BY id",
        world[SLUG],
    )
    assert before == after  # fiyat, para birimi, durum, zaman damgasi: HICBIRI degismedi
    assert all(row[1] is None for row in after)  # taslak urun offer'a BAGLANMAZ

    assert counts.completed
    assert counts.created == 4
    assert counts.skipped == {
        "inactive": 1,
        "no_image": 1,
        "no_price": 1,
        "title_too_short": 1,
        "source_id_invalid": 1,
        "source_id_url_mismatch": 1,
    }
    rows = fetch(
        """SELECT publication_state, brand_id, category_id, gtin, color, min_price, offer_count,
                  source_external_id, source_offer_id, slug
             FROM product WHERE source_merchant_id = %s ORDER BY source_external_id""",
        world[SLUG],
    )
    assert len(rows) == 4
    for (
        state,
        brand,
        category,
        gtin,
        color,
        min_price,
        offer_count,
        source_ext,
        _source_offer,
        slug,
    ) in rows:
        # Bilgi uydurulmaz: marka, kategori, GTIN, renk, fiyat ozeti BOS.
        assert (state, brand, category, gtin, color, min_price, offer_count) == (
            "draft",
            None,
            None,
            None,
            None,
            None,
            0,
        )
        assert slug.endswith(f"-{source_ext}")
    assert sorted(r[8] for r in rows) == sorted(ids[f"ok{n}"] for n in (1, 2, 3, 4))


def test_audit_dry_run_reports_eligibility_and_writes_nothing(world):
    seed_basic(world)
    with _app() as conn:
        counts = build_mod.build_source_products(
            conn, merchant_slug=SLUG, policy=POLICY, batch_size=3, dry_run=True
        )
    assert counts.completed and counts.scanned == 10
    assert counts.created == 4  # "olusturulurdu"
    assert counts.skipped["inactive"] == 1 and counts.skipped["source_id_url_mismatch"] == 1
    assert fetch("SELECT count(*) FROM product WHERE source_merchant_id = %s", world[SLUG]) == [
        (0,)
    ]
    assert fetch(
        "SELECT count(*) FROM catalog_build_state WHERE merchant_id = %s", world[SLUG]
    ) == [(0,)]


def test_build_is_idempotent_and_rescan_creates_nothing_new(world):
    seed_basic(world)
    first = build(world)
    again = build(world)
    assert (first.created, again.created) == (4, 0)
    rescan = build(world, rescan=True)
    assert rescan.created == 0
    assert rescan.existing == 4
    assert fetch("SELECT count(*) FROM product WHERE source_merchant_id = %s", world[SLUG]) == [
        (4,)
    ]


def test_resumes_from_checkpoint_after_stop(world):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        for n in range(1, 8):
            add_offer(cur, m, n)
        owner.commit()
    part = build(world, batch_size=2, max_batches=2)
    assert not part.completed
    assert part.created == 4
    state = fetch(
        "SELECT last_offer_id, scanned, created, completed_at FROM catalog_build_state WHERE merchant_id = %s",
        m,
    )
    assert state[0][1:3] == (4, 4) and state[0][3] is None

    rest = build(world, batch_size=2)
    assert rest.completed
    assert rest.created == 3  # kalan 3; ilk 4 tekrarlanmadi
    assert fetch("SELECT scanned, created FROM catalog_build_state WHERE merchant_id = %s", m) == [
        (7, 7)
    ]


def test_cooperative_stop_finishes_current_batch_then_resumes(world):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        for n in range(1, 7):
            add_offer(cur, m, n)
        owner.commit()
    calls = {"n": 0}

    def stop_after_first() -> bool:
        calls["n"] += 1
        return calls["n"] > 1

    part = build(world, batch_size=2, should_stop=stop_after_first)
    assert part.batches == 1 and part.created == 2 and not part.completed
    assert build(world, batch_size=2).created == 4


def test_failed_batch_leaves_no_partial_rows_or_checkpoint(world, monkeypatch):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        for n in range(1, 7):
            add_offer(cur, m, n)
        owner.commit()
    real = build_mod._insert_drafts
    seen = {"n": 0}

    def flaky(conn, merchant_id, drafts, counts):
        seen["n"] += 1
        if seen["n"] == 2:
            real(conn, merchant_id, drafts, counts)  # satirlar yazildi...
            raise RuntimeError("cokme")  # ...ama kontrol noktasindan once dustu
        return real(conn, merchant_id, drafts, counts)

    monkeypatch.setattr(build_mod, "_insert_drafts", flaky)
    with pytest.raises(RuntimeError):
        build(world, batch_size=2)
    # 2. parti geri alindi: yalniz ilk parti ve kontrol noktasi var.
    assert fetch("SELECT count(*) FROM product WHERE source_merchant_id = %s", m) == [(2,)]
    assert fetch("SELECT scanned, created FROM catalog_build_state WHERE merchant_id = %s", m) == [
        (2, 2)
    ]
    monkeypatch.setattr(build_mod, "_insert_drafts", real)
    done = build(world, batch_size=2)
    assert done.completed and done.created == 4
    assert fetch("SELECT count(*) FROM product WHERE source_merchant_id = %s", m) == [(6,)]


def test_new_offers_after_completion_are_picked_up_without_duplicates(world):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        add_offer(cur, m, 1)
        owner.commit()
    assert build(world).created == 1
    with _owner() as owner, owner.cursor() as cur:
        add_offer(cur, m, 2)
        owner.commit()
    again = build(world)
    assert again.created == 1 and again.scanned == 1


def test_slug_conflict_is_isolated_not_fatal(world):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        add_offer(cur, m, 1)
        add_offer(cur, m, 2, title="Test CB conflict item two")
        add_offer(cur, m, 3)
        # Baska bir urun ikinci ilanin slug'ini onceden tutmus.
        cur.execute(
            "INSERT INTO product (slug, title) VALUES (%s, 'Eski')",
            (f"test-cb-conflict-item-two-{ext(2)}",),
        )
        owner.commit()
    counts = build(world)
    assert counts.created == 2
    assert counts.skipped.get("slug_conflict") == 1
    assert fetch("SELECT count(*) FROM product WHERE source_merchant_id = %s", m) == [(2,)]


def test_same_title_different_listings_are_separate_products(world):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        add_offer(cur, m, 1, title="Stainless Steel Water Bottle 500ml Black")
        add_offer(cur, m, 2, title="Stainless Steel Water Bottle 500ml Black")
        add_offer(cur, m, 3, title="Stainless Steel Water Bottle 750ml Black")
        owner.commit()
    assert build(world).created == 3
    assert fetch("SELECT count(DISTINCT slug) FROM product WHERE source_merchant_id = %s", m) == [
        (3,)
    ]


def test_db_refuses_second_product_for_same_source_listing(world):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        add_offer(cur, m, 1)
        owner.commit()
    build(world)
    with _owner() as owner, owner.cursor() as cur, pytest.raises(psycopg.errors.UniqueViolation):
        cur.execute(
            """INSERT INTO product (slug, title, source_merchant_id, source_external_id,
                                    publication_state)
               VALUES ('test-cb-dup', 'Duplicate', %s, %s, 'draft')""",
            (m, ext(1)),
        )


def test_only_source_listings_can_be_unpublished_rows(world):
    with _owner() as owner, owner.cursor() as cur, pytest.raises(psycopg.errors.CheckViolation):
        cur.execute(
            "INSERT INTO product (slug, title, publication_state) VALUES ('test-cb-x', 'x', 'draft')"
        )


def test_gate_marks_ready_and_holds_with_reasons(world):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        ok = add_offer(cur, m, 1, currency="TRY")
        stale = add_offer(cur, m, 2, currency="TRY", seen_days_ago=30)
        foreign = add_offer(cur, m, 3, currency="USD")
        gone = add_offer(cur, m, 4, currency="TRY")
        owner.commit()
    build(world)
    with _owner() as owner, owner.cursor() as cur:
        cur.execute("UPDATE offer SET is_active = false WHERE id = %s", (gone,))
        owner.commit()
    with _app() as conn:
        counts = gate_mod.run_gate(conn)
    assert counts.ready == 1
    assert counts.held == {"stale_source_offer": 1, "source_offer_inactive": 1}
    assert counts.foreign_blocked == 1
    states = dict(
        fetch(
            "SELECT source_offer_id, publication_state || ':' || COALESCE(hold_reason, '') FROM product WHERE source_merchant_id = %s",
            m,
        )
    )
    assert states[ok] == "ready:"
    assert states[stale] == "held:stale_source_offer"
    # Yurt disi: kalite sorunu degil, bekleyen karar; taslak KALIR, satir yazilmaz.
    assert states[foreign] == "draft:"
    assert states[gone] == "held:source_offer_inactive"

    # Tekrar calistirmak hicbir satiri degistirmez.
    with _app() as conn:
        assert gate_mod.run_gate(conn).changed == 0

    # Kaynak duzelince kapi urunu geri alir (held -> ready); yurt disi ancak acik izinle.
    with _owner() as owner, owner.cursor() as cur:
        cur.execute("UPDATE offer SET last_seen_at = now() WHERE id = %s", (stale,))
        owner.commit()
    with _app() as conn:
        again = gate_mod.run_gate(conn, allow_foreign=True)
    assert again.ready == 3  # ok + stale (taze) + foreign (acik izin)


def test_publish_requires_ready_links_offer_and_keeps_foreign_out_of_price_summary(
    world, monkeypatch
):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        try_offer = add_offer(cur, m, 1, currency="TRY", price=25000)
        usd_offer = add_offer(cur, m, 2, currency="USD", price=1299)
        owner.commit()
    build(world)
    with _app() as conn:
        gate_mod.run_gate(conn, allow_foreign=True)

    # Onaysiz: yurt disi urun yayinlanmaz, TRY urun yayinlanir.
    monkeypatch.delenv(publish_mod.FOREIGN_APPROVAL_ENV, raising=False)
    with _app() as conn:
        counts = publish_mod.publish_ready(conn, policies=POLICIES, limit=10, allow_foreign=True)
    assert counts.published == 1
    assert counts.left_ready == {"foreign_not_approved": 1}
    rows = {
        r[0]: r[1:]
        for r in fetch(
            """SELECT o.id, p.publication_state, COALESCE(o.product_id = p.id, false), p.min_price, p.offer_count
                 FROM product p JOIN offer o ON o.id = p.source_offer_id
                WHERE p.source_merchant_id = %s""",
            m,
        )
    }
    assert rows[try_offer] == ("published", True, 25000, 1)
    assert rows[usd_offer] == ("ready", False, None, 0)

    # Onayli ama bayraksiz: yine yayinlanmaz.
    monkeypatch.setenv(publish_mod.FOREIGN_APPROVAL_ENV, "true")
    with _app() as conn:
        assert (
            publish_mod.publish_ready(
                conn, policies=POLICIES, limit=10, allow_foreign=False
            ).published
            == 0
        )
        counts = publish_mod.publish_ready(conn, policies=POLICIES, limit=10, allow_foreign=True)
    assert counts.published == 1
    usd = fetch(
        """SELECT p.publication_state, o.product_id = p.id, o.current_price, o.currency,
                  p.min_price, p.offer_count
             FROM product p JOIN offer o ON o.id = p.source_offer_id WHERE o.id = %s""",
        usd_offer,
    )
    # USD tutar kurus gibi okunup urun ozetine GIRMEZ; teklifin kendi fiyati/para birimi korunur.
    assert usd == [("published", True, 1299, "USD", None, 0)]
    log = fetch(
        "SELECT decision, actor, basis FROM match_decision_log WHERE offer_id = ANY(%s)",
        [try_offer, usd_offer],
    )
    assert sorted(log) == [("link", "backfill", "source_listing")] * 2
    assert fetch(
        "SELECT count(*) FROM search_outbox WHERE reason = 'source_listing_published' AND entity_id IN (SELECT id FROM product WHERE source_merchant_id = %s)",
        m,
    ) == [(2,)]


def test_publish_does_not_take_a_draft_and_unpublish_restores(world):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        offer_id = add_offer(cur, m, 1, currency="TRY")
        owner.commit()
    build(world)
    with _app() as conn:
        assert (
            publish_mod.publish_ready(conn, policies=POLICIES, limit=10).published == 0
        )  # kapidan gecmedi
    with _app() as conn:
        gate_mod.run_gate(conn)
        assert publish_mod.publish_ready(conn, policies=POLICIES, limit=10).published == 1
    (pid,) = fetch("SELECT id FROM product WHERE source_offer_id = %s", offer_id)[0]
    with _app() as conn:
        assert publish_mod.unpublish(conn, [pid]) == 1
    assert fetch(
        "SELECT p.publication_state, o.product_id, p.min_price, o.current_price FROM product p JOIN offer o ON o.id = p.source_offer_id WHERE p.id = %s",
        pid,
    ) == [("ready", None, None, 1999)]


def test_publish_holds_when_offer_got_linked_elsewhere_in_the_meantime(world):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        offer_id = add_offer(cur, m, 1, currency="TRY")
        cur.execute(
            "INSERT INTO product (slug, title) VALUES ('test-cb-canonical', 'Canonical') RETURNING id"
        )
        canonical = cur.fetchone()[0]
        owner.commit()
    build(world)
    with _app() as conn:
        gate_mod.run_gate(conn)
    with _owner() as owner, owner.cursor() as cur:
        cur.execute("UPDATE offer SET product_id = %s WHERE id = %s", (canonical, offer_id))
        owner.commit()
    with _app() as conn:
        counts = publish_mod.publish_ready(conn, policies=POLICIES, limit=10)
    assert counts.published == 0 and counts.held == {"offer_linked_elsewhere": 1}
    # Baska urune bagli teklif KOPARILMADI.
    assert fetch("SELECT product_id FROM offer WHERE id = %s", offer_id) == [(canonical,)]


def test_drafts_are_not_resolver_candidates_but_published_are(world):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        add_offer(cur, m, 1, currency="TRY", title="Insulated Steel Travel Mug Leakproof Lid 450ml")
        owner.commit()
    build(world)
    probe = "Insulated Steel Travel Mug Leakproof Lid 450ml"
    with _app() as conn:
        assert candidate_channels.by_title(conn, probe) == []
        gate_mod.run_gate(conn)
        publish_mod.publish_ready(conn, policies=POLICIES, limit=5)
        assert [c.title for c in candidate_channels.by_title(conn, probe)] == [probe]


def test_gate_and_publish_never_change_offer_price_or_currency(world):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        offer_id = add_offer(cur, m, 1, currency="TRY")
        owner.commit()
    build(world)
    with _app() as conn:
        gate_mod.run_gate(conn)
        publish_mod.publish_ready(conn, policies=POLICIES, limit=5)
    assert fetch(
        "SELECT current_price, currency, is_active FROM offer WHERE id = %s", offer_id
    ) == [(1999, "TRY", True)]


def test_publish_writes_price_summary_once_and_equal_to_refresh(world, monkeypatch):
    """Karar 0135: ozet yayin UPDATE'inde yazilir; ayni kural (0090), ayni sonuc."""
    m, other = world[SLUG], world[OTHER_SLUG]
    with _owner() as owner, owner.cursor() as cur:
        try_offer = add_offer(cur, m, 1, currency="TRY", price=25000)
        usd_offer = add_offer(cur, m, 2, currency="USD", price=1299)
        owner.commit()
    build(world)
    with _app() as conn:
        gate_mod.run_gate(conn, allow_foreign=True)
    (try_pid,) = fetch("SELECT id FROM product WHERE source_offer_id = %s", try_offer)[0]
    with _owner() as owner, owner.cursor() as cur:
        # Baska magazanin daha ucuz, stoksuz TRY teklifi ayni urune zaten bagli.
        cheaper = add_offer(cur, other, 50, currency="TRY", price=19900)
        cur.execute(
            "UPDATE offer SET product_id = %s, in_stock = false WHERE id = %s", (try_pid, cheaper)
        )
        owner.commit()

    monkeypatch.setenv(publish_mod.FOREIGN_APPROVAL_ENV, "true")
    with _app() as conn:
        counts = publish_mod.publish_ready(conn, policies=POLICIES, limit=10, allow_foreign=True)
    assert counts.published == 2
    assert counts.aggregates_updated == 2

    rows = {
        r[0]: r[1:]
        for r in fetch(
            """SELECT p.source_offer_id, p.publication_state, p.min_price, p.max_price,
                      p.offer_count, p.in_stock_count, p.foreign_offer_count,
                      p.price_updated_at IS NOT NULL
                 FROM product p WHERE p.source_merchant_id = %s""",
            m,
        )
    }
    assert rows[try_offer] == ("published", 19900, 25000, 2, 1, 0, True)
    assert rows[usd_offer] == ("published", None, None, 0, 0, 1, True)
    # Tek kural: ayni urunlerde tam yenileme hicbir satiri degistirmez.
    pids = [r[0] for r in fetch("SELECT id FROM product WHERE source_merchant_id = %s", m)]
    assert fetch("SELECT refresh_product_aggregates(%s::bigint[])", pids) == [(0,)]


def test_publish_keeps_price_timestamp_when_summary_is_unchanged(world):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        offer_id = add_offer(cur, m, 1, currency="TRY", price=25000)
        owner.commit()
    build(world)
    with _app() as conn:
        gate_mod.run_gate(conn)
    (pid,) = fetch("SELECT id FROM product WHERE source_offer_id = %s", offer_id)[0]
    with _owner() as owner, owner.cursor() as cur:
        # Ozet onceden dogru (or. yeniden yayin): damga ve sayac degismez.
        cur.execute(
            """UPDATE product SET min_price = 25000, max_price = 25000, offer_count = 1,
                      in_stock_count = 1, price_updated_at = '2026-01-01T00:00:00Z' WHERE id = %s""",
            (pid,),
        )
        owner.commit()
    with _app() as conn:
        counts = publish_mod.publish_ready(conn, policies=POLICIES, limit=10)
    assert counts.published == 1 and counts.aggregates_updated == 0
    assert fetch(
        "SELECT publication_state, min_price, price_updated_at = '2026-01-01T00:00:00Z' FROM product WHERE id = %s",
        pid,
    ) == [("published", 25000, True)]


def test_publish_with_merchant_filter_never_touches_other_sources(world, monkeypatch):
    m, other = world[SLUG], world[OTHER_SLUG]
    with _owner() as owner, owner.cursor() as cur:
        add_offer(cur, m, 1, currency="USD")
        other_offer = add_offer(cur, other, 2, currency="USD")
        # Diger kaynagin `ready` urunu kimlik sirasinda araya girer.
        cur.execute(
            """INSERT INTO product (slug, title, primary_image_url, source_merchant_id,
                                    source_external_id, source_offer_id, publication_state)
               VALUES ('test-cb-other-ready', 'Other Source Ready Product', NULL, %s, %s, %s, 'ready')
               RETURNING id""",
            (other, ext(2), other_offer),
        )
        other_pid = cur.fetchone()[0]
        owner.commit()
    build(world)
    with _app() as conn:
        gate_mod.run_gate(conn, allow_foreign=True)
    before = fetch("SELECT * FROM product WHERE id = %s", other_pid)
    monkeypatch.setenv(publish_mod.FOREIGN_APPROVAL_ENV, "true")
    with _app() as conn:
        counts = publish_mod.publish_ready(
            conn, policies=POLICIES, limit=10, merchant_id=m, allow_foreign=True
        )
    assert counts.published == 1 and counts.held == {}
    assert fetch("SELECT * FROM product WHERE id = %s", other_pid) == before
    assert fetch("SELECT product_id FROM offer WHERE id = %s", other_offer) == [(None,)]


def test_unpublish_resets_foreign_offer_count(world, monkeypatch):
    m = world[SLUG]
    with _owner() as owner, owner.cursor() as cur:
        offer_id = add_offer(cur, m, 1, currency="USD")
        owner.commit()
    build(world)
    monkeypatch.setenv(publish_mod.FOREIGN_APPROVAL_ENV, "true")
    with _app() as conn:
        gate_mod.run_gate(conn, allow_foreign=True)
        publish_mod.publish_ready(conn, policies=POLICIES, limit=5, allow_foreign=True)
    (pid,) = fetch("SELECT id FROM product WHERE source_offer_id = %s", offer_id)[0]
    assert fetch("SELECT foreign_offer_count FROM product WHERE id = %s", pid) == [(1,)]
    with _app() as conn:
        assert publish_mod.unpublish(conn, [pid]) == 1
    assert fetch(
        "SELECT publication_state, foreign_offer_count FROM product WHERE id = %s", pid
    ) == [("ready", 0)]
    assert fetch("SELECT refresh_product_aggregates(ARRAY[%s]::bigint[])", pid) == [(0,)]
