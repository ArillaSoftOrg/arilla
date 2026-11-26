"""Hepsiburada barkodu ve haftalik tazelik (karar 0220). Gercek PostgreSQL; sentetik kayit.

Regresyon seti (CLAUDE.md: eslestirme mantigi):
* ara depodaki barkod -> hb-merge -> `offer.attributes_raw.gtin` (14 hane, identity_policy)
* `catalog_build identity` yalniz `-p-` (varyant) urunune, yalniz gecerli ve tekil barkodu yazar
* baska magazanin (kaynak ilani olmayan) ayni barkodlu teklifi `resolve` ile HB urunune
  kesin kimlikle (method = gtin) baglanir; barkodsuz/kisitli barkodlu teklif baglanmaz
* kapi HB teklifini 8 gun taze sayar (eski 2 gun her HB urununu bayat yapiyordu)
"""

from __future__ import annotations

import json
from typing import Any

import psycopg
import pytest
from test_hb_catalog import (  # noqa: F401  (fixture)
    IMG,
    OTHER,
    _app,
    env,
    gate,
    hb_id,
    merge,
    one,
    products,
    publish,
)
from test_hb_catalog import build as hb_build
from test_hb_intake import _close, _new_run

from catalog_build import gate as gate_mod
from catalog_build import identity as identity_mod
from catalog_build.policy import POLICIES
from resolve.pipeline import resolve_offers

pytestmark = pytest.mark.integration


def with_check_digit(body: str) -> str:
    """GS1 kontrol basamagi (testte gecerli barkod uretmek icin)."""
    digits = [int(c) for c in body]
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(digits)))
    return body + str((10 - total % 10) % 10)


GTIN_A = with_check_digit("869050400001")  # 13 hane, TR oneki
GTIN_B = with_check_digit("869050400002")
GTIN_DUP = with_check_digit("869050400003")
GTIN_PM = with_check_digit("869050400004")
RESTRICTED = with_check_digit("200000000001")  # magaza ici (kisitli dolasim)


def add(
    owner: psycopg.Connection, run_id: int, code: str, *, gtin: str | None, kind: str = "p"
) -> None:
    with owner.cursor() as cur:
        cur.execute(
            """INSERT INTO catalog_intake_record
                   (run_id, external_id, title, url, price_minor, currency, in_stock, image_url,
                    gtin, source_observed_at)
               VALUES (%s, %s, %s, %s, 10000, 'TRY', TRUE, %s, %s, now())""",
            (
                run_id,
                code,
                f"Test barkod urunu numara {code}",
                f"https://www.hepsiburada.com/test-urun-{kind}-{code}",
                IMG.format(code),
                gtin,
            ),
        )


def gtin_of(owner: psycopg.Connection, code: str) -> str | None:
    row = one(
        owner,
        "SELECT gtin FROM product WHERE source_merchant_id = %s AND source_external_id = %s",
        hb_id(owner),
        code,
    )
    return row[0] if row else None


def identity(**kw: Any) -> identity_mod.IdentityCounts:
    with _app() as conn:
        return identity_mod.write_source_gtins(conn, merchant_slug="hepsiburada", **kw)


def _publish_all(owner: psycopg.Connection, run: int) -> None:
    _close(owner, run)
    assert merge(run).status == "success"
    hb_build()
    gate()
    publish()


# --------------------------------------------------------------------------- saf karar


def test_gtin_karari_saf() -> None:
    policy = POLICIES["hepsiburada"]
    kinds = frozenset({"p"})
    url_p = "https://www.hepsiburada.com/x-p-HBCV1"
    url_pm = "https://www.hepsiburada.com/x-pm-HBC1"
    a14 = GTIN_A.zfill(14)

    def decide(**kw: Any) -> tuple[str | None, str | None]:
        base = {
            "url": url_p,
            "raw_gtin": a14,
            "current": None,
            "same_in_source": 1,
            "policy": policy,
            "kinds": kinds,
        }
        return identity_mod.gtin_decision(**{**base, **kw})

    assert decide() == (a14, None)
    assert decide(url=url_pm) == (None, "not_variant_listing")
    assert decide(raw_gtin=RESTRICTED) == (None, "gtin_restricted")
    assert decide(raw_gtin="8690504000010") == (None, "gtin_invalid")  # kontrol basamagi yanlis
    assert decide(same_in_source=2) == (None, "gtin_ambiguous_in_source")
    assert decide(current=a14) == (None, None)
    assert decide(current=GTIN_B.zfill(14)) == (None, "gtin_changed")
    # Varyant duzeyinde olmayan kaynak (AliExpress): hicbir tur barkod yazdirmaz.
    assert identity_mod.gtin_kinds("aliexpress") == frozenset()
    assert identity_mod.gtin_kinds("hepsiburada") == frozenset({"p"})


# --------------------------------------------------------------------------- uctan uca


