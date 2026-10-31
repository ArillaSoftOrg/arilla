"""Kaynak ust esleme ile ust kategori yazimi (karar 0161).

Birim testler veritabanisiz; entegrasyon testleri gercek PostgreSQL ile (kurulum SAHIP rolle,
is UYGULAMA rolu baglantisiyla). Kosular test magazasiyla sinirlidir.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest

from classify import parent_apply as parent_mod
from classify import run as run_mod
from classify.dynamic import ACTIVE_VERSION_BUMP
from classify.suggest.finalize import MAP_FILE, load_source_map
from classify.taxonomy import RULE_VERSION
from db.connection import database_url

SLUG = "test-cls-par"
OTHER_SLUG = "test-cls-par-other"

SRC_A = "Home & Garden > Kitchen"
SRC_B = "Consumer Electronics > Gadgets"
SRC_REVIEW = "Mixed > Review Me"
SRC_NOMATCH = "Special Occasion > Not A Product"
SRC_UNKNOWN = "Brand New > Source Path"


# --- birim testler (veritabanisiz) ---------------------------------------------------------


def test_parent_rule_version_is_separate_from_v5_and_dynamic() -> None:
    assert run_mod.PARENT_RULE_VERSION > RULE_VERSION + ACTIVE_VERSION_BUMP


def test_owned_selection_excludes_parent_rule_version() -> None:
    assert f"pc.rule_version <> {run_mod.PARENT_RULE_VERSION}" in run_mod.SELECT_OWNED


def test_real_map_targets_are_only_high_confidence_rows() -> None:
    targets, full = parent_mod.load_parent_targets(MAP_FILE)
    assert targets, "harita bos"
    assert len(targets) == sum(1 for v in full.values() if v.state == "yuksek")
    assert all(full[k].path == v for k, v in targets.items())
    assert all(full[k].state == "yuksek" for k in targets)


def test_classify_source_reasons(tmp_path: Path) -> None:
    path = tmp_path / "map.tsv"
    path.write_text(_map_text("ev-yasam/mutfak", "elektronik/telefon"), encoding="utf-8")
    targets, full = parent_mod.load_parent_targets(path)
    assert parent_mod.classify_source(SRC_A, targets, full) == ("ev-yasam/mutfak", "parent")
    assert parent_mod.classify_source(SRC_REVIEW, targets, full) == (None, "review")
    assert parent_mod.classify_source(SRC_NOMATCH, targets, full) == (None, "unmatched")
    assert parent_mod.classify_source(SRC_UNKNOWN, targets, full) == (None, "unknown")
    assert parent_mod.classify_source(None, targets, full) == (None, "no_source")
    assert parent_mod.classify_source("", targets, full) == (None, "no_source")
    # Anahtar katlanir: buyuk/kucuk harf ve ayirac fark etmez.
    assert parent_mod.classify_source("home & garden/KITCHEN", targets, full)[1] == "parent"


def test_real_map_loads_without_duplicates() -> None:
    assert len(load_source_map(MAP_FILE)) >= 200


def _map_text(path_a: str, path_b: str) -> str:
    return "\n".join(
        [
            "# test haritasi",
            f"{SRC_A}\tyuksek\t{path_a}\t\ttest",
            f"{SRC_B}\tyuksek\t{path_b}\t\ttest",
            f"{SRC_REVIEW}\tinceleme\t\tev-yasam\ttest",
            f"{SRC_NOMATCH}\teslesmedi\t\t\ttest",
        ]
    )


# --- entegrasyon testleri ------------------------------------------------------------------

#: (anahtar, kaynak yolu, yayin durumu, magaza)
PRODUCTS = (
    ("a_pub", SRC_A, "published", SLUG),
    ("a_draft", SRC_A, "draft", SLUG),
    ("b_draft", SRC_B, "draft", SLUG),
    ("review", SRC_REVIEW, "draft", SLUG),
    ("nomatch", SRC_NOMATCH, "draft", SLUG),
    ("unknown", SRC_UNKNOWN, "draft", SLUG),
    ("nosrc", None, "draft", SLUG),
    ("manual", SRC_A, "published", SLUG),
    ("other", SRC_A, "draft", OTHER_SLUG),
)


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


CLEANUP = (
    """DELETE FROM search_outbox WHERE entity = 'product' AND entity_id IN (
        SELECT id FROM product WHERE source_merchant_id IN
            (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s)))""",
    """UPDATE offer SET product_id = NULL WHERE merchant_id IN
        (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))""",
    """DELETE FROM product WHERE source_merchant_id IN
        (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))""",
    """DELETE FROM category_source_map WHERE merchant_id IN
        (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))""",
    "DELETE FROM product_classification_state WHERE scope LIKE 'merchant:test-cls-par%%'",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))",
    "DELETE FROM merchant WHERE slug = ANY(%(slugs)s)",
)


def _cleanup(cur: psycopg.Cursor) -> None:
    for statement in CLEANUP:
        cur.execute(statement, {"slugs": [SLUG, OTHER_SLUG]})


def _insert_product(cur: psycopg.Cursor, mid: int, slug: str, key: str, source, state, n) -> int:
    ext = f"{9_200_000_000 + n}"
    cur.execute(
        """INSERT INTO offer (merchant_id, external_id, url, title_raw, category_raw, image_url,
                              current_price, currency)
           VALUES (%s, %s, %s, %s, %s, %s, 1999, 'USD') RETURNING id""",
        (
            mid,
            ext,
            f"https://{slug}.example/item/{ext}",
            f"Item {key}",
            source,
            f"https://img.{slug}.example/{ext}.jpg",
        ),
    )
    oid = int(cur.fetchone()[0])  # type: ignore[index]
    cur.execute(
        """INSERT INTO product (slug, title, primary_image_url, source_merchant_id,
                                source_external_id, source_offer_id, publication_state,
                                published_at, min_price)
           VALUES (%s, %s, %s, %s, %s, %s, %s, CASE WHEN %s = 'published' THEN now() END, 5000)
           RETURNING id""",
        (
            f"test-cls-par-{key}",
            f"Item {key}",
            f"https://img.{slug}.example/{ext}.jpg",
            mid,
            ext,
            oid,
            state,
            state,
        ),
    )
    return int(cur.fetchone()[0])  # type: ignore[index]


@pytest.fixture
def world(tmp_path: Path) -> Iterator[dict[str, object]]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            _cleanup(cur)
            cur.execute(
                "SELECT id, path FROM category WHERE parent_id IS NOT NULL ORDER BY id LIMIT 2"
            )
            cats = cur.fetchall()
            if len(cats) < 2:  # pragma: no cover
                pytest.skip("kategori agaci yok")
            (cat_a, path_a), (cat_b, path_b) = cats
            mids: dict[str, int] = {}
            for slug in (SLUG, OTHER_SLUG):
                cur.execute(
                    """INSERT INTO merchant (slug, name, domain, source_type, is_active)
                       VALUES (%s, %s, %s, 'xml_feed', TRUE) RETURNING id""",
                    (slug, f"Test {slug}", f"{slug}.example"),
                )
                mids[slug] = int(cur.fetchone()[0])  # type: ignore[index]
            ids: dict[str, object] = {"cat_a": int(cat_a), "cat_b": int(cat_b)}
            for n, (key, source, state, slug) in enumerate(PRODUCTS):
                ids[key] = _insert_product(cur, mids[slug], slug, key, source, state, n)
            # Elle girilmis kategori: ezilmemeli.
            cur.execute("UPDATE product SET category_id = %s WHERE id = %s", (cat_b, ids["manual"]))
        owner.commit()
        map_path = tmp_path / "map.tsv"
        map_path.write_text(_map_text(str(path_a), str(path_b)), encoding="utf-8")
        ids["map"] = map_path
        ids["merchant"] = mids[SLUG]
        yield ids
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()


def _apply(world: dict[str, object], **kwargs) -> parent_mod.ParentCounts:
    with _app() as conn:
        return parent_mod.apply_parents(
            conn,
            merchant_slug=SLUG,
            map_path=world["map"],
            **kwargs,  # type: ignore[arg-type]
        )


def _category(pid: object) -> int | None:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute("SELECT category_id FROM product WHERE id = %s", (pid,))
        return cur.fetchone()[0]  # type: ignore[index]


def _classification(pid: object) -> tuple | None:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT rule_version, state, category_basis, wrote_category, wrote_brand, detail
                 FROM product_classification WHERE product_id = %s""",
            (pid,),
        )
        return cur.fetchone()


