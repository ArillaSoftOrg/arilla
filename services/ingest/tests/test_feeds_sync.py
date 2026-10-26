"""Besleme senkronizasyonu: veritabani uzerinde uctan uca (karar 0112).

Senkronizasyon UYGULAMA rolüyle (DATABASE_URL, arilla_app) calisir: yetkiler
de sinanir. Kurulum ve temizlik sahip rolle.
"""

from __future__ import annotations

import gzip
import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import psycopg
import pytest

from db.connection import database_url
from feeds import approvals, discovery
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
    cur.execute("DELETE FROM product WHERE slug = 't0112-guard'")
    # Onay denetim izi (karar 0152) test veritabanina aittir; testler arasi sizmasin.
    cur.execute("DELETE FROM job_run WHERE job IN ('feed_drop_approval', 'feed_drop_accepted')")


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
        cur.execute(
            PENDING_OFFERS,
            {"merchant_id": env.merchant_id, "limit": 100, "source_listing": []},
        )
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
    # 5 ekleme; yalniz fiyat degisimi arama olayi URETMEZ (karar 0146), gecmis price_point'ta.
    assert outbox == 5


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


def test_degismeyen_satir_yeniden_yazilmaz_degisen_yazilir(env: Env) -> None:
    fid = env.feed()
    items = [offer(i) for i in ids(20)]
    env.run(fid, items)
    before = dict(
        env.owner.execute(
            "SELECT external_id, xmin::text || '/' || xmax::text FROM offer WHERE merchant_id = %s",
            (env.merchant_id,),
        ).fetchall()
    )
    changed = [*items[:19], offer(ids(20)[19], price="19.99")]
    report = env.run(fid, changed, at=T0 + timedelta(hours=6), name="degisim.xml")
    assert (report.changed, report.unchanged, report.price_points) == (1, 19, 1)
    after = dict(
        env.owner.execute(
            "SELECT external_id, xmin::text || '/' || xmax::text FROM offer WHERE merchant_id = %s",
            (env.merchant_id,),
        ).fetchall()
    )
    # xmin: satir yeniden yazildi mi; xmax: satir KILITLENDI mi (ON CONFLICT kilidi
    # degismeyen satirda da WAL uretir). Degismeyen 19 satirda ikisi de ayni kalmali.
    touched = [ext for ext in before if before[ext] != after[ext]]
    assert touched == [ids(20)[19]]

    # Gorulme bilgisi uyelikte guncel (offer satiri yazilmadan).
    seen = env.owner.execute(
        "SELECT count(*) FROM feed_source_offer WHERE feed_source_id = %s AND last_seen_at = %s",
        (fid, T0 + timedelta(hours=6)),
    ).fetchone()
    assert seen == (20,)


