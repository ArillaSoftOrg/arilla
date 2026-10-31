"""Gunluk tazeleme, cok bantli (fiyat bandi) AliExpress beslemeleri (karar 0162).

Gercek ag yok: besleme icerigi sentetik, indirme sahtedir. `test_feeds_daily.py` ile ayni
yerel veritabani ve ayni `env` duzeni (arilla_app rolu) kullanilir.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

import feeds.sync as sync_module
from feeds import runner
from feeds.daily import DailyOptions, run_daily
from feeds.download import Downloaded
from feeds.network import DiscoveredFeed
from feeds.sync import FeedSync, SyncSettings, load_feed
from tests.feed_fixtures import AE_PROFILE, offer, yml
from tests.test_feeds_daily import FAST, NETWORK, SLUG, Env, env, ids  # noqa: F401

pytestmark = pytest.mark.integration


@dataclass
class MultiNet:
    """Birden cok besleme: her birinin icerigi ve kaynak tarihi ayri; indirme sirasi kayitli."""

    name: str = NETWORK
    feeds: dict[str, tuple[bytes, datetime]] = field(default_factory=dict)
    downloads: list[str] = field(default_factory=list)

    def put(self, external_id: str, offers: list[dict], *, hours_ago: float) -> None:
        self.feeds[external_id] = (yml(offers), datetime.now(UTC) - timedelta(hours=hours_ago))

    def discover(self) -> list[DiscoveredFeed]:
        return [
            DiscoveredFeed(
                network=NETWORK,
                external_id=ext,
                program_external_id="6115",
                program_name="AliExpress (test)",
                name=ext,
                format="xml",
                compression="none",
                source_url_redacted="https://feed.invalid/x",
                currency="USD",
                market=None,
                source_updated_at=at,
            )
            for ext, (_content, at) in self.feeds.items()
        ]

    def download_url(self, external_id: str) -> str:
        return f"https://feed.invalid/{external_id}"


@pytest.fixture
def net(env: Env) -> MultiNet:  # noqa: F811
    multi = MultiNet()

    def fake_download(url: str, target: Path, **_kw: object) -> Downloaded:
        ext = url.rsplit("/", 1)[1]
        multi.downloads.append(ext)
        content = multi.feeds[ext][0]
        target.write_bytes(content)
        return Downloaded(target, hashlib.sha256(content).hexdigest(), len(content), len(content))

    env.monkeypatch.setattr(sync_module, "download", fake_download)
    return multi


def add_feed(env: Env, external_id: str, *, status: str = "active") -> int:  # noqa: F811
    with env.owner.cursor() as cur:
        cur.execute(
            """INSERT INTO feed_source
                   (network, external_id, merchant_id, status, format, currency, config)
               VALUES (%s, %s, %s, %s, 'xml', 'USD', %s::jsonb) RETURNING id""",
            (NETWORK, external_id, env.merchant_id, status, json.dumps(AE_PROFILE)),
        )
        return int(cur.fetchone()[0])  # type: ignore[index]


def first_load(env: Env, feed_id: int, offers: list[dict], name: str) -> None:  # noqa: F811
    """Ilk yukleme (asama kapilari elle gecilmis gibi): TAM surum yazar."""
    path = env.tmp / f"initial-{name}.xml"
    path.write_bytes(yml(offers))
    report = FeedSync(
        env.app,
        feed_id,
        source_path=path,
        observed_at=datetime.now(UTC) - timedelta(hours=25),
        settings=SyncSettings(chunk_size=10, pause_ms=0),
        sleep=lambda _s: None,
    ).run(force=True)
    assert report.status == "success"
    env.owner.execute(
        "UPDATE feed_source SET last_success_at = now() - interval '1 day' WHERE id = %s",
        (feed_id,),
    )


def daily(env: Env, net: MultiNet, **opts: object):  # noqa: F811
    monotonic = opts.pop("monotonic", None)
    options = DailyOptions(
        merchant=SLUG,
        retries=0,
        retry_wait_seconds=0.0,
        parallel_downloads=1,
        **opts,  # type: ignore[arg-type]
    )
    kwargs = {"monotonic": monotonic} if monotonic is not None else {}
    return run_daily(
        env.app,
        options,
        network_for=lambda _name: net,
        sleep=lambda _s: None,
        sync_kwargs=dict(FAST),
        **kwargs,  # type: ignore[arg-type]
    )


def complete_snapshots(env: Env, feed_id: int | None = None) -> int:  # noqa: F811
    sql = "SELECT count(*) FROM source_snapshot WHERE status = 'complete'"
    if feed_id is None:
        return int(
            env.one(
                sql + " AND feed_source_id IN (SELECT id FROM feed_source WHERE network = %s)",
                (NETWORK,),
            )[0]
        )
    return int(env.one(sql + " AND feed_source_id = %s", (feed_id,))[0])


def points(env: Env, product_id: str) -> list[tuple[int, int]]:  # noqa: F811
    """(offer_id, fiyat) satirlari, gozlem zamanina gore."""
    with env.owner.cursor() as cur:
        cur.execute(
            """SELECT p.offer_id, p.price FROM price_point p JOIN offer o ON o.id = p.offer_id
                WHERE o.merchant_id = %s AND o.external_id = %s ORDER BY p.observed_at""",
            (env.merchant_id, product_id),
        )
        return [(int(a), int(b)) for a, b in cur.fetchall()]


def offer_row(env: Env, product_id: str) -> tuple[int, int]:  # noqa: F811
    row = env.one(
        "SELECT id, current_price FROM offer WHERE merchant_id = %s AND external_id = %s",
        (env.merchant_id, product_id),
    )
    return int(row[0]), int(row[1])


def record_run(env: Env, result: object) -> None:  # noqa: F811
    """CLI'nin `job_run.track` ile yaptigini yapar: bir sonraki kosu ertelenenleri buradan okur."""
    env.owner.execute(
        "INSERT INTO job_run (job, trigger, status, finished_at, detail)"
        " VALUES ('feed_daily', 'cron', %s, now(), %s::jsonb)",
        (result.status, json.dumps(result.detail)),  # type: ignore[attr-defined]
    )