@pytest.mark.integration
def test_writes_only_high_confidence_parents_and_keeps_everything_else(world) -> None:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM search_outbox")
        outbox_before = int(cur.fetchone()[0])  # type: ignore[index]
    counts = _apply(world)
    assert counts.completed and counts.category_set == 3 and counts.errors == 0
    # Kategorisiz kalanlar: inceleme, eslesmedi, haritada olmayan, kaynaksiz.
    assert counts.review == 4
    assert dict(counts.reasons) == {
        "parent": 3,
        "review": 1,
        "unmatched": 1,
        "unknown": 1,
        "no_source": 1,
    }
    assert _category(world["a_pub"]) == world["cat_a"]
    assert _category(world["a_draft"]) == world["cat_a"]
    assert _category(world["b_draft"]) == world["cat_b"]
    for key in ("review", "nomatch", "unknown", "nosrc"):
        assert _category(world[key]) is None, key
        assert _classification(world[key]) is None, key
    # Mevcut deger ezilmez; baska magaza dokunulmaz.
    assert _category(world["manual"]) == world["cat_b"]
    assert _classification(world["manual"]) is None
    assert _category(world["other"]) is None
    assert _classification(world["a_pub"]) == (
        run_mod.PARENT_RULE_VERSION,
        "applied",
        "source",
        True,
        False,
        "source_parent",
    )
    with _owner() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM search_outbox")
        # Yalniz YAYINDAKI yazilan urun icin arama kaydi (taslak gorunmez).
        assert int(cur.fetchone()[0]) - outbox_before == 1  # type: ignore[index]
        cur.execute(
            """SELECT last_product_id, category_set, completed_at IS NOT NULL
                 FROM product_classification_state WHERE rule_version = %s AND scope = %s""",
            (run_mod.PARENT_RULE_VERSION, f"merchant:{SLUG}"),
        )
        last, written, completed = cur.fetchone()  # type: ignore[misc]
        assert written == 3 and completed and last >= world["nosrc"]


