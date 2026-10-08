"""Yalnizca-gorsel galeri backfill'i: fiyat/stok/price_point'e dokunmaz (karar 0073)."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime

import psycopg
import pytest

from collect.gallery_backfill import apply_offer, plan_offer
from collect.images import SourceImage, select_images
from collect.mapping import FieldMapping
from collect.normalize import normalize
from collect.records import NormalizedOffer
from collect.sources.shopify import ShopifyConnector
from collect.writer import OfferWriter
from db.connection import database_url
from tests.test_shopify_images import CONFIG, _image, _product, _variant

pytestmark = pytest.mark.integration

DOMAIN = "test-gallery-backfill.example"
SLUG = "test-gallery-backfill"


def _cleanup(cur: psycopg.Cursor) -> None:
    cur.execute(
        "DELETE FROM price_point WHERE offer_id IN (SELECT o.id FROM offer o"
        " JOIN merchant m ON m.id = o.merchant_id WHERE m.domain = %s)",
        (DOMAIN,),
    )
    cur.execute(
        "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = %s)",
        (DOMAIN,),
    )
    cur.execute("DELETE FROM product WHERE slug LIKE %s", (f"{SLUG}-%",))
    cur.execute("DELETE FROM merchant WHERE domain = %s", (DOMAIN,))


@pytest.fixture
def env() -> Iterator[tuple[psycopg.Connection, int]]:
    try:
        owner = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            _cleanup(cur)
            cur.execute(
                "INSERT INTO merchant (slug, name, domain, source_type)"
                " VALUES (%s, 'Test', %s, 'shopify') RETURNING id",
                (SLUG, DOMAIN),
            )
            row = cur.fetchone()
        owner.commit()
        assert row is not None
        yield owner, int(row[0])
        owner.rollback()
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()


def _urls(*names: str) -> list[str]:
    return [f"https://cdn.example/{n}.jpg" for n in names]


def _offer(
    urls: list[str], *, price: int = 10000, in_stock: bool = True, ext: str = "p-1"
) -> NormalizedOffer:
    images = tuple(select_images([SourceImage(u, i + 1) for i, u in enumerate(urls)]))
    return NormalizedOffer(
        external_id=ext,
        url="https://shop.example/p",
        title_raw="Urun",
        current_price=price,
        list_price=None,
        in_stock=in_stock,
        currency="TRY",
        image_url=urls[0] if urls else None,
        images=images,
    )


def _ingest(conn, merchant_id: int, offer: NormalizedOffer, *, product: str | None = None) -> int:
    offer_id = OfferWriter(conn, merchant_id, datetime(2026, 10, 7, tzinfo=UTC)).write(offer)
    if product:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO product (slug, title, primary_image_url) VALUES (%s, 'U', %s)"
                " RETURNING id",
                (f"{SLUG}-{product}", offer.image_url),
            )
            row = cur.fetchone()
            assert row is not None
            cur.execute("UPDATE offer SET product_id = %s WHERE id = %s", (row[0], offer_id))
    conn.commit()
    return offer_id


def _state(conn, offer_id: int) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT current_price, in_stock, last_seen_at, image_url, image_hash, is_active,"
            " (SELECT count(*) FROM price_point WHERE offer_id = o.id),"
            " (SELECT count(*) FROM offer_variant WHERE offer_id = o.id),"
            " (SELECT primary_image_url FROM product WHERE id = o.product_id),"
            " (SELECT count(*) FROM offer_image WHERE offer_id = o.id)"
            " FROM offer o WHERE o.id = %s",
            (offer_id,),
        )
        row = cur.fetchone()
    assert row is not None
    keys = (
        "price",
        "in_stock",
        "last_seen",
        "image_url",
        "image_hash",
        "active",
        "price_points",
        "variants",
        "primary",
        "images",
    )
    return dict(zip(keys, row, strict=True))


def _backfill(conn, merchant_id: int, offer: NormalizedOffer):
    plan = plan_offer(conn, merchant_id, offer)
    apply_offer(conn, merchant_id, offer, plan)
    conn.commit()
    return plan


def _ranks(conn, offer_id: int) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT regexp_replace(source_url, '.*/', '') FROM offer_image WHERE offer_id = %s"
            " AND display_rank IS NOT NULL ORDER BY display_rank",
            (offer_id,),
        )
        return [r[0] for r in cur.fetchall()]


def test_image_only_backfill_writes_images_without_touching_price_stock_or_history(env) -> None:
    conn, mid = env
    oid = _ingest(conn, mid, _offer(_urls("flat")))
    before = _state(conn, oid)
    # kaynak artik baska fiyat/stok soyluyor: backfill bunlari YAZMAMALI
    new = _offer(_urls("m1", "m2", "m3", "m4", "flat"), price=99999, in_stock=False)
    plan = _backfill(conn, mid, new)
    after = _state(conn, oid)
    assert plan.inserts == 4
    assert after["images"] == 5
    for key in ("price", "in_stock", "last_seen", "price_points", "variants", "active"):
        assert after[key] == before[key], key


def test_primary_change_updates_only_image_fields(env) -> None:
    conn, mid = env
    oid = _ingest(conn, mid, _offer(_urls("flat")), product="b")
    before = _state(conn, oid)
    new = _offer(_urls("m1", "flat"), price=555)
    plan = _backfill(conn, mid, new)
    after = _state(conn, oid)
    assert plan.image_url_changes and plan.primary_changes
    assert after["image_url"] == "https://cdn.example/m1.jpg"
    assert after["primary"] == "https://cdn.example/m1.jpg"
    assert after["image_hash"] is None
    assert after["price"] == before["price"] and after["price_points"] == before["price_points"]
    assert _ranks(conn, oid)[0] == "m1.jpg"


def test_primary_image_curated_elsewhere_is_left_alone(env) -> None:
    conn, mid = env
    oid = _ingest(conn, mid, _offer(_urls("flat")), product="c")
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE product SET primary_image_url = 'https://cdn.example/curated.jpg'"
            " WHERE id = (SELECT product_id FROM offer WHERE id = %s)",
            (oid,),
        )
    conn.commit()
    plan = _backfill(conn, mid, _offer(_urls("m1", "flat")))
    assert plan.image_url_changes and not plan.primary_changes
    assert _state(conn, oid)["primary"] == "https://cdn.example/curated.jpg"


def test_second_run_is_a_noop(env) -> None:
    conn, mid = env
    oid = _ingest(conn, mid, _offer(_urls("flat")), product="d")
    new = _offer(_urls("m1", "m2", "m3", "flat"))
    _backfill(conn, mid, new)
    state = _state(conn, oid)
    plan = _backfill(conn, mid, new)
    assert (plan.inserts, plan.updates, plan.removals) == (0, 0, 0)
    assert not plan.image_url_changes and not plan.needs_write
    assert _state(conn, oid) == state  # price_point delta 0, hicbir alan degismedi


def test_dry_run_plan_writes_nothing(env) -> None:
    conn, mid = env
    oid = _ingest(conn, mid, _offer(_urls("flat")), product="e")
    before = _state(conn, oid)
    plan = plan_offer(conn, mid, _offer(_urls("m1", "m2", "flat")))
    conn.rollback()
    assert plan.needs_write and plan.inserts == 2 and plan.image_url_changes
    assert _state(conn, oid) == before


def test_stale_image_embedding_is_invalidated_only_when_image_changes(env) -> None:
    conn, mid = env
    oid = _ingest(conn, mid, _offer(_urls("flat")))
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO embedding (target_type, target_id, kind, model_version, vector)"
            " VALUES ('offer', %s, 'image', 'test-v1', array_fill(0.1::real, ARRAY[768])::vector)",
            (oid,),
        )
    conn.commit()
    same = _backfill(conn, mid, _offer(_urls("flat", "extra")))
    assert not same.image_url_changes
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM embedding WHERE target_id = %s", (oid,))
        assert cur.fetchone() == (1,)
    changed = _backfill(conn, mid, _offer(_urls("m1", "flat")))
    assert changed.image_url_changes and changed.has_image_embedding
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM embedding WHERE target_id = %s", (oid,))
        assert cur.fetchone() == (0,)


def test_colour_split_product_gets_only_its_own_colour_images(env) -> None:
    conn, mid = env
    images = [
        _image(1, "c-black-1", 1),
        _image(2, "c-black-2", 2),
        _image(3, "c-black-3", 3, [10]),
        _image(4, "c-beige-1", 4),
        _image(5, "c-beige-2", 5),
        _image(6, "c-beige-3", 6, [20]),
    ]
    product = _product(images, [_variant(10, "Siyah"), _variant(20, "Bej")])
    connector = ShopifyConnector(base_url="https://shop.example", config=CONFIG)
    mapping = FieldMapping.from_config(CONFIG)
    offers = [
        normalize(r, mapping) for r in connector._records_for_product(product, "option1", None)
    ]
    legacy = {
        o.external_id: replace(o, images=(), image_url=f"{o.image_url}?legacy") for o in offers
    }
    ids = {ext: _ingest(conn, mid, o) for ext, o in legacy.items()}
    for offer in offers:
        _backfill(conn, mid, offer)
    black, beige = (ids[o.external_id] for o in offers)
    assert _ranks(conn, black) == ["c-black-1.jpg", "c-black-2.jpg", "c-black-3.jpg"]
    assert _ranks(conn, beige) == ["c-beige-1.jpg", "c-beige-2.jpg", "c-beige-3.jpg"]
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM offer_image WHERE offer_id = %s AND source_url LIKE '%%beige%%'",
            (black,),
        )
        assert cur.fetchone() == (0,)


def test_offer_without_gallery_rows_keeps_legacy_fallback(env) -> None:
    conn, mid = env
    oid = _ingest(conn, mid, _offer(_urls("flat")))
    with conn.cursor() as cur:
        cur.execute("DELETE FROM offer_image WHERE offer_id = %s", (oid,))
    conn.commit()
    # kaynak gorsel vermiyorsa (images bos) backfill hicbir sey yazmaz, image_url korunur
    empty = replace(_offer(_urls("flat")), images=())
    plan = _backfill(conn, mid, empty)
    state = _state(conn, oid)
    assert not plan.needs_write
    assert state["images"] == 0 and state["image_url"] == "https://cdn.example/flat.jpg"


def test_unknown_offer_is_never_created(env) -> None:
    conn, mid = env
    plan = plan_offer(conn, mid, _offer(_urls("a"), ext="does-not-exist"))
    assert not plan.found
    apply_offer(conn, mid, _offer(_urls("a"), ext="does-not-exist"), plan)
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM offer WHERE merchant_id = %s", (mid,))
        assert cur.fetchone() == (0,)