# -- 1. Ilk yuklemesi bekleyen besleme gunluk isi bozmaz ---------------------------------


def test_ilk_yuklemesi_bekleyen_besleme_yuklu_beslemenin_gunlugunu_bozmaz(
    env: Env,  # noqa: F811
    net: MultiNet,
) -> None:
    env.load(ids_offers(5))
    pending = add_feed(env, "6115:2")
    env.fx()
    net.put("6115:1", [offer(i, price="19.99") for i in ids(5)], hours_ago=1)
    net.put("6115:2", ids_offers(3, start=100), hours_ago=1)

    result = daily(env, net)

    assert result.status == "success", result.problems
    assert result.problems == []
    assert result.exit_code == 0
    assert result.detail["feeds_initial_load_required"] == 1
    assert result.detail["feeds_initial_load_ids"] == [pending]
    assert net.downloads == ["6115:1"]  # bekleyen besleme asama kapilari olmadan indirilmez
    assert complete_snapshots(env, pending) == 0


def test_duraklatilmis_besleme_gunlugu_bozmaz(env: Env, net: MultiNet) -> None:  # noqa: F811
    env.load(ids_offers(5))
    add_feed(env, "6115:2", status="paused")
    env.fx()
    net.put("6115:1", [offer(i, price="19.99") for i in ids(5)], hours_ago=1)
    net.put("6115:2", ids_offers(3, start=100), hours_ago=1)

    result = daily(env, net)

    assert result.status == "success", result.problems
    assert net.downloads == ["6115:1"]


def test_hic_yuklu_besleme_yoksa_kosu_basarisiz_kalir(env: Env, net: MultiNet) -> None:  # noqa: F811
    net.put("6115:1", ids_offers(3), hours_ago=1)
    result = daily(env, net)
    assert result.status == "failed"
    assert "initial_load_required" in result.problems
    assert net.downloads == []


# -- 2. Sure butcesi ve adil siralama ------------------------------------------------------