@pytest.mark.integration
def test_rerun_is_idempotent_and_picks_up_new_products_after_cursor(world) -> None:
    _apply(world)
    again = _apply(world)
    assert again.category_set == 0 and again.errors == 0
    # Sonradan gelen (daha buyuk kimlikli) urun ayni komutla kapsanir.
    with _owner() as conn, conn.cursor() as cur:
        pid = _insert_product(cur, world["merchant"], SLUG, "late", SRC_B, "draft", 90)  # type: ignore[arg-type]
        conn.commit()
    later = _apply(world)
    assert later.category_set == 1 and later.scanned == 1
    assert _category(pid) == world["cat_b"]


@pytest.mark.integration
def test_resumes_from_checkpoint_with_small_batches(world) -> None:
    first = _apply(world, batch_size=2, max_batches=1)
    assert first.batches == 1 and not first.completed
    rest = _apply(world, batch_size=2)
    assert rest.completed
    assert _category(world["a_pub"]) == world["cat_a"]
    assert _category(world["b_draft"]) == world["cat_b"]
    assert first.category_set + rest.category_set == 3


@pytest.mark.integration
def test_v5_products_run_and_owned_only_never_revert_parent_writes(world) -> None:
    _apply(world)
    with _app() as conn:
        run_mod.classify_products(conn, merchant_slug=SLUG, rescan=True)
    with _app() as conn:
        run_mod.classify_products(conn, merchant_slug=SLUG, owned_only=True)
    assert _category(world["a_pub"]) == world["cat_a"]
    assert _classification(world["a_pub"]) == (
        run_mod.PARENT_RULE_VERSION,
        "applied",
        "source",
        True,
        False,
        "source_parent",
    )


