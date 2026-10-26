"""Gunluk besleme tazeleme: veritabani uzerinde uctan uca (karar 0145).

Gercek Admitad/AliExpress'e istek YOK: ag ve indirme sahtedir, besleme icerigi
sentetiktir (`tests/feed_fixtures.py`). Uygulama rolu (arilla_app) kullanilir.
"""

from __future__ import annotations

import gzip
import hashlib
import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

import psycopg
import pytest

import feeds.network as network_module
import feeds.sync as sync_module
from db.connection import database_url
from feeds.daily import DAILY_LOCK_NAMESPACE, DailyOptions, run_daily
from feeds.download import Downloaded, DownloadError
from feeds.network import DiscoveredFeed, NetworkUnavailable
from feeds.sync import FeedSync, SyncSettings
from tests.feed_fixtures import AE_PROFILE, offer, yml

pytestmark = pytest.mark.integration

DOMAIN = "t0142-ali.test.invalid"
SLUG = "t0142-ali"
NETWORK = "test0142"
T0 = datetime(2026, 10, 14, 3, 0, tzinfo=UTC)
FAST = {"sleep": lambda _s: None, "settings": SyncSettings(chunk_size=10, pause_ms=0)}


def _cleanup(cur: psycopg.Cursor) -> None:
    cur.execute("SELECT id FROM merchant WHERE domain = %s", (DOMAIN,))
    row = cur.fetchone()
    feeds = f"SELECT id FROM feed_source WHERE network = '{NETWORK}'"
    if row:
        offers = f"SELECT id FROM offer WHERE merchant_id = {int(row[0])}"
        cur.execute(f"DELETE FROM search_outbox WHERE entity = 'offer' AND entity_id IN ({offers})")
        cur.execute(f"DELETE FROM price_point WHERE offer_id IN ({offers})")
        cur.execute(f"DELETE FROM offer_image WHERE offer_id IN ({offers})")
        cur.execute(f"DELETE FROM feed_source_offer WHERE offer_id IN ({offers})")
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
    cur.execute(f"DELETE FROM feed_source WHERE network = '{NETWORK}'")
    cur.execute("DELETE FROM merchant WHERE domain = %s OR slug = 't0142-other'", (DOMAIN,))
    cur.execute("DELETE FROM job_run WHERE job = 'feed_daily'")


@dataclass
class FakeNet:
    """Sahte ag: kesif bildirdigi kaynak tarihini, indirme `content`'i dondurur."""

    name: str = NETWORK
    source_updated_at: datetime | None = None
    content: bytes = b""
    discover_error: Exception | None = None
    #: Siradaki indirmeler icin hatalar (bosalinca basari).
    download_errors: list[Exception] = field(default_factory=list)
    #: Siradaki indirmelerin icerigi (bosalinca `content`).
    contents: list[bytes] = field(default_factory=list)
    downloads: int = 0
    discoveries: int = 0

    def discover(self) -> list[DiscoveredFeed]:
        self.discoveries += 1
        if self.discover_error is not None:
            raise self.discover_error
        return [
            DiscoveredFeed(
                network=NETWORK,
                external_id="6115:1",
                program_external_id="6115",
                program_name="AliExpress (test)",
                name="test",
                format="xml",
                compression="none",
                source_url_redacted="https://feed.invalid/x",
                currency="USD",
                market=None,
                source_updated_at=self.source_updated_at,
            )
        ]

    def download_url(self, external_id: str) -> str:
        return "https://feed.invalid/x"