def three_loaded_feeds(env: Env, net: MultiNet) -> dict[str, int]:  # noqa: F811
    """Uc yuklu besleme; kaynak tarihleri 6115:1 (en eski) < 6115:2 < 6115:3 (en taze)."""
    feed_ids = {"6115:1": env.feed_id}
    env.load(ids_offers(4, start=0))
    for n, ext in ((2, "6115:2"), (3, "6115:3")):
        feed_ids[ext] = add_feed(env, ext)
        first_load(env, feed_ids[ext], ids_offers(4, start=n * 100), ext.replace(":", "-"))
    env.fx()
    return feed_ids


def republish_all(net: MultiNet, round_no: int) -> None:
    """Kaynak her gun yeniden uretilir: ayni goreli siralama, hepsi yeniden 'due'."""
    price = f"{20 + round_no}.00"
    for n, (ext, hours) in enumerate((("6115:1", 9.0), ("6115:2", 8.0), ("6115:3", 7.0)), start=1):
        net.put(
            ext,
            [offer(i, price=price) for i in ids(4, start=n * 100 if n > 1 else 0)],
            hours_ago=hours,
        )


def budget_clock(env: Env):  # noqa: F811
    """Her tamamlanan besleme 100 sn sayilir: surum sayisindan, is parcacigindan bagimsiz."""
    base = complete_snapshots(env)
    return lambda: 100.0 * (complete_snapshots(env) - base)


def test_butce_dolunca_yeni_besleme_baslamaz_kalanlar_ertelenir_hata_degildir(
    env: Env,  # noqa: F811
    net: MultiNet,
) -> None:
    feed_ids = three_loaded_feeds(env, net)
    republish_all(net, 1)

    result = daily(env, net, budget=timedelta(seconds=50), monotonic=budget_clock(env))

    assert result.status == "success", result.problems
    assert result.detail["feeds_synced"] == 1
    assert result.detail["feeds_deferred"] == 2
    # Kaynagi en eski olan once islendi; ertelenenler en taze iki besleme.
    assert complete_snapshots(env, feed_ids["6115:1"]) == 2
    assert complete_snapshots(env, feed_ids["6115:2"]) == 1
    assert result.detail["feeds_deferred_ids"] == sorted([feed_ids["6115:2"], feed_ids["6115:3"]])
    # Ertelenenler icin on indirme dosyalari birakilmaz.
    staging = Path(env.tmp / "staging")
    assert not [p for p in staging.glob("*") if p.is_file()]


def test_surekli_dolan_butcede_ertelenen_besleme_sonunda_calisir(
    env: Env,  # noqa: F811
    net: MultiNet,
) -> None:
    feed_ids = three_loaded_feeds(env, net)
    served: list[int] = []
    for round_no in range(1, 4):
        republish_all(net, round_no)
        before = {ext: complete_snapshots(env, fid) for ext, fid in feed_ids.items()}
        result = daily(env, net, budget=timedelta(seconds=50), monotonic=budget_clock(env))
        assert result.status == "success", result.problems
        record_run(env, result)
        after = {ext: complete_snapshots(env, fid) for ext, fid in feed_ids.items()}
        served += [feed_ids[e] for e in feed_ids if after[e] > before[e]]
    # Her tur tek besleme: ayni (en eski kaynakli) beslemeye sonsuza dek donmez.
    assert sorted(served) == sorted(feed_ids.values())


def test_siralama_kaynagi_en_eski_olan_once_en_taze_son(env: Env, net: MultiNet) -> None:  # noqa: F811
    # Kimlik sirasi kaynak sirasinin TERSI: 6115:1 en dusuk kimlikli ama en taze.
    stale = add_feed(env, "6115:9")
    first_load(env, stale, ids_offers(2, start=500), "stale")
    env.load(ids_offers(2))
    env.fx()
    net.put("6115:1", [offer(i, price="19.00") for i in ids(2)], hours_ago=1)
    net.put("6115:9", [offer(i, price="19.00") for i in ids(2, start=500)], hours_ago=5)
    result = daily(env, net)
    assert result.status == "success", result.problems
    assert net.downloads == ["6115:9", "6115:1"]
    assert stale > env.feed_id


# -- 3. Birden cok bantta bulunan urun: kimlik ve fiyat gecmisi korunur ----------------------