def test_barkod_birlestirmeden_urune_yalniz_gecerli_tekil_varyantta(
    env: psycopg.Connection,  # noqa: F811
) -> None:
    run = _new_run(env)
    add(env, run, "HBCVG0001", gtin=GTIN_A)
    add(env, run, "HBCVG0002", gtin=RESTRICTED)
    add(env, run, "HBCVG0003", gtin=GTIN_DUP)
    add(env, run, "HBCVG0004", gtin=GTIN_DUP)
    add(env, run, "HBCVG0005", gtin=None)
    add(env, run, "HBCG00006", gtin=GTIN_PM, kind="pm")
    _publish_all(env, run)

    stored = one(env, "SELECT attributes_raw->>'gtin' FROM offer WHERE external_id = 'HBCVG0001'")
    assert stored == (GTIN_A.zfill(14),)  # 14 haneye tamamlanmis, identity_policy'den gecmis
    # Kisitli barkod teklife hic yazilmaz (normalize: kimlik degil).
    assert one(
        env, "SELECT attributes_raw ? 'gtin' FROM offer WHERE external_id = 'HBCVG0002'"
    ) == (False,)

    dry = identity(dry_run=True)
    assert dry.written == 1 and gtin_of(env, "HBCVG0001") is None  # dry-run yazmaz

    first = identity()
    assert first.written == 1
    assert first.skipped["gtin_ambiguous_in_source"] == 2
    assert first.skipped["not_variant_listing"] == 1
    assert gtin_of(env, "HBCVG0001") == GTIN_A.zfill(14)
    assert gtin_of(env, "HBCVG0003") is None and gtin_of(env, "HBCVG0004") is None
    assert gtin_of(env, "HBCG00006") is None  # -pm- model: barkod varyanti tanimlamaz
    assert gtin_of(env, "HBCVG0005") is None

    again = identity()  # idempotent
    assert again.written == 0 and again.already == 1


def test_baska_magaza_teklifi_hb_urunune_barkodla_baglanir(
    env: psycopg.Connection,  # noqa: F811
) -> None:
    run = _new_run(env)
    add(env, run, "HBCVM0001", gtin=GTIN_A)
    add(env, run, "HBCVM0002", gtin=GTIN_B)
    _publish_all(env, run)
    identity()
    hb_product = one(
        env,
        "SELECT id FROM product WHERE source_merchant_id = %s AND source_external_id = 'HBCVM0001'",
        hb_id(env),
    )[0]

    with env.cursor() as cur:
        cur.execute(
            """INSERT INTO merchant (slug, name, domain, source_type, is_active)
               VALUES (%s, 'Diger', 'diger.example', 'xml_feed', TRUE) RETURNING id""",
            (OTHER,),
        )
        other = cur.fetchone()[0]  # type: ignore[index]
        offers: dict[str, int] = {}
        for ext, attrs in (
            ("same", {"gtin": GTIN_A.zfill(14)}),
            ("none", {}),
        ):
            cur.execute(
                """INSERT INTO offer (merchant_id, external_id, url, title_raw, image_url,
                                      current_price, currency, attributes_raw)
                   VALUES (%s, %s, %s, %s, %s, 9900, 'TRY', %s::jsonb) RETURNING id""",
                (
                    other,
                    f"test-hbc-{ext}",
                    f"https://diger.example/{ext}",
                    # Baslik bilerek farkli: bag baslik benzerligiyle degil barkodla kurulmali.
                    f"Tamamen baska bir ad {ext}",
                    IMG.format(ext),
                    json.dumps(attrs),
                ),
            )
            offers[ext] = cur.fetchone()[0]  # type: ignore[index]

    try:
        _resolve_and_check(env, other, offers, hb_product)
    finally:
        # match_candidate urune bagli: ortak temizlik urunu silebilsin.
        with env.cursor() as cur:
            cur.execute(
                "DELETE FROM match_candidate WHERE offer_id = ANY(%s)", (list(offers.values()),)
            )


def _resolve_and_check(
    env: psycopg.Connection,  # noqa: F811
    other: int,
    offers: dict[str, int],
    hb_product: int,
) -> None:
    with _app() as conn:
        resolve_offers(conn, merchant_id=other, create_missing=False)
        conn.commit()

    linked = one(env, "SELECT product_id FROM offer WHERE id = %s", offers["same"])[0]
    assert linked == hb_product
    method = one(
        env,
        "SELECT method, status FROM match_candidate WHERE offer_id = %s AND product_id = %s",
        offers["same"],
        hb_product,
    )
    assert method == ("gtin", "auto_accepted")
    # Barkodsuz teklif HB urunune baglanmaz (baslik farkli; kesin kimlik yok).
    assert one(env, "SELECT product_id FROM offer WHERE id = %s", offers["none"])[0] != hb_product


def test_kapi_hb_teklifini_haftalik_izinle_8_gun_taze_sayar(
    env: psycopg.Connection,  # noqa: F811
) -> None:
    run = _new_run(env)
    add(env, run, "HBCVF0001", gtin=None)
    add(env, run, "HBCVF0002", gtin=None)
    _close(env, run)
    merge(run)
    hb_build()
    with env.cursor() as cur:
        for code, days in (("HBCVF0001", 5), ("HBCVF0002", 9)):
            cur.execute(
                """UPDATE offer SET last_seen_at = now() - make_interval(days => %s)
                    WHERE external_id = %s""",
                (days, code),
            )
            cur.execute(
                """UPDATE feed_source_offer SET last_seen_at = now() - make_interval(days => %s)
                    WHERE offer_id = (SELECT id FROM offer WHERE external_id = %s)""",
                (days, code),
            )
    gate()
    got = products(env)
    assert got["HBCVF0001"][:2] == ("ready", None)  # 5 gun: eski 2 gun sinirinda bayatti
    assert got["HBCVF0002"][:2] == ("held", "stale_source_offer")
    # Acik --stale-days kaynak sinirini yalniz SIKILASTIRIR.
    with _app() as conn:
        gate_mod.run_gate(conn, stale_days=3)
    assert products(env)["HBCVF0001"][:2] == ("held", "stale_source_offer")
    with _app() as conn:
        gate_mod.run_gate(conn, stale_days=30)
    assert products(env)["HBCVF0002"][:2] == ("held", "stale_source_offer")
