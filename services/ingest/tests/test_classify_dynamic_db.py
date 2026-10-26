"""Dinamik kategori kapsami ve siniflandirma entegrasyonu (karar 0154): gercek PostgreSQL.

Kurulum SAHIP rolle; kapsam yonetimi ve siniflandirma UYGULAMA rolu baglantisiyla (uretimdeki gibi).
Dogrulananlar: varsayilan V5 davranisi aynen, kapsam olmadan dinamik motor yok, kapsam yalniz
Trendyol'dan olusturulmus dugumlere verilir ve denetim izi birakir, etkin kapsamda yalniz
INCELTME yapilir, elle/besleme kategorisi korunur, kural surumu ayri, geri donus, karsilastirma
yalniz okur.
"""

from __future__ import annotations

import json
from collections.abc import Iterator

import psycopg
import pytest

from classify import compare as compare_mod
from classify import run as run_mod
from classify import scope as scope_mod
from classify.__main__ import main as cli
from classify.taxonomy import RULE_VERSION
from db.connection import database_url

pytestmark = pytest.mark.integration

SLUG = "test-dyn-src"
PHONE_PARTS = "Phones & Telecommunications > Mobile Phone Parts"
LAPTOP_PARTS = "Computer & Office > Laptop Parts & Accessories"
SCOPE_ELEKTRONIK = "elektronik/elektronik-aksesuarlar"
SCOPE_GIYIM = "giyim"
BATTERY_LEAF = (
    "elektronik/elektronik-aksesuarlar/cep-telefonu-aksesuarlari/"
    "cep-telefonu-yedek-parcalari/telefon-bataryasi"
)
LAPTOP_LEAF = (
    "elektronik/elektronik-aksesuarlar/bilgisayar-aksesuarlari/notebook-aksesuarlari/"
    "notebook-koruyucu"
)
V5_PHONE = "elektronik/telefon/aksesuar"
BATTERY_TITLE = "Original High Quality 2700mAh Mobile Phone Replacement Battery For Huawei"
LAPTOP_TITLE = "Protective For Huawei Matebook 16S 14S 13S Laptop Hard PVC Matte Case Waterproof"

#: (anahtar, baslik, kaynak yolu)
PRODUCTS = (
    ("batt", BATTERY_TITLE, PHONE_PARTS),
    ("laptop", LAPTOP_TITLE, LAPTOP_PARTS),
    ("plain", "Premium Quality Item 2024 New Arrival", PHONE_PARTS),
    ("manual", BATTERY_TITLE + " Manual", PHONE_PARTS),
)


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


_MERCHANT = "(SELECT id FROM merchant WHERE slug = %s)"
CLEANUP = (
    f"UPDATE offer SET product_id = NULL WHERE merchant_id = {_MERCHANT}",
    f"DELETE FROM product WHERE source_merchant_id = {_MERCHANT}",
    f"DELETE FROM category_source_map WHERE merchant_id = {_MERCHANT}",
    f"DELETE FROM offer WHERE merchant_id = {_MERCHANT}",
    "DELETE FROM merchant WHERE slug = %s",
)


def _cleanup(cur: psycopg.Cursor) -> None:
    for statement in CLEANUP:
        cur.execute(statement, (SLUG,))
    cur.execute("DELETE FROM product_classification_state WHERE scope = %s", (f"merchant:{SLUG}",))