def shared_scenario(env: Env) -> tuple[int, int, str]:  # noqa: F811
    """A (6115:1, en dusuk kimlik) ve B (6115:2) ayni urunu tasir; ikisi de 20.00 USD gormus."""
    shared = ids(1, start=900)[0]
    feed_b = add_feed(env, "6115:2")
    first_load(env, feed_b, [offer(shared, price="20.00"), *ids_offers(2, start=700)], "b")
    env.load([offer(shared, price="20.00"), *ids_offers(2, start=600)])
    env.fx()
    return env.feed_id, feed_b, shared


def publish_price_move(net: MultiNet, shared: str) -> None:
    """Urun 20 -> 30 USD oldu. A (kimligi dusuk) en TAZE dosya ve 30'u gorur; B daha ESKI
    dosya, urunu hala 20'de tutar. Kimlik sirasiyla islenirse eski fiyat taze fiyatin
    uzerine yazilir; kaynak tazelik sirasiyla yazilmaz."""
    # Dosyalar her gun degisir (baska urunlerin fiyati oynar): ikisi de "yeni icerik" gelir.
    other = [offer(i, price="21.50") for i in ids(2, start=600)]
    net.put("6115:1", [offer(shared, price="30.00"), *other], hours_ago=1)
    other = [offer(i, price="21.50") for i in ids(2, start=700)]
    net.put("6115:2", [offer(shared, price="20.00"), *other], hours_ago=4)


def test_bantlar_arasi_urun_ayni_offer_kimligi_tek_gecmis_sahte_degisim_yok(
    env: Env,  # noqa: F811
    net: MultiNet,
) -> None:
    feed_a, feed_b, shared = shared_scenario(env)
    offer_id, _price = offer_row(env, shared)
    before = points(env, shared)
    assert before == [(offer_id, 2000)]  # tek ilk nokta; ikinci yukleme degismeyeni yazmadi

    publish_price_move(net, shared)
    result = daily(env, net)
    assert result.status == "success", result.problems
    assert net.downloads == ["6115:2", "6115:1"]  # eski kaynak once, taze kaynak son

    after = points(env, shared)
    assert after == [(offer_id, 2000), (offer_id, 3000)]  # 20 -> 30, geri oynama yok
    assert offer_row(env, shared) == (offer_id, 3000)
    count = env.one(
        "SELECT count(*) FROM offer WHERE merchant_id = %s AND external_id = %s",
        (env.merchant_id, shared),
    )
    assert int(count[0]) == 1
    members = env.one("SELECT count(*) FROM feed_source_offer WHERE offer_id = %s", (offer_id,))
    assert int(members[0]) == 2  # her iki bantta uyelik korunur, hicbiri silinmedi

    # Kaynaklar degismeden ikinci kosu: yeni nokta yok.
    again = daily(env, net)
    assert again.status == "success", again.problems
    assert points(env, shared) == after
    assert feed_a != feed_b


def test_ters_sirada_islenirse_sahte_degisim_olusur_siralama_bu_yuzden_zorunlu(
    env: Env,  # noqa: F811
    net: MultiNet,
) -> None:
    """Karakterizasyon: sira kimlik sirasi ise (taze A once, eski B sonra) fiyat
    20 -> 30 -> 20 oynar. Gunluk is bu yuzden kaynagi eski olani once isler (yukaridaki test)."""
    feed_a, feed_b, shared = shared_scenario(env)
    before = len(points(env, shared))
    publish_price_move(net, shared)
    env.owner.execute(
        "UPDATE feed_source SET source_updated_at = now() - interval '1 hour', "
        "last_success_at = now() - interval '1 day' WHERE id IN (%s, %s)",
        (feed_a, feed_b),
    )
    by_id = [load_feed(env.app, fid) for fid in sorted((feed_a, feed_b))]
    env.app.rollback()
    runner.sync_feeds(
        env.app,
        by_id,
        network_for=lambda _n: net,
        parallel=1,
        force=True,
        sync_kwargs=dict(FAST),
    )
    assert len(points(env, shared)) == before + 2  # 30, sonra yeniden 20: sahte oynama


def ids_offers(n: int, *, start: int = 0) -> list[dict]:
    return [offer(i) for i in ids(n, start=start)]