def test_cokme_sonrasi_indirilmis_dosya_yeniden_kullanilir(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hashlib

    import feeds.sync as sync_module
    from feeds.download import Downloaded

    monkeypatch.setenv("FEED_STAGING_DIR", str(env.tmp / "staging"))
    data = yml([offer(i) for i in ids(35)])
    calls: list[Path] = []

    def fake_download(url: str, target: Path, **_kw: object) -> Downloaded:
        calls.append(target)
        target.write_bytes(data)
        return Downloaded(target, hashlib.sha256(data).hexdigest(), len(data), len(data))

    class Net:
        name = "test0112"

        def download_url(self, external_id: str) -> str:
            return "https://feed.invalid/x"

    monkeypatch.setattr(sync_module, "download", fake_download)
    fid = env.feed()
    settings = SyncSettings(chunk_size=10, pause_ms=0)
    with pytest.raises(_Crash):
        FeedSync(
            env.app,
            fid,
            network=Net(),
            observed_at=T0,
            settings=settings,
            sleep=lambda _s: None,
            fail_after_chunks=2,
        ).run(force=True)
    report = FeedSync(
        env.app,
        fid,
        network=Net(),
        observed_at=T0 + timedelta(minutes=5),
        settings=settings,
        sleep=lambda _s: None,
    ).run(force=True)
    assert len(calls) == 1  # ikinci kosu indirmedi
    assert (report.reused_download, report.chunks_skipped, report.status) == (True, 2, "success")
    assert offers_of(env) == 35
    assert not calls[0].exists()  # basarili kosudan sonra hazirlik dosyasi silindi


def test_on_indirilen_dosya_kullanilir_paralel_indirme_disk_payiyla(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hashlib

    import feeds.sync as sync_module
    from feeds.download import Downloaded
    from feeds.sync import load_feed, prefetch_download

    monkeypatch.setenv("FEED_STAGING_DIR", str(env.tmp / "staging"))
    data = yml([offer(i) for i in ids(12)])
    seen: list[int | None] = []

    def fake_download(url: str, target: Path, **kw: object) -> Downloaded:
        seen.append(kw.get("max_bytes"))  # type: ignore[arg-type]
        target.write_bytes(data)
        return Downloaded(target, hashlib.sha256(data).hexdigest(), len(data), len(data))

    class Net:
        name = "test0112"

        def download_url(self, external_id: str) -> str:
            return "https://feed.invalid/x"

    monkeypatch.setattr(sync_module, "download", fake_download)
    fid = env.feed()
    feed = load_feed(env.app, fid)
    env.app.rollback()
    pre = prefetch_download(feed, Net(), max_records=None, max_bytes=123_456, at=T0)
    assert pre is not None and seen == [123_456]  # disk payi indirmeye iletildi

    def no_download(*_a: object, **_k: object) -> Downloaded:
        raise AssertionError("on indirilmis dosya varken yeniden indirildi")

    monkeypatch.setattr(sync_module, "download", no_download)
    report = FeedSync(
        env.app,
        fid,
        network=Net(),
        prefetched=pre,
        observed_at=T0,
        settings=SyncSettings(chunk_size=5, pause_ms=0),
        sleep=lambda _s: None,
    ).run(force=True)
    assert (report.status, report.created) == ("success", 12)
    assert not pre[0].exists()


def test_wal_arsivi_geride_kalirsa_bekler_cok_uzarsa_guvenle_durur(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    import feeds.sync as sync_module

    lags = iter([2 << 30, 2 << 30, 0, 0, 0, 0])
    monkeypatch.setattr(sync_module, "_archive_lag_bytes", lambda _c: next(lags, 0))
    fid = env.feed()
    report = env.run(fid, [offer(i) for i in ids(25)])
    assert report.status == "success" and report.archive_wait_seconds == 10.0

    monkeypatch.setattr(sync_module, "_archive_lag_bytes", lambda _c: 3 << 30)
    settings = SyncSettings(chunk_size=10, pause_ms=0, max_archive_wait_seconds=15)
    with pytest.raises(SyncAborted) as error:
        env.run(
            fid, [offer(i) for i in ids(25, 100)], at=T0 + timedelta(hours=1), settings=settings
        )
    assert error.value.code == "archive_lag"
    assert active_of(env) == 25 + 10  # ilk parca yazildi, hicbir sey pasiflesmedi


def test_kesik_beslemede_neden_kayda_gecer(env: Env) -> None:
    fid = env.feed()
    report = env.run(fid, [offer(i) for i in ids(30)], truncate=True)
    assert report.gate == "truncated"
    text = env.one("SELECT error_text FROM ingest_run WHERE id = %s", (report.run_id,))[0]
    assert text.startswith("truncated: acik kayit")


# --------------------------------------------------------------------------
# Karar 0152: eksik/anormal beslemeler YAZMADAN reddedilir
# --------------------------------------------------------------------------

#: 26 Ekim 2026'daki AliExpress beslemesi (feed 7): `no_deactivate` acik.
NO_DEACTIVATE = {**AE_PROFILE, "no_deactivate": True}


def writes_of(env: Env) -> tuple[object, ...]:
    """Merchant izleri (teklif, fiyat, urun, uyelik...): bir sey yazilirsa demet degisir."""
    m = (env.merchant_id,)
    offers = "SELECT id FROM offer WHERE merchant_id = %s"
    products = "SELECT product_id FROM offer WHERE merchant_id = %s AND product_id IS NOT NULL"
    rows = [
        "SELECT count(*) FROM offer WHERE merchant_id = %s",
        f"SELECT count(*) FROM price_point WHERE offer_id IN ({offers})",
        f"SELECT count(*) FROM feed_source_offer WHERE offer_id IN ({offers})",
        f"SELECT count(*) FROM search_outbox WHERE entity = 'offer' AND entity_id IN ({offers})",
        f"SELECT count(*) FROM offer_image WHERE offer_id IN ({offers})",
        "SELECT count(*) FROM seller WHERE merchant_id = %s",
        "SELECT coalesce(sum(current_price), 0)::bigint FROM offer WHERE merchant_id = %s",
        "SELECT count(*) FROM offer WHERE merchant_id = %s AND NOT is_active",
        "SELECT coalesce(max(last_changed_at)::text || max(last_seen_at)::text, '') FROM offer "
        "WHERE merchant_id = %s",
        "SELECT coalesce(max(last_snapshot_id), 0) FROM feed_source_offer "
        f"WHERE offer_id IN ({offers})",
        f"SELECT count(*) FROM product WHERE id IN ({products})",
        "SELECT coalesce(md5(string_agg(p.id::text || ':' || coalesce(p.min_price, 0)::text"
        " || ':' || p.offer_count::text || ':' || p.in_stock_count::text || ':'"
        " || p.updated_at::text, ',' ORDER BY p.id)), '') FROM product p"
        f" WHERE p.id IN ({products})",
        "SELECT count(*) FROM ingest_error WHERE feed_source_id IN "
        "(SELECT id FROM feed_source WHERE merchant_id = %s)",
    ]
    return tuple(env.one(sql, m)[0] for sql in rows)


def link_product(env: Env, count: int = 5) -> int:
    """Birkac teklifi bir urune baglar: yazim olsaydi urun ozeti (min_price...) degisirdi."""
    with env.owner.cursor() as cur:
        cur.execute("UPDATE merchant SET is_active = TRUE WHERE id = %s", (env.merchant_id,))
        cur.execute("INSERT INTO product (slug, title) VALUES ('t0112-guard', 'Test') RETURNING id")
        row = cur.fetchone()
        assert row
        product_id = int(row[0])
        cur.execute(
            """UPDATE offer SET product_id = %s WHERE id IN
                   (SELECT id FROM offer WHERE merchant_id = %s ORDER BY id LIMIT %s)""",
            (product_id, env.merchant_id, count),
        )
        cur.execute(
            "UPDATE product SET min_price = 1, offer_count = 99 WHERE id = %s", (product_id,)
        )
    return product_id


def unlink_product(env: Env, product_id: int) -> None:
    with env.owner.cursor() as cur:
        cur.execute("UPDATE offer SET product_id = NULL WHERE product_id = %s", (product_id,))
        cur.execute("DELETE FROM product WHERE id = %s", (product_id,))


def run_bytes(
    env: Env,
    feed_id: int,
    data: bytes,
    *,
    at: datetime = T0,
    name: str = "raw.xml",
    gz: bool = False,
    **kw: object,
):
    """Ham baytlarla senkronizasyon (kesik/bozuk/yanlis icerik senaryolari)."""
    path = write(env.tmp / name, data, gz=gz)
    sync = FeedSync(
        env.app,
        feed_id,
        source_path=path,
        observed_at=at,
        settings=SyncSettings(chunk_size=10, pause_ms=0),
        sleep=lambda _s: None,
        **kw,
    )  # type: ignore[arg-type]
    return sync.run(force=True)


def approve_drop(env: Env, feed_id: int, snapshot_id: int, **kw: object) -> int:
    values = {"by": "ops-test", "reason": "katalog bilincli olarak kuculdu (test)", **kw}
    # Uygulama rolu: CLI uretimde de bu rolle calisir (job_run yazma yetkisi sinanir).
    return approvals.approve(env.app, feed_id, snapshot_id, **values)  # type: ignore[arg-type]


def test_kesik_besleme_hicbir_satir_yazmaz(env: Env) -> None:
    """26 Ekim senaryosu: tam yukleme sonrasi kesik dosya (farkli fiyatlarla) sifir yazim."""
    fid = env.feed(config=NO_DEACTIVATE)
    first = env.run(fid, [offer(i) for i in ids(60)])
    assert first.status == "success"
    before = writes_of(env)
    last_success = env.one("SELECT last_success_at FROM feed_source WHERE id = %s", (fid,))[0]

    # Kesik dosya: ayni urunler, DEGISMIS fiyatlar + yeni urunler (eski akis bunlari yazardi).
    changed = [offer(i, price="9.99") for i in ids(60)] + [offer(i) for i in ids(30, 1000)]
    report = env.run(fid, changed, at=T0 + timedelta(days=1), truncate=True)

    assert (report.status, report.gate, report.records, report.deactivated) == (
        "partial",
        "truncated",
        0,
        0,
    )
    assert writes_of(env) == before
    assert env.one(
        "SELECT status, reject_reason FROM source_snapshot WHERE id = %s", (report.snapshot_id,)
    ) == ("rejected", "truncated")
    # Basari damgasi ilerlemez: tazelik olcumu "geride" kalir, gunluk is yeniden dener.
    feed = env.one("SELECT last_success_at, last_error_code FROM feed_source WHERE id = %s", (fid,))
    assert feed == (last_success, "truncated")
    run = env.one(
        """SELECT status, next_retry_at IS NOT NULL, checkpoint -> 'integrity' ->> 'code'
             FROM ingest_run WHERE id = %s""",
        (report.run_id,),
    )
    assert run == ("partial", True, "truncated")


def test_kesik_ilk_yukleme_hicbir_sey_yazmaz(env: Env) -> None:
    fid = env.feed(config=NO_DEACTIVATE)
    empty = writes_of(env)
    report = env.run(fid, [offer(i) for i in ids(50)], truncate=True)
    assert report.gate == "truncated"
    assert writes_of(env) == empty
    assert offers_of(env) == 0


def test_kapanis_etiketsiz_tam_kayitli_dosya_da_reddedilir(env: Env) -> None:
    """Dosya kayit sinirinda bitti (gzip/HTTP duzeyinde "tamam"): kapanis etiketi yok."""
    fid = env.feed(config=NO_DEACTIVATE)
    empty = writes_of(env)
    data = yml([offer(i) for i in ids(40)])
    report = run_bytes(env, fid, data[: data.rindex(b"</offers>")])
    assert report.gate == "truncated" and report.records_in_file == 40
    assert writes_of(env) == empty


def test_anormal_dusus_yazilmadan_karantinaya_alinir(env: Env) -> None:
    fid = env.feed(config=NO_DEACTIVATE)
    env.run(fid, [offer(i) for i in ids(100)])
    before = writes_of(env)
    # 100 -> 40 (%40 < %85), dosya TAM ve gecerli: eski akis `no_deactivate` ile bunu yazardi.
    report = env.run(fid, [offer(i, price="5.00") for i in ids(40)], at=T0 + timedelta(days=1))
    assert (report.status, report.gate, report.records) == ("partial", "too_few_records", 0)
    assert writes_of(env) == before
    assert env.one(
        "SELECT status, reject_reason, record_count FROM source_snapshot WHERE id = %s",
        (report.snapshot_id,),
    ) == ("rejected", "too_few_records", 40)
    # Gecici degil: yeniden denenmez (ayni icerik), karantina suresi beklenir.
    assert (
        env.one("SELECT next_retry_at FROM ingest_run WHERE id = %s", (report.run_id,))[0] is None
    )


def test_mesru_kucuk_dusus_engellenmez(env: Env) -> None:
    fid = env.feed(config=NO_DEACTIVATE)
    env.run(fid, [offer(i) for i in ids(100)])
    report = env.run(fid, [offer(i) for i in ids(90)], at=T0 + timedelta(days=1))  # %90
    assert (report.status, report.gate) == ("success", None)


SMALL = [offer(i, price="5.00") for i in ids(40)]


def quarantine_once(env: Env, fid: int, *, at: datetime = T0 + timedelta(days=1)):
    """100 teklifli tam surum + 40 teklifli (%40) dosya: karantinaya alinan raporu doner."""
    env.run(fid, [offer(i) for i in ids(100)])
    report = env.run(fid, SMALL, at=at, name="small.xml")
    assert report.gate == "too_few_records"
    return report


def test_karantina_kendiliginden_kalkmaz_ayni_icerik_zaman_ve_sayi(env: Env) -> None:
    """Ayni icerik tekrar gelse, gunler/saatler gecse, kayit sayisi artsa da onay SAYILMAZ."""
    fid = env.feed(config=NO_DEACTIVATE)
    first = quarantine_once(env, fid)
    before = writes_of(env)
    for days in (1, 2, 9):
        with env.owner.cursor() as cur:  # tum karantina kayitlarini eskit: sure gecmesi
            cur.execute(
                "UPDATE source_snapshot SET completed_at = completed_at - interval '30 hours' "
                "WHERE feed_source_id = %s AND status = 'rejected'",
                (fid,),
            )
        again = env.run(fid, SMALL, at=T0 + timedelta(days=days + 1), name="small.xml")
        assert (again.status, again.gate, again.drop_approved) == (
            "partial",
            "too_few_records",
            False,
        )
    # Sayi artsa da %85 altindaysa (80/100) hala karantina; esigin ustu (90) gecer.
    low = env.run(fid, [offer(i) for i in ids(80)], at=T0 + timedelta(days=12), name="eighty.xml")
    assert low.gate == "too_few_records"
    assert writes_of(env) == before
    assert first.snapshot_id != low.snapshot_id
    assert not [q for q in approvals.quarantined(env.app, fid) if q.approval_id]


def test_acik_onay_ayni_icerigi_bir_kez_kabul_ettirir_ve_denetim_izi_birakir(env: Env) -> None:
    fid = env.feed(config=NO_DEACTIVATE)
    first = quarantine_once(env, fid)
    (waiting,) = approvals.quarantined(env.app, fid)
    assert (waiting.snapshot_id, waiting.records, waiting.approval_id) == (
        first.snapshot_id,
        40,
        None,
    )
    approval = approve_drop(
        env, fid, first.snapshot_id, by="yusuf", reason="katalog daraldi (test)"
    )

    accepted = env.run(fid, SMALL, at=T0 + timedelta(days=2), name="small.xml")
    assert (accepted.status, accepted.gate, accepted.drop_approved) == ("success", None, True)
    assert accepted.records == 40 and accepted.price_points == 40
    # `no_deactivate` korunur: eksik 60 teklif pasiflesmez.
    assert active_of(env) == 100
    # Denetim izi: kim, neden, hangi surum/icerik; kabul de kayitli.
    row = env.one(
        """SELECT detail ->> 'approved_by', detail ->> 'reason', detail ->> 'snapshot_id',
                  length(detail ->> 'sha256') FROM job_run WHERE id = %s""",
        (approval,),
    )
    assert row == ("yusuf", "katalog daraldi (test)", str(first.snapshot_id), 64)
    used = env.one(
        """SELECT detail ->> 'approval_id', detail ->> 'snapshot_id', detail ->> 'records'
             FROM job_run WHERE job = 'feed_drop_accepted' AND detail ->> 'feed_id' = %s""",
        (str(fid),),
    )
    assert used == (str(approval), str(accepted.snapshot_id), "40")

    # Tek kullanim: tam surum geri geldi, sonra AYNI kucuk icerik yine dustu: yeni onay ister.
    env.run(fid, [offer(i) for i in ids(100)], at=T0 + timedelta(days=3), name="full.xml")
    env.run(
        fid, [offer(i, price="6.00") for i in ids(100)], at=T0 + timedelta(days=4), name="f2.xml"
    )
    again = env.run(fid, SMALL, at=T0 + timedelta(days=5), name="small.xml")
    assert (again.gate, again.drop_approved) == ("too_few_records", False)


def test_onay_yalniz_onaylanan_icerik_icin_gecerli(env: Env) -> None:
    fid = env.feed(config=NO_DEACTIVATE)
    first = quarantine_once(env, fid)
    approve_drop(env, fid, first.snapshot_id)
    other = [offer(i, price="7.77") for i in ids(40)]  # ayni sayi, FARKLI icerik
    report = env.run(fid, other, at=T0 + timedelta(days=2), name="other.xml")
    assert (report.gate, report.drop_approved) == ("too_few_records", False)


def test_onay_suresi_dolar(env: Env) -> None:
    fid = env.feed(config=NO_DEACTIVATE)
    first = quarantine_once(env, fid)
    approval = approve_drop(env, fid, first.snapshot_id, ttl_days=3)
    with env.owner.cursor() as cur:
        cur.execute(
            "UPDATE job_run SET started_at = now() - interval '4 days' WHERE id = %s", (approval,)
        )
    report = env.run(fid, SMALL, at=T0 + timedelta(days=2), name="small.xml")
    assert (report.gate, report.drop_approved) == ("too_few_records", False)


def test_onay_dogrulamalari(env: Env) -> None:
    fid = env.feed(config=NO_DEACTIVATE)
    other_fid = env.feed("6115:2", config=NO_DEACTIVATE)
    first = quarantine_once(env, fid)
    sid = first.snapshot_id
    ok = {"by": "yusuf", "reason": "katalog daraldi (test)"}

    def refused(feed: int, snapshot: int, **kw: object) -> str:
        with pytest.raises(approvals.ApprovalError) as error:
            approvals.approve(env.app, feed, snapshot, **{**ok, **kw})  # type: ignore[arg-type]
        return str(error.value)

    assert "bu beslemeye ait degil" in refused(other_fid, sid)
    assert "bu beslemeye ait degil" in refused(fid, sid + 999)
    assert "--reason" in refused(fid, sid, reason="kisa")
    assert "--by" in refused(fid, sid, by="x")
    assert "--ttl-days" in refused(fid, sid, ttl_days=99)
    # Kesik dosya onaylanamaz: yalniz `too_few_records`.
    cut = env.run(fid, SMALL, at=T0 + timedelta(days=2), truncate=True, name="cut.xml")
    assert cut.gate == "truncated"
    assert "kesik/bos dosya onaylanamaz" in refused(fid, cut.snapshot_id)
    # Tam (complete) surum onaylanamaz.
    complete = env.one(
        "SELECT max(id) FROM source_snapshot WHERE feed_source_id = %s AND status = 'complete'",
        (fid,),
    )[0]
    assert "yalniz 'too_few_records'" in refused(fid, int(complete))
    # Gecerli onay bir kez; ikincisi reddedilir.
    approve_drop(env, fid, sid)
    assert "zaten var" in refused(fid, sid)
    # Karantina eskidi (daha yeni tam surum geldi): onay verilemez.
    env.run(
        fid,
        [offer(i, price="23.00") for i in ids(100)],
        at=T0 + timedelta(days=3),
        name="again.xml",
    )
    assert "eskimis" in refused(fid, sid)


def test_onayli_surum_yarim_kalirsa_ayni_onayla_surer(env: Env) -> None:
    fid = env.feed(config=NO_DEACTIVATE)
    first = quarantine_once(env, fid)
    approve_drop(env, fid, first.snapshot_id)
    with pytest.raises(_Crash):
        env.run(fid, SMALL, at=T0 + timedelta(days=2), name="small.xml", fail_after_chunks=1)
    resumed = env.run(fid, SMALL, at=T0 + timedelta(days=2), name="small.xml")
    assert (resumed.status, resumed.drop_approved) == ("success", True)
    used = env.one(
        "SELECT count(*) FROM job_run WHERE job = 'feed_drop_accepted' "
        "AND detail ->> 'feed_id' = %s",
        (str(fid),),
    )[0]
    assert used == 1


def test_onay_yalniz_kayit_sayisi_kapisini_gecirir_deaktivasyon_tavani_kalir(env: Env) -> None:
    """`no_deactivate` OLMAYAN besleme: onayli kucuk surum yazilir ama 60 teklif pasiflesmez."""
    fid = env.feed()  # AE_PROFILE: deaktivasyon acik
    first = quarantine_once(env, fid)
    approve_drop(env, fid, first.snapshot_id)
    report = env.run(fid, SMALL, at=T0 + timedelta(days=2), name="small.xml")
    assert report.drop_approved and report.records == 40
    assert (report.status, report.gate, report.deactivated) == ("partial", "deactivation_cap", 0)
    assert active_of(env) == 100


def test_onay_diger_kapilari_atlamaz_kesik_dosya_onayliyken_de_reddedilir(env: Env) -> None:
    fid = env.feed(config=NO_DEACTIVATE)
    first = quarantine_once(env, fid)
    approve_drop(env, fid, first.snapshot_id)
    before = writes_of(env)
    report = env.run(fid, SMALL, at=T0 + timedelta(days=2), truncate=True, name="cut.xml")
    assert (report.gate, report.drop_approved) == ("truncated", False)
    assert writes_of(env) == before


def test_cli_karantina_ve_onay(env: Env, capsys: pytest.CaptureFixture[str]) -> None:
    from feeds.__main__ import main

    fid = env.feed(config=NO_DEACTIVATE)
    first = quarantine_once(env, fid)
    sid = str(first.snapshot_id)
    assert main(["quarantine", "--feed", str(fid)]) == 0
    assert "onay BEKLIYOR" in capsys.readouterr().out
    base = ["approve-drop", "--feed", str(fid), "--snapshot", sid, "--by", "yusuf"]
    # --confirm yok: yazmaz.
    assert main([*base, "--reason", "katalog daraldi (test)"]) == 0
    assert "yazilmadi" in capsys.readouterr().out
    assert env.one("SELECT count(*) FROM job_run WHERE job = 'feed_drop_approval'")[0] == 0
    # Gecersiz gerekce: reddedilir.
    assert main([*base, "--reason", "kisa", "--confirm"]) == 2
    assert "--reason" in capsys.readouterr().err
    # Gecerli: onay kaydedilir, listede "onayli".
    assert main([*base, "--reason", "katalog daraldi (test)", "--confirm"]) == 0
    capsys.readouterr()
    assert main(["quarantine", "--feed", str(fid)]) == 0
    assert "onayli" in capsys.readouterr().out
    assert env.one("SELECT count(*) FROM job_run WHERE job = 'feed_drop_approval'")[0] == 1
    # Olmayan surum / besleme.
    assert (
        main(
            [
                "approve-drop",
                "--feed",
                str(fid),
                "--snapshot",
                "999999",
                "--by",
                "yusuf",
                "--reason",
                "katalog daraldi (test)",
                "--confirm",
            ]
        )
        == 2
    )
    capsys.readouterr()


BAD_FILES = {
    # ad: (baytlar, gz, beklenen kapi)
    "kesik_yml_kayit_ortasinda": (lambda ok: ok[: int(len(ok) * 0.34)], False, "truncated"),
    "kesik_yml_etiket_ortasinda": (
        lambda ok: ok[: ok.index(b"<offer id=", 4000) + 9],
        False,
        "truncated",
    ),
    "kapanis_etiketi_yok": (lambda ok: ok[: ok.rindex(b"</offers>")], False, "truncated"),
    "gecerli_gzip_icinde_kesik_belge": (lambda ok: ok[: int(len(ok) * 0.34)], True, "truncated"),
    "gzip_akisi_kesik": (lambda ok: gzip.compress(ok)[:300], True, "truncated"),
    "http_200_html_hata_sayfasi": (
        lambda ok: b"<html><body><h1>502 Bad Gateway</h1></body></html>",
        False,
        "empty",
    ),
    "ikili_cop": (lambda ok: bytes(range(256)) * 40, False, "empty"),
    "kayitsiz_bos_belge": (lambda ok: yml([]), False, "empty"),
    "acilmis_kapanmamis_kayit": (lambda ok: ok.replace(b"</offer>", b"", 3), False, "truncated"),
}


@pytest.mark.parametrize("name", sorted(BAD_FILES))
def test_bozuk_ya_da_eksik_besleme_urun_teklif_fiyat_tablolarini_degistirmez(
    env: Env, name: str
) -> None:
    """Gercek PostgreSQL: reddedilen dosya sonrasi teklif/fiyat/urun/uyelik/outbox birebir ayni."""
    make, gz, gate = BAD_FILES[name]
    fid = env.feed(currency="TRY", config=NO_DEACTIVATE)
    items = [offer(i, currency="TRY", price="100.00") for i in ids(60)]
    ok_bytes = yml([offer(i, currency="TRY", price="55.00") for i in ids(60)])
    env.run(fid, items)
    product_id = link_product(env)
    try:
        before = writes_of(env)
        last_success = env.one("SELECT last_success_at FROM feed_source WHERE id = %s", (fid,))[0]
        data = make(ok_bytes)
        for turn in range(3):  # tekrarlanan eksik besleme: her seferinde sifir yazim
            report = run_bytes(
                env,
                fid,
                gzip.compress(data) if gz and name != "gzip_akisi_kesik" else data,
                at=T0 + timedelta(days=1 + turn),
                name=f"{name}-{turn}.bin",
                gz=False,
            )
            assert (report.status, report.gate) == ("partial", gate), (turn, report.gate)
            assert report.records == 0 and report.price_points == 0 and report.created == 0
            assert writes_of(env) == before, turn
            assert env.one(
                "SELECT status, reject_reason FROM source_snapshot WHERE id = %s",
                (report.snapshot_id,),
            ) == ("rejected", gate)
        assert env.one("SELECT last_success_at FROM feed_source WHERE id = %s", (fid,))[0] == (
            last_success
        )
        assert env.one(
            "SELECT min_price, offer_count FROM product WHERE id = %s", (product_id,)
        ) == (
            1,
            99,
        )  # urun ozeti yenilenmedi
    finally:
        unlink_product(env, product_id)


def test_dusuk_kayit_sayisi_urun_teklif_fiyat_tablolarini_degistirmez(env: Env) -> None:
    fid = env.feed(currency="TRY", config=NO_DEACTIVATE)
    env.run(fid, [offer(i, currency="TRY", price="100.00") for i in ids(100)])
    product_id = link_product(env)
    try:
        before = writes_of(env)
        for turn in range(3):
            report = env.run(
                fid,
                [offer(i, currency="TRY", price="50.00") for i in ids(40)],
                at=T0 + timedelta(days=1 + turn),
                name="low.xml",
            )
            assert (report.status, report.gate) == ("partial", "too_few_records")
            assert writes_of(env) == before
        assert env.one(
            "SELECT min_price, offer_count FROM product WHERE id = %s", (product_id,)
        ) == (
            1,
            99,
        )
    finally:
        unlink_product(env, product_id)


def test_tek_bozuk_kayit_dosyayi_durdurmaz_karar_0114_korunur(env: Env) -> None:
    """Kayit duzeyi bozukluk butunluk taramasinda DEGIL, hata orani kapisinda kalir."""
    fid = env.feed(config=NO_DEACTIVATE)
    data = yml([offer(i) for i in ids(100)])
    marker = f"<name>Test product {ids(100)[3]}</name>".encode()
    assert marker in data
    broken = data.replace(marker, b"<name>bozuk < etiket</name>")
    report = run_bytes(env, fid, broken)
    assert (report.status, report.gate, report.rejected) == ("success", None, 1)
    assert offers_of(env) == 99


def test_ilk_yuklemede_boyut_karsilastirmasi_yok(env: Env) -> None:
    fid = env.feed(config=NO_DEACTIVATE)
    assert env.run(fid, [offer(i) for i in ids(3)]).status == "success"


def test_sinirli_ornek_kipi_butunluk_taramasindan_muaf(env: Env) -> None:
    """`--max-records`: dosya bilerek eksik; tarama atlanir (ilk asama kapilari bozulmaz)."""
    fid = env.feed(config=NO_DEACTIVATE)
    report = env.run(fid, [offer(i) for i in ids(30)], max_records=10)
    assert report.gate == "sample_limit" and report.records_in_file == 0


def test_yeniden_deneme_yalniz_kesik_icin(env: Env) -> None:
    from feeds import runner

    fid = env.feed(config=NO_DEACTIVATE)
    env.run(fid, [offer(i) for i in ids(100)])
    settings = SyncSettings(chunk_size=10, pause_ms=0)

    def outcome(offers: list[dict], *, truncate: bool = False):
        path = write(env.tmp / f"r{len(offers)}{truncate}.xml", yml(offers, truncate=truncate))
        return runner.sync_one(
            env.app, fid, network=None, source_path=path, settings=settings, sleep=lambda _s: None
        )

    cut = outcome([offer(i) for i in ids(100)], truncate=True)
    assert (cut.status, cut.retryable, cut.ok) == ("partial", True, False)
    small = outcome([offer(i) for i in ids(30)])
    assert (small.status, small.retryable, small.ok) == ("partial", False, False)


def test_http_tanilama_kontrol_noktasina_yazilir(env: Env) -> None:
    from feeds.download import diagnostics_path

    fid = env.feed(config=NO_DEACTIVATE)
    path = write(env.tmp / "diag.xml", yml([offer(i) for i in ids(20)]))
    diagnostics_path(path).write_text(
        json.dumps({"status": 200, "host": "export.test", "headers": {"etag": '"abc"'}}),
        encoding="utf-8",
    )
    sync = FeedSync(
        env.app,
        fid,
        source_path=path,
        observed_at=T0,
        settings=SyncSettings(chunk_size=10, pause_ms=0),
        sleep=lambda _s: None,
    )
    report = sync.run(force=True)
    assert report.status == "success"
    row = env.one(
        """SELECT checkpoint -> 'http' ->> 'host', checkpoint -> 'integrity' ->> 'ok',
                  (checkpoint ->> 'records')::int FROM ingest_run WHERE id = %s""",
        (report.run_id,),
    )
    assert row == ("export.test", "true", 20)


def _vector() -> str:
    return "[" + ",".join(["0.01"] * 768) + "]"


def test_gorsel_ya_da_metin_degisince_bayat_embedding_silinir(env: Env) -> None:
    fid = env.feed()
    base = [offer(i) for i in ids(3)]
    env.run(fid, base)
    with env.owner.cursor() as cur:
        cur.execute(
            """INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
               SELECT 'offer', o.id, k.kind, 'test-0112', %s::vector
                 FROM offer o CROSS JOIN (VALUES ('image'), ('text')) AS k(kind)
                WHERE o.merchant_id = %s""",
            (_vector(), env.merchant_id),
        )
    try:
        image, title, price = (dict(o) for o in base)
        image["pictures"] = ["https://ae-pic-a1.aliexpress-media.com/kf/Snew.png"]
        title["name"] = "Completely different product"
        price["price"] = "19.99"
        report = env.run(fid, [image, title, price], at=T0 + timedelta(days=1))
        assert (report.changed, report.stale_image_embeddings, report.stale_text_embeddings) == (
            3,
            1,
            1,
        )
        with env.owner.cursor() as cur:
            cur.execute(
                """SELECT o.external_id, array_agg(e.kind ORDER BY e.kind)
                     FROM offer o JOIN embedding e ON e.target_type = 'offer' AND e.target_id = o.id
                    WHERE o.merchant_id = %s GROUP BY 1 ORDER BY 1""",
                (env.merchant_id,),
            )
            left = dict(cur.fetchall())
        assert left == {ids(3)[0]: ["text"], ids(3)[1]: ["image"], ids(3)[2]: ["image", "text"]}
    finally:
        with env.owner.cursor() as cur:
            cur.execute(
                """DELETE FROM embedding WHERE target_type = 'offer'
                     AND target_id IN (SELECT id FROM offer WHERE merchant_id = %s)""",
                (env.merchant_id,),
            )


def test_bagli_urunun_fiyat_ozeti_ayni_islemde_yenilenir(env: Env) -> None:
    fid = env.feed(currency="TRY")
    items = [offer(i, currency="TRY", price="100.00") for i in ids(20)]
    env.run(fid, items)
    linked = ids(20)[0]
    with env.owner.cursor() as cur:
        cur.execute("UPDATE merchant SET is_active = TRUE WHERE id = %s", (env.merchant_id,))
        cur.execute("INSERT INTO product (slug, title) VALUES ('t0112-agg', 'Test') RETURNING id")
        row = cur.fetchone()
        assert row
        product_id = int(row[0])
        cur.execute(
            "UPDATE offer SET product_id = %s WHERE merchant_id = %s AND external_id = %s",
            (product_id, env.merchant_id, linked),
        )
    summary = "SELECT min_price, offer_count, in_stock_count FROM product WHERE id = %s"
    try:
        changed = [offer(linked, currency="TRY", price="80.00"), *items[1:]]
        report = env.run(fid, changed, at=T0 + timedelta(days=1))
        assert report.aggregates_updated == 1
        assert env.one(summary, (product_id,)) == (8000, 1, 1)
        # Beslemeden cikan bagli teklif pasiflesince ozet sifirlanir.
        gone = env.run(fid, items[1:], at=T0 + timedelta(days=4), name="gone.xml")
        assert (gone.deactivated, gone.aggregates_updated) == (1, 1)
        assert env.one(summary, (product_id,)) == (None, 0, 0)
    finally:
        with env.owner.cursor() as cur:
            cur.execute("UPDATE offer SET product_id = NULL WHERE product_id = %s", (product_id,))
            cur.execute("DELETE FROM product WHERE id = %s", (product_id,))


# --------------------------------------------------------------------------
# Karar 0146: arama olayi (search_outbox) yalniz icerik degisince yazilir.


def _outbox(env: Env) -> list[tuple[str, str]]:
    return env.owner.execute(
        """SELECT o.external_id, b.reason FROM search_outbox b JOIN offer o ON o.id = b.entity_id
            WHERE b.entity = 'offer' AND o.merchant_id = %s ORDER BY b.id""",
        (env.merchant_id,),
    ).fetchall()


def _row_versions(env: Env) -> dict[str, str]:
    return dict(
        env.owner.execute(
            "SELECT external_id, xmin::text || '/' || xmax::text FROM offer WHERE merchant_id = %s",
            (env.merchant_id,),
        ).fetchall()
    )


def _prices(env: Env, ext: str) -> list[int]:
    return env.one(
        """SELECT array_agg(p.price ORDER BY p.observed_at) FROM price_point p
             JOIN offer o ON o.id = p.offer_id WHERE o.external_id = %s""",
        (ext,),
    )[0]


def test_outbox_degismeyen_besleme_hicbir_sey_yazmaz(env: Env) -> None:
    fid = env.feed()
    items = [offer(i) for i in ids(10)]
    env.run(fid, items)
    outbox_before, versions = len(_outbox(env)), _row_versions(env)
    pp_before = env.one("SELECT count(*) FROM price_point")[0]
    report = env.run(fid, items, at=T0 + timedelta(days=1), name="same.xml")
    assert (report.changed, report.price_points, report.outbox) == (0, 0, 0)
    assert len(_outbox(env)) == outbox_before
    assert _row_versions(env) == versions
    assert env.one("SELECT count(*) FROM price_point")[0] == pp_before


@pytest.mark.parametrize(
    ("label", "change"),
    [
        ("fiyat", {"price": "19.99"}),
        ("eski_fiyat", {"oldprice": "35.00"}),
        ("stok", {"available": "false"}),
        ("indirim", {"discount": "40%"}),
        ("komisyon", {"commission": "9.00%"}),
    ],
)
def test_outbox_fiyat_stok_indirim_komisyon_degisimi_olay_yazmaz(
    env: Env, label: str, change: dict[str, str]
) -> None:
    fid = env.feed()
    items = [offer(i) for i in ids(5)]
    env.run(fid, items)
    before, versions = len(_outbox(env)), _row_versions(env)
    target = ids(5)[4]
    report = env.run(
        fid, [*items[:4], offer(target, **change)], at=T0 + timedelta(days=1), name=f"{label}.xml"
    )
    # Teklif satiri yine guncellenir (okuma yolu dogru kalir); arama olayi yazilmaz.
    assert (report.changed, report.unchanged, report.outbox) == (1, 4, 0)
    assert len(_outbox(env)) == before
    after = _row_versions(env)
    assert [e for e in versions if versions[e] != after[e]] == [target]
    # Fiyat/stok gecmisi korunur: yalniz fiyat, eski fiyat ya da stok degisince yeni nokta.
    expected = 0 if label in ("indirim", "komisyon") else 1
    assert report.price_points == expected
    if label == "fiyat":
        assert _prices(env, target) == [2211, 1999]


def test_outbox_baslik_marka_kategori_gorsel_degisimi_olay_yazar(env: Env) -> None:
    fid = env.feed()
    items = [offer(i, brand="Acme") for i in ids(5)]
    env.run(fid, items)
    base = len(_outbox(env))
    a, b, c, d = ids(5)[:4]
    changed = [
        offer(a, title="Yeni baslik", brand="Acme"),
        offer(b, brand="Other"),
        offer(c, brand="Acme", category="15"),
        offer(d, brand="Acme", image_tag="v2"),
        items[4],
    ]
    report = env.run(fid, changed, at=T0 + timedelta(days=1), name="icerik.xml")
    assert (report.changed, report.outbox) == (4, 4)
    got = _outbox(env)[base:]
    assert sorted(e for e, _ in got) == sorted([a, b, c, d])
    assert {r for _, r in got} == {"feed_change"}


def test_outbox_yalniz_galeri_ek_gorseli_degisimi_olay_yazmaz(env: Env) -> None:
    # Arama/indeks yalniz kapak gorselini (offer.image_url) kullanir; galeri ek gorseli
    # `offer_image`'ta tutulur ve kendi yolundan gider.
    fid = env.feed()
    items = [offer(i) for i in ids(3)]
    env.run(fid, items)
    base = len(_outbox(env))
    report = env.run(
        fid, [offer(ids(3)[0], pictures=3), *items[1:]], at=T0 + timedelta(days=1), name="gal.xml"
    )
    assert (report.changed, report.outbox) == (1, 0)
    assert len(_outbox(env)) == base


def test_outbox_fiyat_ve_icerik_birlikte_degisince_tek_olay(env: Env) -> None:
    fid = env.feed()
    items = [offer(i) for i in ids(3)]
    env.run(fid, items)
    base = len(_outbox(env))
    target = ids(3)[0]
    env.run(
        fid,
        [offer(target, price="5.00", title="Baska ad"), *items[1:]],
        at=T0 + timedelta(days=1),
        name="ikisi.xml",
    )
    assert _outbox(env)[base:] == [(target, "feed_change")]
    assert _prices(env, target) == [2211, 500]


def test_outbox_ekleme_kaldirma_yeniden_yayin_korunur(env: Env) -> None:
    fid = env.feed()
    items = [offer(i) for i in ids(100)]
    env.run(fid, items)
    assert [r for _, r in _outbox(env)] == ["feed_insert"] * 100
    # 6 urun kaynaktan cikti: bekleme suresi gecince pasif + `feed_missing` silme olayi.
    env.run(fid, items[:94], at=T0 + timedelta(hours=24), name="g1.xml")
    env.run(fid, items[:94], at=T0 + timedelta(days=3), name="g2.xml")
    missing = [e for e, r in _outbox(env) if r == "feed_missing"]
    assert sorted(missing) == sorted(ids(100)[94:])
    ops = env.owner.execute(
        "SELECT DISTINCT op FROM search_outbox WHERE reason = 'feed_missing'"
    ).fetchall()
    assert ops == [("delete",)]
    # Geri gelince fiyat degismese bile yeniden etkinlesme olayi yazilir.
    env.run(fid, items, at=T0 + timedelta(days=4), name="g3.xml")
    assert sorted(e for e, r in _outbox(env) if r == "feed_reactivate") == sorted(ids(100)[94:])


def test_outbox_yarida_kesilen_kosu_tekrarinda_olay_cogalmaz(env: Env) -> None:
    fid = env.feed()
    items = [offer(i) for i in ids(35)]
    env.run(fid, items)
    changed = [offer(i, price="9.99") for i in ids(35)]
    with pytest.raises(_Crash):
        env.run(fid, changed, at=T0 + timedelta(days=1), name="kes.xml", fail_after_chunks=2)
    env.run(fid, changed, at=T0 + timedelta(days=1), name="kes.xml")
    again = env.run(fid, changed, at=T0 + timedelta(days=2), name="kes2.xml")
    assert (again.changed, again.price_points, again.outbox) == (0, 0, 0)
    # Yalniz ilk 35 ekleme; 35 fiyat degisimi icin hic olay yok.
    assert [r for _, r in _outbox(env)] == ["feed_insert"] * 35
    assert all(_prices(env, e) == [2211, 999] for e in ids(35))


def test_tazelik_raporu_reddedilen_surumu_ve_eksik_teklifleri_ayirir(env: Env) -> None:
    """Rapor: neden geride, kac teklif son tam surumde yok, kac teklif reddedilene bagli."""
    from feeds.freshness import FeedState, measure

    fid = env.feed(config=NO_DEACTIVATE)
    env.run(fid, [offer(i) for i in ids(60)])
    # Ikinci TAM surum 54 kayit (%90): kabul; 6 teklif son tam surumde yok (pasiflesmez).
    env.run(fid, [offer(i) for i in ids(54)], at=T0 + timedelta(days=1))
    # Kaynak daha yeni bir dosya ilan ediyor ama o kesik geliyor: reddedilir, yazim yok.
    with env.owner.cursor() as cur:
        cur.execute(
            "UPDATE feed_source SET source_updated_at = now() + interval '1 minute' WHERE id = %s",
            (fid,),
        )
    env.run(fid, [offer(i) for i in ids(54)], at=T0 + timedelta(days=2), truncate=True)

    now = datetime.now(UTC) + timedelta(hours=1)
    report = measure(env.app, "t0112-ali", now=now)
    (feed,) = report.feeds
    assert feed.state is FeedState.BEHIND
    assert feed.rejected_reason == "truncated"
    assert feed.members_missing == 6 and feed.members_in_rejected == 0
    detail = report.detail()
    assert detail["rejected_reasons"] == "truncated"
    assert detail["offers_missing_from_latest"] == 6
    assert "offers_in_rejected" not in detail
    assert detail["offers_fresh"] == 0 and detail["offers_stale"] == 60
    assert active_of(env) == 60  # hicbir sey pasiflesmedi