@pytest.fixture
def world() -> Iterator[dict[str, int]]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            _cleanup(cur)
            cur.execute("SELECT scope_category_id, mode FROM classifier_scope")
            scopes_before = cur.fetchall()
            cur.execute("SELECT coalesce(max(id), 0) FROM job_run")
            job_before = int(cur.fetchone()[0])  # type: ignore[index]
            cur.execute("DELETE FROM classifier_scope")
            cur.execute(
                """INSERT INTO merchant (slug, name, domain, source_type, is_active)
                   VALUES (%s, 'Test Dyn Kaynak', %s, 'xml_feed', TRUE) RETURNING id""",
                (SLUG, f"{SLUG}.example"),
            )
            mid = int(cur.fetchone()[0])  # type: ignore[index]
            cur.execute("SELECT id FROM category WHERE path = 'ev-yasam/mutfak'")
            mutfak = int(cur.fetchone()[0])  # type: ignore[index]
            ids: dict[str, int] = {"merchant": mid, "mutfak": mutfak}
            for n, (key, title, source) in enumerate(PRODUCTS):
                ext = f"{9_300_000_000 + n}"
                cur.execute(
                    """INSERT INTO offer (merchant_id, external_id, url, title_raw, category_raw,
                                          image_url, current_price, currency)
                       VALUES (%s, %s, %s, %s, %s, %s, 1999, 'USD') RETURNING id""",
                    (mid, ext, f"https://{SLUG}.example/{ext}", title, source, f"https://i/{ext}"),
                )
                oid = int(cur.fetchone()[0])  # type: ignore[index]
                cur.execute(
                    """INSERT INTO product (slug, title, primary_image_url, source_merchant_id,
                                            source_external_id, source_offer_id,
                                            publication_state, min_price)
                       VALUES (%s, %s, %s, %s, %s, %s, 'draft', 5000) RETURNING id""",
                    (f"test-dyn-{key}", title, f"https://i/{ext}", mid, ext, oid),
                )
                ids[key] = int(cur.fetchone()[0])  # type: ignore[index]
            cur.execute(
                "UPDATE product SET category_id = %s WHERE id = %s", (mutfak, ids["manual"])
            )
        owner.commit()
        yield ids
        with owner.cursor() as cur:
            _cleanup(cur)
            cur.execute("DELETE FROM classifier_scope")
            for category_id, mode in scopes_before:
                cur.execute(
                    """INSERT INTO classifier_scope (scope_category_id, mode, decided_by)
                       VALUES (%s, %s, 'test-restore')""",
                    (category_id, mode),
                )
            cur.execute(
                "DELETE FROM job_run WHERE job = 'classify_scope' AND id > %s", (job_before,)
            )
        owner.commit()


def _category_of(key: str, ids: dict[str, int]) -> str | None:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT c.path FROM product p LEFT JOIN category c ON c.id = p.category_id
                WHERE p.id = %s""",
            (ids[key],),
        )
        row = cur.fetchone()
    return row[0] if row else None


def _classification(ids: dict[str, int], key: str) -> tuple | None:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT state, category_basis, rule_version, wrote_category
                 FROM product_classification WHERE product_id = %s""",
            (ids[key],),
        )
        return cur.fetchone()


def _run(**kwargs: object) -> run_mod.Counts:
    with _app() as conn:
        return run_mod.classify_products(conn, merchant_slug=SLUG, **kwargs)  # type: ignore[arg-type]


def _enable(*paths: str) -> None:
    with _app() as conn:
        for path in paths:
            scope_mod.set_scope(
                conn, path, "apply", by="test-ops", reason="dinamik motor testi icin acildi"
            )


# --------------------------------------------------------------------------
# Varsayilan: V5 ayni, kapsam yok = motor yok
# --------------------------------------------------------------------------


def test_varsayilan_v5_davranisi_ve_bos_kapsam(world: dict[str, int]) -> None:
    with _app() as conn:
        assert scope_mod.list_scopes(conn) == []
        assert run_mod.active_scopes(conn) == []
        assert run_mod.active_rule_version(conn, dynamic=True) == RULE_VERSION
        catalog = run_mod.Catalog(conn, dynamic=True)  # bayrak acik ama kapsam YOK
        assert catalog.dynamic is None and catalog.rule_version == RULE_VERSION
    _run()
    assert _category_of("batt", world) == V5_PHONE  # V5: kaynak-yalniz kaba dal
    assert _category_of("manual", world) == "ev-yasam/mutfak"  # elle deger korunur
    assert _classification(world, "batt") == ("applied", "source", RULE_VERSION, True)
    assert _classification(world, "laptop")[0] == "review"  # type: ignore[index]
    # Etkin kapsam VAR ama `--dynamic` verilmediyse yine V5.
    _enable(SCOPE_ELEKTRONIK)
    with _app() as conn:
        assert run_mod.active_rule_version(conn, dynamic=False) == RULE_VERSION
        assert run_mod.Catalog(conn, dynamic=False).dynamic is None


# --------------------------------------------------------------------------
# Kapsam yonetimi: yalniz Trendyol dugumleri, denetim izi, dogrulamalar
# --------------------------------------------------------------------------