@dataclass
class Env:
    owner: psycopg.Connection
    app: psycopg.Connection
    merchant_id: int
    feed_id: int
    net: FakeNet
    tmp: Path
    monkeypatch: pytest.MonkeyPatch

    def one(self, sql: str, params: object = None) -> tuple:
        with self.owner.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
        assert row is not None
        return row

    def load(self, offers: list[dict], *, at: datetime | None = None) -> None:
        """Ilk yukleme (asama kapilari elle gecilmis gibi): TAM surum yazar.

        Varsayilan zaman 25 saat once: offer'lar 48 saatlik deaktivasyon beklemesinin icinde.
        """
        at = at or datetime.now(UTC) - timedelta(hours=25)
        path = self.tmp / "initial.xml"
        path.write_bytes(yml(offers))
        report = FeedSync(
            self.app,
            self.feed_id,
            source_path=path,
            observed_at=at,
            settings=SyncSettings(chunk_size=10, pause_ms=0),
            sleep=lambda _s: None,
        ).run(force=True)
        assert report.status == "success"
        # Son yazim 1 gun once: sonraki kaynak guncellemesi "yeni" sayilsin.
        self.owner.execute(
            "UPDATE feed_source SET last_success_at = now() - interval '1 day' WHERE id = %s",
            (self.feed_id,),
        )

    def publish(self, offers: list[dict], *, hours_ago: float = 1.0) -> None:
        """Kaynak yeni surum yayinladi: kesifte gorunur, indirmede bu icerik gelir."""
        self.net.content = yml(offers)
        self.net.source_updated_at = datetime.now(UTC) - timedelta(hours=hours_ago)

    def daily(self, **overrides: object) -> object:
        opts = DailyOptions(
            merchant=SLUG,
            retries=int(overrides.pop("retries", 2)),  # type: ignore[arg-type]
            retry_wait_seconds=0.0,
            parallel_downloads=1,
            **overrides,  # type: ignore[arg-type]
        )
        sleeps: list[float] = []
        result = run_daily(
            self.app,
            opts,
            network_for=lambda _name: self.net,
            sleep=sleeps.append,
            sync_kwargs=dict(FAST),
        )
        result.sleeps = sleeps  # type: ignore[attr-defined]
        return result

    def fx(self, base: str = "USD") -> None:
        """Bugunun TCMB kuru (append-only; yinelenirse atlanir)."""
        self.owner.execute(
            """INSERT INTO fx_rate (source, base, quote, rate, rate_kind, effective_date, bulletin)
               VALUES ('tcmb', %s, 'TRY', 41.5, 'forex_selling', current_date, 't0142')
               ON CONFLICT DO NOTHING""",
            (base,),
        )


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    try:
        owner = psycopg.connect(database_url("DATABASE_URL_OWNER"), autocommit=True)
        app = psycopg.connect(database_url("DATABASE_URL"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner.cursor() as cur:
        _cleanup(cur)
        cur.execute(
            """INSERT INTO merchant (slug, name, domain, source_type, is_active)
               VALUES (%s, 'AliExpress (test)', %s, 'affiliate_network', FALSE) RETURNING id""",
            (SLUG, DOMAIN),
        )
        merchant_id = int(cur.fetchone()[0])  # type: ignore[index]
        cur.execute(
            """INSERT INTO feed_source
                   (network, external_id, merchant_id, status, format, currency, config)
               VALUES (%s, '6115:1', %s, 'active', 'xml', 'USD', %s::jsonb) RETURNING id""",
            (NETWORK, merchant_id, json.dumps(AE_PROFILE)),
        )
        feed_id = int(cur.fetchone()[0])  # type: ignore[index]
    net = FakeNet()
    monkeypatch.setenv("FEED_STAGING_DIR", str(tmp_path / "staging"))

    def fake_download(url: str, target: Path, **_kw: object) -> Downloaded:
        net.downloads += 1
        if net.download_errors:
            raise net.download_errors.pop(0)
        content = net.contents.pop(0) if net.contents else net.content
        target.write_bytes(content)
        digest = hashlib.sha256(content).hexdigest()
        return Downloaded(target, digest, len(content), len(content))

    monkeypatch.setattr(sync_module, "download", fake_download)
    try:
        yield Env(owner, app, merchant_id, feed_id, net, tmp_path, monkeypatch)
    finally:
        app.rollback()
        app.close()
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.close()


def ids(n: int, start: int = 0) -> list[str]:
    return [str(1006000000000000 + start + i) for i in range(n)]


def items(n: int, *, price: str = "22.11") -> list[dict]:
    return [offer(i, price=price) for i in ids(n)]


def price_points(env: Env) -> int:
    return int(
        env.one(
            "SELECT count(*) FROM price_point p JOIN offer o ON o.id = p.offer_id"
            " WHERE o.merchant_id = %s",
            (env.merchant_id,),
        )[0]
    )


# --------------------------------------------------------------------------


def test_asama_kapilari_atlanmaz_ilk_yuklenmemis_besleme_indirilmez(env: Env) -> None:
    env.publish(items(5))
    result = env.daily()
    assert result.status == "failed"  # type: ignore[attr-defined]
    assert "initial_load_required" in result.problems  # type: ignore[attr-defined]
    assert result.detail["feeds_initial_load_required"] == 1  # type: ignore[attr-defined]
    assert env.net.downloads == 0 and env.net.discoveries == 0
    assert price_points(env) == 0


def test_degisen_fiyat_yazilir_gecmis_korunur_degismeyen_yazilmaz(env: Env) -> None:
    env.load(items(20))
    env.fx()
    first_ids = ids(20)
    changed = [*items(20)[:19], offer(first_ids[19], price="19.99")]
    env.publish(changed)

    result = env.daily()
    d = result.detail  # type: ignore[attr-defined]
    assert result.status == "success", result.problems  # type: ignore[attr-defined]
    assert (d["feeds_synced"], d["created"], d["changed"], d["unchanged"]) == (1, 0, 1, 19)
    assert d["price_points"] == 1
    assert d["discovery"] == "ok" and d["fx_ok"] is True
    assert (d["offers_active"], d["offers_fresh"], d["offers_stale"]) == (20, 20, 0)

    # Guncel fiyat degisti; eski nokta duruyor (append-only gecmis), yeni nokta eklendi.
    cur_price, count = env.one(
        """SELECT o.current_price, (SELECT count(*) FROM price_point WHERE offer_id = o.id)
             FROM offer o WHERE o.merchant_id = %s AND o.external_id = %s""",
        (env.merchant_id, first_ids[19]),
    )
    assert (cur_price, count) == (1999, 2)
    assert price_points(env) == 21  # 20 ilk + 1 degisim; 19 degismeyen icin yeni satir yok


def test_ikinci_kosu_kaynak_degismediyse_hicbir_sey_yazmaz(env: Env) -> None:
    env.load(items(10))
    env.fx()
    env.publish([*items(9), offer(ids(10)[9], price="5.00")])
    assert env.daily().status == "success"  # type: ignore[attr-defined]
    before = price_points(env)
    downloads = env.net.downloads

    again = env.daily()
    assert again.status == "success", again.problems  # type: ignore[attr-defined]
    assert again.detail["feeds_unchanged"] == 1  # type: ignore[attr-defined]
    assert again.detail["price_points"] == 0  # type: ignore[attr-defined]
    assert env.net.downloads == downloads  # kaynak degismedi: yeniden indirme yok
    assert price_points(env) == before


def test_gecici_indirme_hatasi_yeniden_denenir_ve_toparlanir(env: Env) -> None:
    env.load(items(10))
    env.fx()
    env.publish([*items(9), offer(ids(10)[9], price="7.00")])
    # Onindirme (1) + FeedSync'in 3 denemesi (3) = ilk tur tamamen basarisiz; 2. tur basarili.
    env.net.download_errors = [DownloadError("http_5xx")] * 4

    result = env.daily()
    assert result.status == "success", result.problems  # type: ignore[attr-defined]
    assert result.detail["attempts"] == 2  # type: ignore[attr-defined]
    assert result.detail["price_points"] == 1  # type: ignore[attr-defined]
    assert result.sleeps == [0.0]  # type: ignore[attr-defined]


def test_kalici_hatada_fiyatlar_ellenmez_ve_sorun_kaydedilir(env: Env) -> None:
    env.load(items(10, price="10.00"))
    env.fx()
    env.publish(items(10, price="99.00"))
    env.net.download_errors = [DownloadError("http_5xx")] * 100

    result = env.daily(retries=1)
    d = result.detail  # type: ignore[attr-defined]
    assert result.status == "failed"  # type: ignore[attr-defined]
    assert d["attempts"] == 2 and d["feeds_failed"] == 1
    assert any("http_5xx" in p for p in result.problems)  # type: ignore[attr-defined]
    # Eski fiyat korunur, sifirlanmaz; besleme "geride" olarak raporlanir.
    prices = {
        r[0]
        for r in env.owner.execute(
            "SELECT current_price FROM offer WHERE merchant_id = %s", (env.merchant_id,)
        ).fetchall()
    }
    assert prices == {1000}
    assert d["feeds_behind"] == 1 and d["offers_stale"] == 10
    assert env.one("SELECT last_error_code FROM feed_source WHERE id = %s", (env.feed_id,))[0]


def test_kalici_olmayan_hata_yeniden_denenmez(env: Env) -> None:
    env.load(items(5))
    env.fx()
    env.publish(items(5, price="3.00"))
    env.net.download_errors = [DownloadError("too_large")] * 100
    result = env.daily()
    assert result.detail["attempts"] == 1  # type: ignore[attr-defined]
    assert result.sleeps == []  # type: ignore[attr-defined]


def _cut(offers: list[dict]) -> bytes:
    """gzip acisindan TAMAM, XML kapanis etiketleri EKSIK (kaynakta yarim uretilmis dosya)."""
    return gzip.compress(yml(offers, truncate=True))


def _full(offers: list[dict]) -> bytes:
    return gzip.compress(yml(offers))


def _pp_and_outbox(env: Env) -> tuple[int, int, int]:
    """(price_point, ayni teklif-ayni an cift satir, teklif basina birden fazla feed_insert)."""
    pp = price_points(env)
    dup = env.one(
        "SELECT count(*) FROM (SELECT p.offer_id, p.observed_at FROM price_point p"
        " JOIN offer o ON o.id = p.offer_id WHERE o.merchant_id = %s"
        " GROUP BY 1, 2 HAVING count(*) > 1) t",
        (env.merchant_id,),
    )[0]
    ob = env.one(
        "SELECT count(*) FROM (SELECT entity_id FROM search_outbox WHERE reason = 'feed_insert'"
        " AND entity_id IN (SELECT id FROM offer WHERE merchant_id = %s)"
        " GROUP BY 1 HAVING count(*) > 1) t",
        (env.merchant_id,),
    )[0]
    return pp, int(dup), int(ob)


def test_kesik_besleme_yeniden_denenir_ikinci_tam_surum_basarili_ve_mukerrer_yok(
    env: Env,
) -> None:
    env.load(items(10, price="10.00"))
    env.fx()
    target = [offer(i, price="20.00") for i in ids(15)]  # 10 fiyat degisimi + 5 yeni
    env.publish(target)
    env.net.contents = [_cut(target), _full(target)]

    result = env.daily()
    d = result.detail  # type: ignore[attr-defined]
    assert result.status == "success", result.problems  # type: ignore[attr-defined]
    assert d["attempts"] == 2 and d["feeds_gate_rejected"] == 0
    assert result.sleeps == [0.0]  # type: ignore[attr-defined]
    assert env.net.downloads == 2
    statuses = [
        r[0]
        for r in env.owner.execute(
            "SELECT status FROM source_snapshot WHERE feed_source_id = %s AND kind = 'full'"
            " ORDER BY id",
            (env.feed_id,),
        ).fetchall()
    ]
    assert statuses[-2:] == ["rejected", "complete"]
    # Mukerrer yok: 15 teklif; ilk yukleme 10 + 10 degisim + 5 yeni = 25 nokta;
    # ayni anda cift satir ve cift feed_insert yok.
    offers = env.one("SELECT count(*) FROM offer WHERE merchant_id = %s", (env.merchant_id,))[0]
    assert offers == 15
    assert _pp_and_outbox(env) == (25, 0, 0)
    # Optimizasyon korunur: fiyat degisimi outbox'a olay yazmaz.
    changes = env.one(
        "SELECT count(*) FROM search_outbox WHERE reason = 'feed_change'"
        " AND entity_id IN (SELECT id FROM offer WHERE merchant_id = %s)",
        (env.merchant_id,),
    )[0]
    assert changes == 0


def test_tum_denemeler_kesikse_kosu_partial_ve_basarisiz_cikar(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    from feeds.__main__ import main

    env.load(items(10, price="10.00"))
    env.fx()
    target = [offer(i, price="20.00") for i in ids(15)]
    env.publish(target)
    cut = _cut(target)
    env.net.contents = [cut, cut, cut]

    result = env.daily()  # retries=2 -> 3 deneme
    assert result.status == "partial"  # type: ignore[attr-defined]
    assert result.detail["attempts"] == 3  # type: ignore[attr-defined]
    assert env.net.downloads == 3
    assert any("truncated" in p for p in result.problems)  # type: ignore[attr-defined]
    assert result.detail["deactivated"] == 0  # type: ignore[attr-defined]
    # Ayni kesik icerik tekrarlansa da fiyat noktasi cogalmaz.
    pp, dup, ob = _pp_and_outbox(env)
    assert (dup, ob) == (0, 0)
    env.net.contents = [cut]
    env.daily(retries=0)
    assert _pp_and_outbox(env)[0] == pp
    # CLI: kismi kosu basarisiz cikis kodu doner.
    env.net.contents = [cut, cut, cut]
    monkeypatch.setenv("JOB_RUN_TRIGGER", "cron")
    network_module.register(NETWORK, lambda: env.net)
    try:
        code = main(
            ["daily", "--merchant", SLUG, "--parallel-downloads", "1", "--retry-wait-seconds", "0"]
        )
    finally:
        network_module._REGISTRY.pop(NETWORK, None)
    assert code != 0


def test_kesik_deneme_no_deactivate_ve_kapilari_korur(env: Env) -> None:
    env.owner.execute(
        "UPDATE feed_source SET config = config || %s::jsonb WHERE id = %s",
        ('{"no_deactivate": true}', env.feed_id),
    )
    env.load(items(10, price="10.00"))
    env.fx()
    # Kaynak 1 urunu cikarmis (%90, karar 0152 esiginin ustu); ilk teslimat kesik.
    target = [offer(i, price="12.00") for i in ids(9)]
    env.publish(target)
    env.net.contents = [_cut(target), _full(target)]

    result = env.daily()
    assert result.status == "success", result.problems  # type: ignore[attr-defined]
    assert result.detail["attempts"] == 2  # type: ignore[attr-defined]
    assert result.detail["deactivated"] == 0  # type: ignore[attr-defined]
    active = env.one(
        "SELECT count(*) FILTER (WHERE is_active) FROM offer WHERE merchant_id = %s",
        (env.merchant_id,),
    )[0]
    assert active == 10


def test_kesik_deneme_hicbir_satir_yazmaz_yalniz_tam_surum_yazar(env: Env) -> None:
    """Karar 0152: kesik ilk teslimat fiyat/teklif yazmaz; tam ikinci teslimat yazar."""
    env.load(items(10, price="10.00"))
    env.fx()
    target = [offer(i, price="20.00") for i in ids(10)] + [offer(i) for i in ids(5, 100)]
    env.publish(target)
    before = price_points(env)
    env.net.contents = [_cut(target), _cut(target), _cut(target)]
    result = env.daily()  # retries=2 -> 3 deneme, hepsi kesik
    assert result.status == "partial"  # type: ignore[attr-defined]
    assert result.detail["attempts"] == 3  # type: ignore[attr-defined]
    assert price_points(env) == before  # tek fiyat noktasi yazilmadi
    offers = env.one("SELECT count(*) FROM offer WHERE merchant_id = %s", (env.merchant_id,))[0]
    assert offers == 10  # yeni teklif yok
    assert result.detail["records"] == 0  # type: ignore[attr-defined]


def test_anormal_dusus_yeniden_denenmez_ve_yazmadan_karantinaya_alinir(env: Env) -> None:
    env.owner.execute(
        "UPDATE feed_source SET config = config || %s::jsonb WHERE id = %s",
        ('{"no_deactivate": true}', env.feed_id),
    )
    env.load(items(10, price="10.00"))
    env.fx()
    target = [offer(i, price="12.00") for i in ids(5)]  # %50: anormal dusus
    env.publish(target)
    before = price_points(env)
    result = env.daily()
    assert result.detail["attempts"] == 1  # type: ignore[attr-defined]
    assert env.net.downloads == 1
    assert f"feed_{env.feed_id}:too_few_records" in result.problems  # type: ignore[attr-defined]
    assert price_points(env) == before
    active = env.one(
        "SELECT count(*) FILTER (WHERE is_active) FROM offer WHERE merchant_id = %s",
        (env.merchant_id,),
    )[0]
    assert active == 10


def test_icerik_kapilari_yeniden_denenmez(env: Env) -> None:
    env.load(items(25, price="10.00"))
    env.fx()
    broken = items(25, price="11.00")
    for i in (3, 7, 9):
        broken[i]["price"] = "abc"
    env.publish(broken)
    result = env.daily()
    assert result.detail["attempts"] == 1  # type: ignore[attr-defined]
    assert env.net.downloads == 1
    assert result.sleeps == []  # type: ignore[attr-defined]


def test_bozuk_fiyatlar_reddedilir_kapi_surumu_reddeder_hicbir_sey_pasiflesmez(env: Env) -> None:
    env.load(items(25, price="10.00"))
    env.fx()
    broken = items(25, price="11.00")
    broken[3]["price"] = "abc"
    broken[7]["price"] = "-4"
    broken[9]["price"] = ""
    env.publish(broken)

    result = env.daily()
    d = result.detail  # type: ignore[attr-defined]
    # 3/25 = %12 > %2 red orani esigi: tamlik kapisi surumu reddeder.
    assert result.status == "partial"  # type: ignore[attr-defined]
    assert d["feeds_gate_rejected"] == 1
    assert any("error_rate" in p for p in result.problems)  # type: ignore[attr-defined]
    assert d["rejected"] == 3
    # Kapi gecmese de gecerli kayitlar yazilir; hicbir offer pasiflesmez, hicbir fiyat sifirlanmaz.
    active, zero = env.one(
        "SELECT count(*) FILTER (WHERE is_active), count(*) FILTER (WHERE current_price <= 0)"
        " FROM offer WHERE merchant_id = %s",
        (env.merchant_id,),
    )
    assert (active, zero) == (25, 0)
    assert d["deactivated"] == 0


def test_kaynakta_olmayan_urun_aninda_pasiflesmez_fiyati_sifirlanmaz(env: Env) -> None:
    env.load(items(20, price="10.00"))
    env.fx()
    env.publish(items(20, price="10.00")[:19])  # 1 urun kaynaktan dustu

    result = env.daily()
    assert result.status == "success", result.problems  # type: ignore[attr-defined]
    # 48 saatlik bekleme: simdi pasiflesmez, fiyati ve gecmisi aynen kalir.
    active, price = env.one(
        "SELECT count(*) FILTER (WHERE is_active), max(current_price) FROM offer"
        " WHERE merchant_id = %s",
        (env.merchant_id,),
    )
    assert (active, price) == (20, 1000)
    assert result.detail["deactivated"] == 0  # type: ignore[attr-defined]


def test_kur_yoksa_fiyat_yazilir_ama_calisma_kismi_ve_try_uretilmez(env: Env) -> None:
    env.load(items(6))
    env.publish([*items(5), offer(ids(6)[5], price="8.00")])

    result = env.daily(fx_base="ZZZ")  # kuru olmayan para birimi: TCMB bulteni yok
    d = result.detail  # type: ignore[attr-defined]
    assert result.status == "partial"  # type: ignore[attr-defined]
    assert d["fx_stale"] is True and d["fx_ok"] is False
    assert "fx_stale" in result.problems  # type: ignore[attr-defined]
    # Orijinal USD fiyat dogru yazildi; TRY'ye cevrilip yazilmadi (para birimi USD kaldi).
    cur_, price = env.one(
        "SELECT currency, current_price FROM offer WHERE merchant_id = %s AND external_id = %s",
        (env.merchant_id, ids(6)[5]),
    )
    assert (cur_.strip(), price) == ("USD", 800)


def test_kaynak_bayatsa_fiyat_guncel_sayilmaz(env: Env) -> None:
    env.load(items(8))
    env.fx()
    # Kaynak 30 gundur guncellenmemis; biz yazdik ama fiyatlar kaynakta eski.
    env.publish(items(8), hours_ago=24 * 30)
    env.owner.execute(
        "UPDATE feed_source SET last_success_at = now() WHERE id = %s", (env.feed_id,)
    )
    result = env.daily()
    d = result.detail  # type: ignore[attr-defined]
    assert result.status == "partial"  # type: ignore[attr-defined]
    assert d["feeds_source_stale"] == 1
    assert (d["offers_fresh"], d["offers_stale"]) == (0, 8)
    assert d["source_age_hours"] > 24 * 29


def test_kesif_basarisizsa_senkronizasyon_surer_ama_calisma_kismi(env: Env) -> None:
    env.load(items(5))
    env.fx()
    env.publish(items(5))
    env.net.discover_error = NetworkUnavailable("admitad /advcampaigns -> 503")
    result = env.daily(retries=1)
    assert result.status == "partial"  # type: ignore[attr-defined]
    assert result.detail["discovery"] == "failed"  # type: ignore[attr-defined]
    assert env.net.discoveries == 2  # ilk deneme + 1 yeniden deneme
    assert "discovery_failed:test0142" in result.problems  # type: ignore[attr-defined]


def test_kimlik_bilgisi_yoksa_kesif_yeniden_denenmez(env: Env) -> None:
    env.load(items(5))
    env.publish(items(5))
    env.net.discover_error = NetworkUnavailable("ADMITAD_CLIENT_ID tanimli degil")
    env.daily(retries=3)
    assert env.net.discoveries == 1


def test_es_zamanli_ikinci_gunluk_kosu_sessizce_vazgecer(env: Env) -> None:
    env.load(items(5))
    env.publish(items(5, price="4.00"))
    other = psycopg.connect(database_url("DATABASE_URL"))
    try:
        other.execute("SELECT pg_advisory_lock(%s, %s)", (DAILY_LOCK_NAMESPACE, env.merchant_id))
        result = env.daily()
        assert result.status == "success"  # type: ignore[attr-defined]
        assert result.detail == {"skipped": "already_running"}  # type: ignore[attr-defined]
        assert env.net.downloads == 0 and env.net.discoveries == 0
    finally:
        other.execute("SELECT pg_advisory_unlock_all()")
        other.close()
    # Kilit birakilinca normal calisir.
    assert env.daily().detail.get("skipped") is None  # type: ignore[attr-defined]


def test_gunluk_kosu_kilidi_bitince_birakilir(env: Env) -> None:
    env.load(items(3))
    env.publish(items(3))
    env.daily()
    other = psycopg.connect(database_url("DATABASE_URL"))
    try:
        got = other.execute(
            "SELECT pg_try_advisory_lock(%s, %s)", (DAILY_LOCK_NAMESPACE, env.merchant_id)
        ).fetchone()
        assert got == (True,)
    finally:
        other.execute("SELECT pg_advisory_unlock_all()")
        other.close()


def test_pasif_ve_olmayan_merchant(env: Env) -> None:
    result = run_daily(env.app, DailyOptions(merchant="yok-boyle-bir-magaza"))
    assert result.status == "failed" and result.problems == ["merchant_not_found"]
    env.owner.execute("UPDATE feed_source SET status = 'paused' WHERE id = %s", (env.feed_id,))
    assert "no_active_feeds" in env.daily().problems  # type: ignore[attr-defined]


def test_diger_kaynaklarin_beslemelerine_dokunmaz(env: Env) -> None:
    other = env.one(
        """INSERT INTO merchant (slug, name, domain, source_type, is_active)
           VALUES ('t0142-other', 'Diger', 't0142-other.test.invalid', 'affiliate_network', FALSE)
           RETURNING id"""
    )
    try:
        env.owner.execute(
            """INSERT INTO feed_source (network, external_id, merchant_id, status, format, currency,
                                        config)
               VALUES (%s, '999:1', %s, 'active', 'xml', 'USD', %s::jsonb)""",
            (NETWORK, other[0], json.dumps(AE_PROFILE)),
        )
        env.load(items(4))
        env.publish(items(4, price="2.00"))
        env.daily()
        # Diger merchant'in beslemesi senkronize edilmedi (indirme tek: yalniz AliExpress).
        assert env.net.downloads == 1
        assert env.one(
            "SELECT last_success_at IS NULL FROM feed_source WHERE external_id = '999:1'"
            " AND network = %s",
            (NETWORK,),
        ) == (True,)
    finally:
        env.owner.execute(
            "DELETE FROM feed_source WHERE external_id = '999:1' AND network = %s", (NETWORK,)
        )
        env.owner.execute("DELETE FROM merchant WHERE slug = 't0142-other'")


# --------------------------------------------------------------------------
# CLI: job_run kaydi ve cikis kodu


def test_cli_job_run_kaydi_cron_tetigi_ve_cikis_kodu(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    from feeds.__main__ import main

    env.load(items(6))
    env.fx()
    env.publish([*items(5), offer(ids(6)[5], price="6.00")])
    monkeypatch.setenv("JOB_RUN_TRIGGER", "cron")
    network_module.register(NETWORK, lambda: env.net)
    try:
        code = main(["daily", "--merchant", SLUG, "--parallel-downloads", "1"])
    finally:
        network_module._REGISTRY.pop(NETWORK, None)
    assert code == 0
    trigger, status, detail = env.one(
        "SELECT trigger, status, detail FROM job_run WHERE job = 'feed_daily'"
        " ORDER BY id DESC LIMIT 1"
    )
    assert (trigger, status) == ("cron", "success")
    assert detail["price_points"] == 1 and detail["offers_fresh"] == 6
    # Adres/kimlik/sir detay'a girmez.
    assert "feed.invalid" not in json.dumps(detail)


def test_cli_sync_due_ayni_sonucu_verir(env: Env) -> None:
    """`sync-due` ortak calistiriciya tasindi: davranisi degismedi."""
    from feeds.__main__ import main

    env.load(items(6))
    env.publish([*items(5), offer(ids(6)[5], price="6.00")])
    network_module.register(NETWORK, lambda: env.net)
    try:
        code = main(["sync-due", "--parallel-downloads", "1"])
    finally:
        network_module._REGISTRY.pop(NETWORK, None)
    assert code == 0
    assert price_points(env) == 7  # 6 ilk yukleme + 1 degisim