@pytest.mark.integration
def test_concurrent_category_write_is_never_overwritten(world, monkeypatch) -> None:
    real = parent_mod._process_batch

    def racing(conn, rows, targets, full, ids):
        # Okuma ile yazma arasinda baska bir yazar a_draft'a kategori yazar ve kaydeder.
        with _owner() as owner, owner.cursor() as cur:
            cur.execute(
                "UPDATE product SET category_id = %s WHERE id = %s",
                (world["cat_b"], world["a_draft"]),
            )
            owner.commit()
        return real(conn, rows, targets, full, ids)

    monkeypatch.setattr(parent_mod, "_process_batch", racing)
    counts = _apply(world)
    assert _category(world["a_draft"]) == world["cat_b"]
    assert _classification(world["a_draft"]) is None
    assert counts.errors == 1 and counts.category_set == 2


@pytest.mark.integration
def test_undo_reverts_only_own_unchanged_writes(world) -> None:
    _apply(world)
    with _owner() as owner:
        with owner.cursor() as cur:
            # Sonradan baska yazar b_draft'in kategorisini degistirdi: geri alma dokunmaz.
            cur.execute(
                "UPDATE product SET category_id = %s WHERE id = %s",
                (world["cat_a"], world["b_draft"]),
            )
        owner.commit()
    with _app() as conn:
        counts = parent_mod.undo_parents(conn)
    assert counts.completed and counts.category_set == 2
    assert _category(world["a_pub"]) is None
    assert _category(world["a_draft"]) is None
    assert _category(world["b_draft"]) == world["cat_a"]
    assert _category(world["manual"]) == world["cat_b"]
    after = _classification(world["a_pub"])
    assert after is not None and after[3] is False and after[5] == "source_parent_undone"
    # Geri alma ikinci kez calisinca bir sey bulmaz.
    with _app() as conn:
        assert parent_mod.undo_parents(conn).scanned == 0


@pytest.mark.integration
def test_missing_category_path_aborts_before_any_write(world, tmp_path: Path) -> None:
    bad = tmp_path / "bad.tsv"
    bad.write_text(_map_text("yok/boyle-bir-yol", "yok/baska-yol"), encoding="utf-8")
    with _app() as conn, pytest.raises(run_mod.ClassifyAborted) as raised:
        parent_mod.apply_parents(conn, merchant_slug=SLUG, map_path=bad)
    assert raised.value.code == "category_missing"
    assert _category(world["a_pub"]) is None


@pytest.mark.integration
def test_refuses_to_start_while_catalog_build_runs(world, monkeypatch) -> None:
    monkeypatch.setattr(parent_mod, "BUSY_CATALOG_BUILD", "SELECT 1")
    with _app() as conn, pytest.raises(run_mod.ClassifyAborted) as raised:
        parent_mod.apply_parents(conn, merchant_slug=SLUG, map_path=world["map"])  # type: ignore[arg-type]
    assert raised.value.code == "catalog_build_running"
    assert _category(world["a_pub"]) is None


@pytest.mark.integration
def test_wal_throttle_stops_before_writing_and_resumes(world) -> None:
    stopped = _apply(world, throttle=lambda: False)
    assert stopped.stopped_reason == "wal" and stopped.batches == 0
    assert _category(world["a_pub"]) is None
    resumed = _apply(world)
    assert resumed.completed and resumed.category_set == 3


@pytest.mark.integration
def test_report_is_read_only_and_matches_what_apply_writes(world) -> None:
    with _app() as conn:
        conn.read_only = True
        rows = parent_mod.report(conn, merchant_slug=SLUG, map_path=world["map"])  # type: ignore[arg-type]
    by_reason: dict[str, int] = {}
    for r in rows:
        by_reason[r.reason] = by_reason.get(r.reason, 0) + r.products
    assert by_reason == {"parent": 3, "review": 1, "unmatched": 1, "unknown": 1, "no_source": 1}
    assert _category(world["a_pub"]) is None  # hicbir sey yazilmadi
    counts = _apply(world)
    assert counts.category_set == by_reason["parent"]