def test_kapsam_yalniz_trendyol_dugumlerine_verilir_ve_denetim_izi_birakir(
    world: dict[str, int],
) -> None:
    with _app() as conn:
        for bad_path in ("moda", "moda/kadin-giyim", "ev-yasam/mutfak", "yok/boyle/bir/yol"):
            with pytest.raises(scope_mod.ScopeError, match="OLUSTURULMUS"):
                scope_mod.set_scope(conn, bad_path, "apply", by="ops-test", reason="x" * 20)
        with pytest.raises(scope_mod.ScopeError, match="--reason"):
            scope_mod.set_scope(conn, SCOPE_ELEKTRONIK, "apply", by="ops-test", reason="kisa")
        with pytest.raises(scope_mod.ScopeError, match="--by"):
            scope_mod.set_scope(conn, SCOPE_ELEKTRONIK, "apply", by="x", reason="x" * 20)
        with pytest.raises(scope_mod.ScopeError, match="--mode"):
            scope_mod.set_scope(conn, SCOPE_ELEKTRONIK, "hepsi", by="ops-test", reason="x" * 20)
        assert scope_mod.list_scopes(conn) == []

        row = scope_mod.set_scope(
            conn, SCOPE_ELEKTRONIK, "apply", by="ops-test", reason="elektronik dali icin denendi"
        )
        assert (row.path, row.mode, row.decided_by) == (SCOPE_ELEKTRONIK, "apply", "ops-test")
        assert row.nodes > 20  # kendisi + altindaki Trendyol kategorileri
        assert run_mod.active_scopes(conn) == [SCOPE_ELEKTRONIK]
        scope_mod.set_scope(
            conn, SCOPE_ELEKTRONIK, "off", by="ops-test", reason="geri alindi, denemesi bitti"
        )
        assert run_mod.active_scopes(conn) == []  # `off`: satir kalir, etkinlik gider
        assert [r.mode for r in scope_mod.list_scopes(conn)] == ["off"]
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT detail ->> 'path', detail ->> 'mode', detail ->> 'by', detail ->> 'reason'
                 FROM job_run WHERE job = 'classify_scope' ORDER BY id DESC LIMIT 2"""
        )
        assert cur.fetchall() == [
            (SCOPE_ELEKTRONIK, "off", "ops-test", "geri alindi, denemesi bitti"),
            (SCOPE_ELEKTRONIK, "apply", "ops-test", "elektronik dali icin denendi"),
        ]


def test_trendyol_kapsam_secenekleri_yalniz_olusturulmus_en_ust_dugumler(
    world: dict[str, int],
) -> None:
    with _app() as conn:
        scopes = scope_mod.trendyol_scopes(conn)
    assert SCOPE_ELEKTRONIK in scopes and SCOPE_GIYIM in scopes
    assert "moda" not in scopes and "elektronik" not in scopes  # mevcut 158'in koklari degil
    assert not any(s.startswith("giyim/") for s in scopes)  # alt dallar ust dugumun icinde


# --------------------------------------------------------------------------
# Etkin kapsamda inceltme; elle deger, besleme degeri ve geri donus
# --------------------------------------------------------------------------


def test_etkin_kapsamda_yalniz_inceltir_digerlerine_dokunmaz(world: dict[str, int]) -> None:
    _enable(SCOPE_ELEKTRONIK)
    counts = _run(dynamic=True)
    assert counts.errors == 0
    assert _category_of("batt", world) == BATTERY_LEAF  # V5 kaba dal -> daha derin Trendyol yaprak
    assert _category_of("laptop", world) == LAPTOP_LEAF  # V5 inceleme -> yazildi (siki esik)
    assert _category_of("plain", world) == V5_PHONE  # baslik kanitlamiyor: V5 kalir
    assert _category_of("manual", world) == "ev-yasam/mutfak"  # elle deger KORUNUR
    assert _classification(world, "batt") == ("applied", "source_title", RULE_VERSION + 1, True)
    assert _classification(world, "plain")[2] == RULE_VERSION + 1  # type: ignore[index]
    with _owner() as conn, conn.cursor() as cur:
        # Dinamik kosunun kontrol noktasi V5'ten AYRI (kural surumu + 1).
        cur.execute(
            "SELECT rule_version FROM product_classification_state WHERE scope = %s",
            (f"merchant:{SLUG}",),
        )
        assert [int(r[0]) for r in cur.fetchall()] == [RULE_VERSION + 1]


def test_kapsam_disindaki_dallara_yazilmaz(world: dict[str, int]) -> None:
    _enable(SCOPE_GIYIM)  # elektronik kapsami KAPALI
    _run(dynamic=True)
    assert _category_of("batt", world) == V5_PHONE  # yazilmadi: V5 kaldi
    assert _classification(world, "laptop")[0] == "review"  # type: ignore[index]


def test_kapsam_kapatilinca_ve_sahip_olunanlar_yeniden_karar_alinca_v5ye_donulur(
    world: dict[str, int],
) -> None:
    _enable(SCOPE_ELEKTRONIK)
    _run(dynamic=True)
    assert _category_of("batt", world) == BATTERY_LEAF
    with _app() as conn:
        scope_mod.set_scope(
            conn, SCOPE_ELEKTRONIK, "off", by="ops-test", reason="geri donus denemesi yapildi"
        )
    # Bu isin yazdigi degerler (owned-only) V5 ile yeniden karar alir: geri alma yolu.
    _run(owned_only=True)
    assert _category_of("batt", world) == V5_PHONE
    assert _category_of("manual", world) == "ev-yasam/mutfak"


def test_dry_run_hicbir_sey_yazmaz(world: dict[str, int]) -> None:
    _enable(SCOPE_ELEKTRONIK, SCOPE_GIYIM)
    with _app() as conn:
        counts = run_mod.classify_products(conn, merchant_slug=SLUG, dry_run=True, dynamic=True)
    assert counts.scanned >= 3
    assert _category_of("batt", world) is None  # hicbir sey yazilmadi
    assert _classification(world, "batt") is None


# --------------------------------------------------------------------------
# Karsilastirma: yalnizca okur
# --------------------------------------------------------------------------


def _state(ids: dict[str, int]) -> list[tuple]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, category_id FROM product WHERE source_merchant_id = %s ORDER BY id",
            (ids["merchant"],),
        )
        products = cur.fetchall()
        cur.execute("SELECT count(*) FROM product_classification")
        classified = cur.fetchone()
        cur.execute("SELECT count(*) FROM category_source_map")
        mapped = cur.fetchone()
    return [*products, classified, mapped]


def test_karsilastirma_yalnizca_okur_ve_iki_karari_yan_yana_verir(world: dict[str, int]) -> None:
    before = _state(world)
    with _app() as conn:
        result = compare_mod.compare(
            conn, n=10, mode="first", merchant_slug=SLUG, scopes=[SCOPE_ELEKTRONIK]
        )
    assert _state(world) == before  # hicbir sey yazilmadi
    by_id = {p.product_id: p for p in result.pairs}
    batt = by_id[world["batt"]]
    assert (batt.v5.category_path, batt.new.category_path, batt.kind) == (
        V5_PHONE,
        BATTERY_LEAF,
        "refine",
    )
    laptop = by_id[world["laptop"]]
    assert (laptop.v5.state, laptop.new.category_path, laptop.kind) == (
        "review",
        LAPTOP_LEAF,
        "gain",
    )
    assert by_id[world["plain"]].kind == "same"
    summary = result.summary()
    assert summary["lost"] == 0  # V5'te yazilan hicbir urun incelemeye dusmez
    assert summary["new_applied"] >= summary["v5_applied"]
    # Kapsam verilmezse tum Trendyol dallari simule edilir (yazma yetkisi VERMEZ).
    with _app() as conn:
        simulated = compare_mod.compare(conn, n=10, mode="first", merchant_slug=SLUG)
        assert len(simulated.scopes) >= 13 and run_mod.active_scopes(conn) == []
    text = compare_mod.tsv(result, only_changed=True)
    assert text.startswith("product_id\ttitle") and "refine" in text and "gain" in text


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def test_cli_scope_ve_compare(world: dict[str, int], capsys: pytest.CaptureFixture[str]) -> None:
    assert cli(["scope", "list"]) == 0
    assert "etkin kapsam yok" in capsys.readouterr().out
    base = ["scope", "set", "--path", SCOPE_ELEKTRONIK, "--mode", "apply", "--by", "ops-test"]
    # --confirm yok: yazmaz.
    assert cli([*base, "--reason", "elektronik dali icin deneniyor"]) == 0
    assert "yazilmadi" in capsys.readouterr().err
    with _app() as conn:
        assert scope_mod.list_scopes(conn) == []
    assert cli([*base, "--reason", "kisa", "--confirm"]) == 2
    assert "--reason" in capsys.readouterr().err
    baseline = ["scope", "set", "--path", "moda", "--mode", "apply", "--by", "ops-test"]
    assert cli([*baseline, "--reason", "baseline dugum acilmaz", "--confirm"]) == 2
    capsys.readouterr()
    assert cli([*base, "--reason", "elektronik dali icin deneniyor", "--confirm"]) == 0
    capsys.readouterr()
    assert cli(["scope", "list"]) == 0
    assert f"apply {SCOPE_ELEKTRONIK}" in capsys.readouterr().out
    compare_args = ["compare", "--n", "10", "--mode", "first", "--merchant", SLUG]
    assert cli([*compare_args, "--scope", SCOPE_ELEKTRONIK]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["n"] == 4 and out["refine"] >= 1 and out["gain"] >= 1 and out["lost"] == 0
