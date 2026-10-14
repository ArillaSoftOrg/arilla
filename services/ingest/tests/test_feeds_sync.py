"""Besleme senkronizasyonu: veritabani uzerinde uctan uca (karar 0112).

Senkronizasyon UYGULAMA rolüyle (DATABASE_URL, arilla_app) calisir: yetkiler
de sinanir. Kurulum ve temizlik sahip rolle.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import psycopg
import pytest

from db.connection import database_url
from feeds import discovery
from feeds.network import DiscoveredFeed
from feeds.sync import FeedSync, SyncAborted, SyncSettings, _Crash
from resolve.pipeline import PENDING_OFFERS
from tests.feed_fixtures import AE_PROFILE, offer, write, yml

pytestmark = pytest.mark.integration

DOMAIN = "t0112-ali.test.invalid"
T0 = datetime(2026, 10, 14, 3, 0, tzinfo=UTC)


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"), autocommit=True)


def _cleanup(cur: psycopg.Cursor) -> None:
    cur.execute("SELECT id FROM merchant WHERE domain = %s", (DOMAIN,))
    row = cur.fetchone()
    feeds = "SELECT id FROM feed_source WHERE network = 'test0112'"
    if row:
        mid = row[0]
        offers = "SELECT id FROM offer WHERE merchant_id = %(m)s"
        cur.execute(
            f"DELETE FROM search_outbox WHERE entity = 'offer' AND entity_id IN ({offers})",
            {"m": mid},
        )
        cur.execute(f"DELETE FROM price_point WHERE offer_id IN ({offers})", {"m": mid})
        cur.execute(f"DELETE FROM offer_image WHERE offer_id IN ({offers})", {"m": mid})
        cur.execute(f"DELETE FROM feed_source_offer WHERE offer_id IN ({offers})", {"m": mid})
    cur.execute(f"DELETE FROM ingest_error WHERE feed_source_id IN ({feeds})")
    cur.execute(
        "DELETE FROM ingest_chunk WHERE snapshot_id IN "
        f"(SELECT id FROM source_snapshot WHERE feed_source_id IN ({feeds}))"
    )
    cur.execute(f"DELETE FROM ingest_run WHERE feed_source_id IN ({feeds})")
    if row:
        cur.execute("DELETE FROM offer WHERE merchant_id = %s", (row[0],))
        cur.execute("DELETE FROM seller WHERE merchant_id = %s", (row[0],))
    cur.execute(f"DELETE FROM source_snapshot WHERE feed_source_id IN ({feeds})")
    cur.execute("DELETE FROM feed_source WHERE network = 'test0112'")
    cur.execute("DELETE FROM merchant WHERE domain = %s", (DOMAIN,))


@dataclass
class Env:
    owner: psycopg.Connection
    app: psycopg.Connection
    merchant_id: int
    tmp: Path

    def feed(
        self, external_id: str = "6115:1", *, currency: str = "USD", config: dict | None = None
    ) -> int:
        with self.owner.cursor() as cur:
            cur.execute(
                """INSERT INTO feed_source
                       (network, external_id, merchant_id, status, format, currency, config)
                   VALUES ('test0112', %s, %s, 'active', 'xml', %s, %s::jsonb) RETURNING id""",
                (external_id, self.merchant_id, currency, json.dumps(config or AE_PROFILE)),
            )
            row = cur.fetchone()
        assert row
        return int(row[0])

    def run(
        self,
        feed_id: int,
        offers: list[dict],
        *,
        at: datetime = T0,
        name: str | None = None,
        truncate: bool = False,
        settings: SyncSettings | None = None,
        **kw: object,
    ):
        path = write(
            self.tmp / (name or f"f{feed_id}-{at:%j%H%M}-{len(offers)}.xml"),
            yml(offers, truncate=truncate),
        )
        sync = FeedSync(
            self.app,
            feed_id,
            source_path=path,
            observed_at=at,
            settings=settings or SyncSettings(chunk_size=10, pause_ms=0),
            sleep=lambda _s: None,
            **kw,
        )  # type: ignore[arg-type]
        return sync.run(force=True)

    def one(self, sql: str, params: object = None):
        with self.owner.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()


@pytest.fixture
def env(tmp_path: Path) -> Iterator[Env]:
    try:
        owner = _owner()
        app = psycopg.connect(database_url("DATABASE_URL"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner.cursor() as cur:
        _cleanup(cur)
        # USD besleme: dogrulama asamasi, merchant ETKIN DEGIL (karar 0112).
        cur.execute(
            """INSERT INTO merchant (slug, name, domain, source_type, is_active)
               VALUES ('t0112-ali', 'AliExpress (test)', %s, 'affiliate_network', FALSE)
               RETURNING id""",
            (DOMAIN,),
        )
        row = cur.fetchone()
    assert row
    try:
        yield Env(owner, app, int(row[0]), tmp_path)
    finally:
        app.rollback()
        app.close()
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.close()


def ids(n: int, start: int = 0) -> list[str]:
    return [str(1005000000000000 + start + i) for i in range(n)]


def offers_of(env: Env) -> int:
    return int(env.one("SELECT count(*) FROM offer WHERE merchant_id = %s", (env.merchant_id,))[0])


def active_of(env: Env) -> int:
    return int(
        env.one(
            "SELECT count(*) FROM offer WHERE merchant_id = %s AND is_active", (env.merchant_id,)
        )[0]
    )


# --------------------------------------------------------------------------


def test_ayni_besleme_iki_kez_cift_kayit_uretmez(env: Env) -> None:
    fid = env.feed()
    items = [offer(i, shop=f"shop{n % 3}") for n, i in enumerate(ids(25))]
    first = env.run(fid, items)
    assert (first.status, first.created, first.records, first.price_points) == (
        "success",
        25,
        25,
        25,
    )
    assert first.chunks_merged == 3
    again = env.run(fid, items)
    assert again.status == "duplicate"
    assert offers_of(env) == 25
    assert env.one("SELECT count(*) FROM seller WHERE merchant_id = %s", (env.merchant_id,))[0] == 3
    assert (
        env.one(
            "SELECT count(*) FROM price_point p JOIN offer o ON o.id = p.offer_id"
            " WHERE o.merchant_id = %s",
            (env.merchant_id,),
        )[0]
        == 25
    )
    # Icerik farkli (bir yeni urun): degismeyen 25 kayit yeniden yazilmaz, fiyat gecmisi sismez.
    third = env.run(
        fid, [*items, offer(ids(1, 900)[0])], at=T0 + timedelta(hours=1), name="third.xml"
    )
    assert (third.created, third.changed, third.unchanged, third.price_points) == (1, 0, 25, 1)
    assert offers_of(env) == 26


def test_kanonik_adres_affiliate_ayri_eslestirme_yok_kur_uydurulmaz(env: Env) -> None:
    fid = env.feed()
    env.run(fid, [offer(ids(1)[0])])
    url, aff, cur_, price, product_id, seller = env.one(
        """SELECT o.url, o.affiliate_url, o.currency, o.current_price, o.product_id, s.external_id
             FROM offer o LEFT JOIN seller s ON s.id = o.seller_id WHERE o.merchant_id = %s""",
        (env.merchant_id,),
    )
    assert url == f"https://www.aliexpress.com/item/{ids(1)[0]}.html"
    assert aff.startswith("https://rzekl.com/g/")
    assert (cur_, price, product_id, seller) == ("USD", 2211, None, "1105855203")
    # TRY disi offer puanli cozumleyiciye girmez (TL gibi gorunemez).
    with env.owner.cursor() as cur:
        cur.execute(PENDING_OFFERS, {"merchant_id": env.merchant_id, "limit": 100})
        assert cur.fetchall() == []


def test_fiyat_degisimi_gecmise_yazilir_degismeyen_yazilmaz(env: Env) -> None:
    fid = env.feed()
    base = [offer(i) for i in ids(5)]
    env.run(fid, base)
    changed = [*base[:4], offer(ids(5)[4], price="19.99")]
    report = env.run(fid, changed, at=T0 + timedelta(days=1))
    assert (report.changed, report.unchanged, report.price_points) == (1, 4, 1)
    prices = env.one(
        """SELECT array_agg(p.price ORDER BY p.observed_at) FROM price_point p
             JOIN offer o ON o.id = p.offer_id WHERE o.external_id = %s""",
        (ids(5)[4],),
    )[0]
    assert prices == [2211, 1999]
    outbox = env.one(
        """SELECT count(*) FROM search_outbox b JOIN offer o ON o.id = b.entity_id
            WHERE b.entity = 'offer' AND o.merchant_id = %s""",
        (env.merchant_id,),
    )[0]
    assert outbox == 6  # 5 ekleme + 1 degisim


def test_kesik_besleme_hicbir_seyi_pasiflestirmez(env: Env) -> None:
    fid = env.feed()
    env.run(fid, [offer(i) for i in ids(40)])
    report = env.run(fid, [offer(i) for i in ids(40)], at=T0 + timedelta(days=5), truncate=True)
    assert (report.status, report.gate, report.deactivated) == ("partial", "truncated", 0)
    assert active_of(env) == 40
    assert env.one(
        "SELECT status, reject_reason FROM source_snapshot WHERE id = %s", (report.snapshot_id,)
    ) == (
        "rejected",
        "truncated",
    )


def test_eksik_kayitli_besleme_pasiflestirmez(env: Env) -> None:
    fid = env.feed()
    env.run(fid, [offer(i) for i in ids(100)])
    report = env.run(fid, [offer(i) for i in ids(40)], at=T0 + timedelta(days=5))
    assert report.gate == "too_few_records" and report.deactivated == 0
    assert active_of(env) == 100


def test_hata_orani_esigi(env: Env) -> None:
    fid = env.feed()
    bad = [offer(i, price="0") for i in ids(5)]
    report = env.run(fid, [*[offer(i) for i in ids(20, 100)], *bad])
    assert (report.gate, report.rejected) == ("error_rate", 5)
    assert (
        env.one(
            "SELECT count(*) FROM ingest_error"
            " WHERE feed_source_id = %s AND error_code = 'price_invalid'",
            (fid,),
        )[0]
        == 5
    )


def test_guvenli_deaktivasyon_bekleme_suresi_ve_tavan(env: Env) -> None:
    fid = env.feed()
    items = [offer(i) for i in ids(100)]
    env.run(fid, items)
    # 6 urun cikti (tavan %10 altinda). Bekleme suresi dolmadan pasiflesmez.
    later = env.run(fid, items[:94], at=T0 + timedelta(hours=24))
    assert (later.status, later.deactivated) == ("success", 0)
    assert active_of(env) == 100
    # 3 gun sonra: hala hicbir beslemede yoklar -> pasif (silinmez).
    after = env.run(fid, items[:94], at=T0 + timedelta(days=3), name="after.xml")
    assert after.deactivated == 6
    assert (offers_of(env), active_of(env)) == (100, 94)
    reason = env.one(
        "SELECT DISTINCT deactivation_reason FROM offer WHERE merchant_id = %s AND NOT is_active",
        (env.merchant_id,),
    )
    assert reason == ("missing_from_snapshot",)
    # Geri gelen urun ayni satirda yeniden etkinlesir.
    back = env.run(fid, items, at=T0 + timedelta(days=4))
    assert (back.reactivated, back.created) == (6, 0)
    assert (offers_of(env), active_of(env)) == (100, 100)


def test_deaktivasyon_tavani_asilirsa_hicbir_sey_pasiflesmez(env: Env) -> None:
    fid = env.feed()
    items = [offer(i) for i in ids(100)]
    env.run(fid, items)
    report = env.run(fid, items[:85], at=T0 + timedelta(days=3))
    assert (report.status, report.gate, report.deactivated) == ("partial", "deactivation_cap", 0)
    assert active_of(env) == 100


def test_ayni_urun_iki_beslemede_fiyat_bandi_degisimi(env: Env) -> None:
    band_a = env.feed("6115:14267")
    band_b = env.feed("6115:14280")
    moving = ids(1, 500)[0]
    a_items = [offer(i) for i in ids(30)] + [offer(moving, price="24.99")]
    env.run(band_a, a_items)
    # Fiyat 25$'in ustune cikti: urun B bandina gecti.
    env.run(
        band_b,
        [offer(moving, price="26.50"), *[offer(i) for i in ids(10, 1000)]],
        at=T0 + timedelta(hours=2),
    )
    report = env.run(band_a, a_items[:30], at=T0 + timedelta(days=3))
    assert report.deactivated == 0
    row = env.one(
        "SELECT count(*), bool_and(is_active), max(current_price) FROM offer"
        " WHERE merchant_id = %s AND external_id = %s",
        (env.merchant_id, moving),
    )
    assert row == (1, True, 2650)
    assert offers_of(env) == 41


def test_cokme_sonrasi_kaldigi_yerden_devam(env: Env) -> None:
    fid = env.feed()
    items = [offer(i) for i in ids(35)]
    with pytest.raises(_Crash):
        env.run(fid, items, name="crash.xml", fail_after_chunks=2)
    snap = env.one("SELECT id, status FROM source_snapshot WHERE feed_source_id = %s", (fid,))
    assert snap[1] == "processing"
    assert (
        env.one(
            "SELECT count(*) FROM ingest_chunk WHERE snapshot_id = %s AND status = 'merged'",
            (snap[0],),
        )[0]
        == 2
    )
    resumed = env.run(fid, items, name="crash.xml")
    assert (resumed.status, resumed.snapshot_id, resumed.chunks_skipped, resumed.chunks_merged) == (
        "success",
        snap[0],
        2,
        2,
    )
    assert offers_of(env) == 35
    assert (
        env.one(
            "SELECT count(*) FROM price_point p JOIN offer o ON o.id = p.offer_id"
            " WHERE o.merchant_id = %s",
            (env.merchant_id,),
        )[0]
        == 35
    )


def test_olmus_surecin_yarim_kosusu_kapatilir(env: Env) -> None:
    fid = env.feed()
    env.owner.execute(
        "INSERT INTO ingest_run (merchant_id, feed_source_id, status) VALUES (%s, %s, 'running')",
        (env.merchant_id, fid),
    )
    env.run(fid, [offer(i) for i in ids(3)])
    rows = env.owner.execute(
        "SELECT status, error_text FROM ingest_run WHERE feed_source_id = %s ORDER BY id", (fid,)
    ).fetchall()
    assert rows == [("failed", "interrupted"), ("success", None)]


def test_sema_eksik_alan_birlestirme_yapmaz_ornek_mod_pasiflestirmez(env: Env) -> None:
    fid = env.feed(config={**AE_PROFILE, "required_fields": ["@id", "vendor"]})
    with pytest.raises(SyncAborted) as error:
        env.run(fid, [offer(i) for i in ids(5)])
    assert error.value.code == "schema_missing_fields" and offers_of(env) == 0

    sample_feed = env.feed("6115:2")
    env.run(sample_feed, [offer(i) for i in ids(20, 200)])
    sample = env.run(
        sample_feed, [offer(i) for i in ids(20, 300)], at=T0 + timedelta(days=3), max_records=5
    )
    assert (sample.gate, sample.deactivated, sample.created) == ("sample_limit", 0, 5)
    assert active_of(env) == 25


def test_kesif_kaydi_yonetici_kararini_ezmez(env: Env) -> None:
    def feed(ext: str, name: str) -> DiscoveredFeed:
        return DiscoveredFeed(
            "test0112",
            ext,
            "6115",
            "AliExpress WW",
            name,
            "xml",
            None,
            "https://export.test/p?feed_id=1",
            "USD",
            None,
            T0,
            {"parser": "yml"},
        )

    conn = env.owner
    report = discovery.record(conn, "test0112", [feed("6115:1", "a"), feed("6115:2", "b")])
    assert sorted(report.new) == ["6115:1", "6115:2"]
    status, config, merchant = env.one(
        "SELECT status, config, merchant_id FROM feed_source"
        " WHERE external_id = '6115:1' AND network = 'test0112'"
    )
    assert (status, merchant) == ("discovered", None)
    assert config == {"parser": "yml"}  # profil yalnizca dogrulanmis program icin (admitad:6115)
    conn.execute(
        'UPDATE feed_source SET status = \'paused\', config = \'{"parser":"yml","x":1}\''
        " WHERE network = 'test0112' AND external_id = '6115:1'"
    )
    again = discovery.record(conn, "test0112", [feed("6115:1", "a2")])
    assert again.new == [] and again.gone == 1
    rows = dict(
        (r[0], (r[1], r[2], r[3]))
        for r in conn.execute(
            "SELECT external_id, status, name, config->>'x' FROM feed_source"
            " WHERE network = 'test0112'"
        ).fetchall()
    )
    assert rows["6115:1"] == ("paused", "a2", "1")
    assert rows["6115:2"][0] == "gone"
    assert discovery.record(conn, "test0112", []).gone == 0  # bos kesif hicbir seyi silmez
    back = discovery.record(conn, "test0112", [feed("6115:1", "a2"), feed("6115:2", "b")])
    assert back.gone == 0
    assert conn.execute(
        "SELECT status FROM feed_source WHERE network='test0112' AND external_id='6115:2'"
    ).fetchone() == ("discovered",)


def test_profil_yalnizca_dogrulanmis_programa_uygulanir() -> None:
    from feeds.profiles import profile_for

    assert profile_for("admitad", "6115")["url_unwrap"] == ["ulp", "dl_target_url"]
    assert profile_for("admitad", "20881") == {}
