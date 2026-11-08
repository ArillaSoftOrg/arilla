"""Cozumleyici, yoneticinin es zamanli bagini ezmez (korumali LINK_OFFER).

Yaris: `resolve` teklifi `product_id IS NULL` iken secer, skorlar, sonra baglar. Arada
yonetici `/yonetim/eslestirme`'de ayni teklifi baska bir urune onaylarsa (`approveMatch`)
eski kosulsuz `UPDATE offer SET product_id` yoneticinin bagini sessizce eziyordu.

Testler iki GERCEK PostgreSQL baglantisi kullanir. Sira rastgele uyku ile degil, kancalarla
(resolve'un secim ile baglama arasina yerlestirilmis) ve `pg_stat_activity` /
`pg_blocking_pids` / `pg_locks` ile gozlenen kilit beklemesiyle belirlenir.

Kilit duzeyi notu: `approveMatch`'in `SELECT ... FOR UPDATE`'i teklif satirini FOR UPDATE
kilitler; bu, `match_candidate` INSERT'inin yabanci anahtar denetimindeki FOR KEY SHARE ile
catisir, yani resolve LINK_OFFER'a varmadan aday UPSERT'inde bekler. Korumali UPDATE'in kilidi
bekleyip satirin son surumunu yeniden degerlendirdigini kanitlayan test bu yuzden teklifi
anahtar disi bir UPDATE ile (FOR NO KEY UPDATE) tutar: FK denetimi gecer, bekleme LINK_OFFER'da
olur.

Yonetici tarafi `packages/core/src/admin/matching-queue.ts` `approveMatch`'in SQL'ini
birebir taklit eder: `match_candidate JOIN offer ... FOR UPDATE` (OF yok: iki satir da
kilitlenir), bagli urun kontrolu, sonra kosulsuz baglama.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import psycopg
import pytest
from psycopg import pq

from db.connection import database_url
from resolve import pipeline
from resolve.pipeline import ResolveCounts, resolve_offers

pytestmark = pytest.mark.integration

DOMAIN = "test-resolve-korumali-bag.example"
BRAND_SLUG = "test-korumali-bag-marka"
MATCH_SLUG = "test-korumali-bag-eslesen"
ADMIN_SLUG = "test-korumali-bag-yonetici"
#: Gecerli EAN-13: teklif ile `MATCH` urunu kesin kimlikle (gtin) otomatik kabul edilir.
GTIN = "4006381333931"
MATCH_TITLE = "Zephyrion Korumali Termos Celik 750 ml"
ADMIN_TITLE = "Vortelik Yonetici Secimi Ahsap Kesme Tahtasi"
#: Hicbir urune benzemeyen basliklar: yeni urun yolu.
NEW_TITLES = (
    "Qubrandel Eslesmeyen Seramik Vazo Mavi",
    "Huxomira Eslesmeyen Keten Masa Ortusu",
    "Plontavik Eslesmeyen Bambu Sepet Buyuk",
)
LOCK_TIMEOUT = "15s"
STATEMENT_TIMEOUT = "30s"
IDLE_IN_TRANSACTION_TIMEOUT = "60s"
WAIT_SECONDS = 15.0

CLEANUP = (
    """DELETE FROM match_candidate WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = %(domain)s)""",
    """CREATE TEMP TABLE IF NOT EXISTS _p AS SELECT o.product_id FROM offer o
        JOIN merchant m ON m.id = o.merchant_id WHERE m.domain = %(domain)s""",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = %(domain)s)",
    """DELETE FROM product WHERE id IN (SELECT product_id FROM _p WHERE product_id IS NOT NULL)
        OR slug = ANY(%(product_slugs)s)""",
    "DROP TABLE _p",
    "DELETE FROM merchant WHERE domain = %(domain)s",
    "DELETE FROM brand WHERE slug = %(brand_slug)s",
)
PARAMS = {
    "domain": DOMAIN,
    "product_slugs": [MATCH_SLUG, ADMIN_SLUG],
    "brand_slug": BRAND_SLUG,
}

#: `approveMatch`: drizzle `.for("update")` -> `FOR UPDATE` (OF yok).
ADMIN_LOCK = """
SELECT mc.offer_id, mc.product_id, o.product_id
  FROM match_candidate mc
  JOIN offer o ON o.id = mc.offer_id
 WHERE mc.id = %s AND mc.status = 'pending'
   FOR UPDATE
"""


@dataclass
class Seed:
    merchant_id: int
    match_product: int
    admin_product: int
    #: GTIN ile `match_product`'a otomatik kabul edilecek teklif.
    auto_offer: int
    #: Eslesmeyen, yeni urun acacak teklifler (NEW_TITLES sirasiyla).
    new_offers: tuple[int, ...]
    #: Her teklif icin `admin_product`'a `pending` aday: offer_id -> match_candidate.id
    admin_candidates: dict[int, int]


def _connect() -> psycopg.Connection:
    conn = psycopg.connect(database_url("DATABASE_URL_OWNER"), connect_timeout=10)
    # Kilit beklemesi hata verirse test asili kalmaz, acik hata ile duser; yarim kalan
    # islem de sunucuda sonsuza dek kilit tutmaz.
    conn.execute(f"SET lock_timeout = '{LOCK_TIMEOUT}'")
    conn.execute(f"SET statement_timeout = '{STATEMENT_TIMEOUT}'")
    conn.execute(f"SET idle_in_transaction_session_timeout = '{IDLE_IN_TRANSACTION_TIMEOUT}'")
    conn.commit()
    return conn


def _release(conn: psycopg.Connection) -> None:
    """Test basarisiz olsa da acik islemi (ve tuttugu satir kilidini) birak."""
    if not conn.closed and conn.info.transaction_status != pq.TransactionStatus.IDLE:
        conn.rollback()


@pytest.fixture
def seed() -> Iterator[Seed]:
    try:
        owner = _connect()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, PARAMS)
            cur.execute(
                """INSERT INTO brand (slug, name, name_norm)
                   VALUES (%s, 'Zephyrion', 'zephyrion') RETURNING id""",
                (BRAND_SLUG,),
            )
            brand_id = int(cur.fetchone()[0])  # type: ignore[index]
            cur.execute(
                """INSERT INTO product (slug, title, brand_id, gtin)
                   VALUES (%s, %s, %s, %s) RETURNING id""",
                (MATCH_SLUG, MATCH_TITLE, brand_id, GTIN),
            )
            match_product = int(cur.fetchone()[0])  # type: ignore[index]
            cur.execute(
                "INSERT INTO product (slug, title) VALUES (%s, %s) RETURNING id",
                (ADMIN_SLUG, ADMIN_TITLE),
            )
            admin_product = int(cur.fetchone()[0])  # type: ignore[index]
            cur.execute(
                """INSERT INTO merchant (slug, name, domain, source_type)
                   VALUES ('test-korumali-bag', 'Test', %s, 'xml_feed') RETURNING id""",
                (DOMAIN,),
            )
            merchant_id = int(cur.fetchone()[0])  # type: ignore[index]

            def offer(external_id: str, title: str, brand: str | None, attrs: str) -> int:
                cur.execute(
                    """INSERT INTO offer (merchant_id, external_id, url, title_raw, brand_raw,
                                          current_price, in_stock, attributes_raw)
                       VALUES (%s, %s, %s, %s, %s, 150000, TRUE, %s::jsonb) RETURNING id""",
                    (
                        merchant_id,
                        external_id,
                        f"https://{DOMAIN}/{external_id}",
                        title,
                        brand,
                        attrs,
                    ),
                )
                return int(cur.fetchone()[0])  # type: ignore[index]

            auto_offer = offer("auto", MATCH_TITLE, "Zephyrion", f'{{"gtin": "{GTIN}"}}')
            new_offers = tuple(
                offer(f"yeni-{index}", title, None, "{}") for index, title in enumerate(NEW_TITLES)
            )
            admin_candidates: dict[int, int] = {}
            for offer_id in (auto_offer, *new_offers):
                cur.execute(
                    """INSERT INTO match_candidate (offer_id, product_id, score, method, status)
                       VALUES (%s, %s, 0.7, 'text', 'pending') RETURNING id""",
                    (offer_id, admin_product),
                )
                admin_candidates[offer_id] = int(cur.fetchone()[0])  # type: ignore[index]
        owner.commit()
        yield Seed(
            merchant_id=merchant_id,
            match_product=match_product,
            admin_product=admin_product,
            auto_offer=auto_offer,
            new_offers=new_offers,
            admin_candidates=admin_candidates,
        )
        owner.rollback()
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, PARAMS)
        owner.commit()


def admin_approve(conn: psycopg.Connection, candidate_id: int) -> str:
    """`approveMatch` cekirdegi; COMMIT etmez. Donus: 'ok' | 'conflict' | 'not_found'."""
    with conn.cursor() as cur:
        cur.execute(ADMIN_LOCK, (candidate_id,))
        row = cur.fetchone()
        if row is None:
            return "not_found"
        offer_id, product_id, linked = row
        if linked is not None and linked != product_id:
            return "conflict"
        cur.execute(
            """UPDATE match_candidate SET status = 'accepted', reviewed_at = now(),
                      review_reason = NULL WHERE id = %s""",
            (candidate_id,),
        )
        cur.execute("UPDATE offer SET product_id = %s WHERE id = %s", (product_id, offer_id))
        cur.execute(
            """UPDATE match_candidate SET status = 'rejected', reviewed_at = now(),
                      review_reason = 'superseded'
                WHERE offer_id = %s AND status = 'pending' AND id <> %s""",
            (offer_id, candidate_id),
        )
    return "ok"


@dataclass(frozen=True)
class LockWait:
    """Bekleyen baglantinin `pg_stat_activity` + `pg_locks` goruntusu."""

    query: str
    state: str
    wait_event_type: str | None
    wait_event: str | None
    blocking_pids: list[int]
    #: Bekleyenin BEKLEDIGI (granted = false) islem kimligi.
    awaited_xid: str | None
    #: Engelleyenin `pg_stat_activity.backend_xid`'i.
    blocker_xid: str | None
    #: Bekleyen islem `match_candidate`'e yazmaya BASLAMIS mi (RowExclusiveLock)? Tek basina
    #: UPSERT'in bittigini kanitlamaz; bunu bekleyen sorgunun LINK_OFFER olmasi kanitlar.
    wrote_match_candidate: bool


LOCK_WAIT = """
SELECT a.query, a.state, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid),
       (SELECT l.transactionid::text FROM pg_locks l
         WHERE l.pid = a.pid AND NOT l.granted AND l.locktype = 'transactionid' LIMIT 1),
       (SELECT b.backend_xid::text FROM pg_stat_activity b WHERE b.pid = %(blocker)s),
       EXISTS (SELECT 1 FROM pg_locks l
                WHERE l.pid = a.pid AND l.granted AND l.locktype = 'relation'
                  AND l.relation = 'match_candidate'::regclass AND l.mode = 'RowExclusiveLock')
  FROM pg_stat_activity a
 WHERE a.pid = %(waiter)s
"""


def wait_until_blocked(waiter_pid: int, blocker_pid: int) -> LockWait:
    """`waiter`, `blocker`'in tuttugu bir kilidi bekleyene kadar gozler (tahmin degil).

    Sira uyku suresiyle degil, gozlenen kosulla (`blocker` in `pg_blocking_pids(waiter)`)
    belirlenir; kisa uyku yalnizca yoklama araligidir.
    """
    deadline = time.monotonic() + WAIT_SECONDS
    with psycopg.connect(
        database_url("DATABASE_URL_OWNER"), autocommit=True, connect_timeout=10
    ) as observer:
        while time.monotonic() < deadline:
            row = observer.execute(
                LOCK_WAIT, {"waiter": waiter_pid, "blocker": blocker_pid}
            ).fetchone()
            if row is not None and blocker_pid in (row[4] or []):
                return LockWait(
                    query=row[0],
                    state=row[1],
                    wait_event_type=row[2],
                    wait_event=row[3],
                    blocking_pids=list(row[4]),
                    awaited_xid=row[5],
                    blocker_xid=row[6],
                    wrote_match_candidate=bool(row[7]),
                )
            time.sleep(0.01)
    raise AssertionError(f"pid {waiter_pid}, pid {blocker_pid} kilidini beklemeye baslamadi")


def _normalized(sql: str) -> str:
    return " ".join(sql.split())


#: psycopg adli parametreleri gorunus sirasina gore `$n`'e cevirir: sunucuda gorunen metin.
LINK_OFFER_ON_SERVER = _normalized(
    pipeline.LINK_OFFER.replace("%(product_id)s", "$1").replace("%(offer_id)s", "$2")
)


def _hook_after(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    target: object,
    on: Callable[[dict], bool],
    action: Callable[[], None],
) -> None:
    """`target.name`'i sarar: orijinal donduktan sonra `on(call)` ise `action()` calisir.

    `call`: anahtar kelime argumanlari + `_args` (konumsal) + `_result` (donus degeri).
    """
    original = getattr(target, name)

    def wrapped(*args, **kwargs):  # type: ignore[no-untyped-def]
        result = original(*args, **kwargs)
        call = dict(kwargs)
        call["_args"] = args
        call["_result"] = result
        if on(call):
            action()
        return result

    monkeypatch.setattr(target, name, wrapped)


def _record_link_attempts(monkeypatch: pytest.MonkeyPatch) -> list[tuple[int, int, str]]:
    """Gercek `_link_offer`'i sarar: (offer_id, product_id, 'linked' | 'conflict')."""
    original = pipeline._link_offer
    attempts: list[tuple[int, int, str]] = []

    def wrapped(conn: psycopg.Connection, *, offer_id: int, product_id: int) -> None:
        try:
            original(conn, offer_id=offer_id, product_id=product_id)
        except pipeline.LinkConflict:
            attempts.append((offer_id, product_id, "conflict"))
            raise
        attempts.append((offer_id, product_id, "linked"))

    monkeypatch.setattr(pipeline, "_link_offer", wrapped)
    return attempts


def _offer(conn: psycopg.Connection, offer_id: int) -> int | None:
    row = conn.execute("SELECT product_id FROM offer WHERE id = %s", (offer_id,)).fetchone()
    assert row is not None
    return None if row[0] is None else int(row[0])


def _candidate_status(conn: psycopg.Connection, offer_id: int, product_id: int) -> str | None:
    row = conn.execute(
        "SELECT status FROM match_candidate WHERE offer_id = %s AND product_id = %s",
        (offer_id, product_id),
    ).fetchone()
    return None if row is None else str(row[0])


def _product_exists(conn: psycopg.Connection, product_id: int) -> bool:
    return conn.execute("SELECT 1 FROM product WHERE id = %s", (product_id,)).fetchone() is not None


def _is_auto_offer(seed: Seed) -> Callable[[dict], bool]:
    # best_match(conn, offer_id, key, title, merchant_id)
    return lambda call: call["_args"][1] == seed.auto_offer


# ---------------------------------------------------------------------------------------------


def test_control_without_admin_the_offer_is_auto_accepted(seed: Seed) -> None:
    """Kontrol: yaris yokken fikstur gercekten otomatik kabul ve yeni urun yolunu calistirir."""
    with _connect() as conn:
        counts = resolve_offers(conn, merchant_id=seed.merchant_id)
        conn.commit()
        assert counts.errors == []
        assert counts.link_conflicts == 0
        assert counts.auto_accepted == 1
        assert counts.products_created == len(NEW_TITLES)
        assert _offer(conn, seed.auto_offer) == seed.match_product
        assert _candidate_status(conn, seed.auto_offer, seed.match_product) == "auto_accepted"


def test_admin_link_committed_first_is_kept_on_auto_accept(
    seed: Seed, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Yonetici, resolve teklifi sectikten SONRA ama baglamadan ONCE onaylayip commit eder."""
    with _connect() as admin, _connect() as conn:

        def approve_and_commit() -> None:
            assert admin_approve(admin, seed.admin_candidates[seed.auto_offer]) == "ok"
            admin.commit()

        _hook_after(monkeypatch, "best_match", pipeline, _is_auto_offer(seed), approve_and_commit)
        counts = resolve_offers(conn, merchant_id=seed.merchant_id)
        conn.commit()

        assert counts.link_conflicts == 1
        assert counts.auto_accepted == 0
        assert counts.errors == []
        # Diger teklifler normal islendi.
        assert counts.products_created == len(NEW_TITLES)
        assert _offer(conn, seed.auto_offer) == seed.admin_product
        assert _candidate_status(conn, seed.auto_offer, seed.admin_product) == "accepted"
        # Savepoint geri alindi: yaniltici `auto_accepted` aday kalmadi.
        assert _candidate_status(conn, seed.auto_offer, seed.match_product) is None


def test_guarded_link_update_waits_on_row_lock_and_rechecks_latest_version(
    seed: Seed, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Bekleme GERCEKTEN korumali LINK_OFFER UPDATE'inde olur; kosul son surumde yeniden
    degerlendirilir.

    `holder` teklifi anahtar disi bir UPDATE ile yoneticinin urunune baglar (FOR NO KEY
    UPDATE, commit yok). Resolve aday UPSERT'ini gecer (FK denetimi FOR KEY SHARE alir,
    catismaz) ve korumali LINK_OFFER'da `holder`'in islemini bekler. `holder` commit edince
    UPDATE satirin yeni surumunde `product_id IS NULL`'u yanlis bulur, 0 satir degistirir;
    teklifin savepoint'i geri alinir.
    """
    attempts = _record_link_attempts(monkeypatch)
    probes: dict[str, object] = {}
    with _connect() as holder, _connect() as conn:
        resolve_pid = conn.info.backend_pid
        holder_pid = holder.info.backend_pid

        def hold_offer_row_with_a_non_key_update() -> None:
            cur = holder.execute(
                "UPDATE offer SET product_id = %s WHERE id = %s",
                (seed.admin_product, seed.auto_offer),
            )
            probes["holder_rowcount"] = cur.rowcount
            row = holder.execute(
                "SELECT backend_xid::text FROM pg_stat_activity WHERE pid = pg_backend_pid()"
            ).fetchone()
            probes["holder_xid"] = row[0] if row else None
            # Kilit duzeyi kaniti: FOR KEY SHARE (FK denetiminin aldigi) gecer, FOR UPDATE
            # gecemez -> holder'in satir kilidi FOR NO KEY UPDATE.
            with psycopg.connect(
                database_url("DATABASE_URL_OWNER"), autocommit=True, connect_timeout=10
            ) as probe:
                probe.execute(
                    "SELECT 1 FROM offer WHERE id = %s FOR KEY SHARE NOWAIT", (seed.auto_offer,)
                )
                probes["key_share_granted"] = True
                try:
                    probe.execute(
                        "SELECT 1 FROM offer WHERE id = %s FOR UPDATE NOWAIT", (seed.auto_offer,)
                    )
                    probes["for_update_blocked"] = False
                except psycopg.errors.LockNotAvailable:
                    probes["for_update_blocked"] = True

        _hook_after(
            monkeypatch,
            "best_match",
            pipeline,
            _is_auto_offer(seed),
            hold_offer_row_with_a_non_key_update,
        )
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(resolve_offers, conn, merchant_id=seed.merchant_id)
            try:
                waiting = wait_until_blocked(resolve_pid, holder_pid)
                # 1-2: resolve bloklu ve engelleyen tam olarak holder'in islemi.
                assert waiting.state == "active"
                assert waiting.wait_event_type == "Lock"
                assert waiting.wait_event == "transactionid"
                assert waiting.blocking_pids == [holder_pid]
                assert probes["holder_xid"] is not None
                assert waiting.blocker_xid == probes["holder_xid"]
                assert waiting.awaited_xid == probes["holder_xid"]
                # 3: bekleyen sorgu aday UPSERT'i degil, korumali LINK_OFFER'in kendisi;
                # UPSERT ayni teklif yolunda LINK_OFFER'dan once calisir ve bitmistir.
                assert _normalized(waiting.query) == LINK_OFFER_ON_SERVER
                assert "match_candidate" not in waiting.query
                assert waiting.wrote_match_candidate
                assert not future.done()
                assert attempts == []  # LINK_OFFER henuz donmedi

                holder.commit()
                # 4: kilit kalkinca resolve devam eder ve biter.
                counts: ResolveCounts = future.result(timeout=WAIT_SECONDS)
            finally:
                _release(holder)
        conn.commit()

        assert probes["holder_rowcount"] == 1
        assert probes["key_share_granted"] is True
        assert probes["for_update_blocked"] is True
        # 5: korumali UPDATE 0 satir degistirdi: `_link_offer` cakisma bildirdi ve satirin son
        # yazari hala holder (resolve yazsaydi xmin resolve'un islemi olurdu).
        assert attempts[0] == (seed.auto_offer, seed.match_product, "conflict")
        row = conn.execute(
            "SELECT xmin::text, product_id FROM offer WHERE id = %s", (seed.auto_offer,)
        ).fetchone()
        assert row is not None
        assert row[0] == probes["holder_xid"]
        # 6: yoneticinin bagi korundu.
        assert int(row[1]) == seed.admin_product
        # 7-8: UPSERT calismisti (bekleme sirasinda gozlendi); savepoint geri alininca
        # hatali `auto_accepted` aday kalmadi.
        assert _candidate_status(conn, seed.auto_offer, seed.match_product) is None
        leftover = conn.execute(
            "SELECT count(*) FROM match_candidate WHERE offer_id = %s AND status = 'auto_accepted'",
            (seed.auto_offer,),
        ).fetchone()
        assert leftover is not None and leftover[0] == 0
        # 9: cakisma hata degil, sayacta; diger teklifler normal islendi.
        assert counts.link_conflicts == 1
        assert counts.auto_accepted == 0
        assert counts.errors == []
        assert counts.products_created == len(NEW_TITLES)
        assert sorted(a[0] for a in attempts[1:] if a[2] == "linked") == sorted(seed.new_offers)


def test_conflict_while_creating_a_product_rolls_the_product_back(
    seed: Seed, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Yeni urun yolu: urun acildiktan sonra yonetici teklifi bagladi -> urun geri alinir."""
    target = seed.new_offers[0]
    with _connect() as admin, _connect() as conn:

        def approve_and_commit() -> None:
            assert admin_approve(admin, seed.admin_candidates[target]) == "ok"
            admin.commit()

        orphans: list[int] = []

        def is_target(call: dict) -> bool:
            if call["title"] != NEW_TITLES[0]:
                return False
            orphans.append(int(call["_result"]))
            return True

        _hook_after(
            monkeypatch, "create_from_offer", pipeline.products, is_target, approve_and_commit
        )
        counts = resolve_offers(conn, merchant_id=seed.merchant_id, create_missing=True)
        conn.commit()

        assert counts.link_conflicts == 1
        assert counts.errors == []
        assert counts.auto_accepted == 1
        assert counts.products_created == len(NEW_TITLES) - 1
        assert _offer(conn, target) == seed.admin_product
        # create_from_offer'in actigi urun savepoint ile geri alindi; yetim urun yok.
        assert len(orphans) == 1
        orphan = orphans[0]
        assert not _product_exists(conn, orphan)
        same_title = conn.execute(
            "SELECT count(*) FROM product WHERE title = %s", (NEW_TITLES[0],)
        ).fetchone()
        assert same_title is not None and same_title[0] == 0
        for offer_id in seed.new_offers[1:]:
            linked = _offer(conn, offer_id)
            assert linked is not None and linked not in {orphan, seed.admin_product}


def test_admin_detects_conflict_when_resolve_locked_first(seed: Seed) -> None:
    """Resolve baglayip kilidi tutar (commit yok); yonetici onayi bekler, resolve commit
    edince EvalPlanQual yeni `product_id`'yi gorur ve `conflict` doner."""
    with _connect() as admin, _connect() as conn:
        resolve_pid = conn.info.backend_pid
        admin_pid = admin.info.backend_pid

        counts = resolve_offers(conn, merchant_id=seed.merchant_id)
        assert counts.auto_accepted == 1  # islem acik: offer satiri resolve'da kilitli

        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(admin_approve, admin, seed.admin_candidates[seed.auto_offer])
            wait_until_blocked(admin_pid, resolve_pid)
            assert not future.done()
            conn.commit()
            outcome = future.result(timeout=WAIT_SECONDS)
        admin.commit()  # approveMatch conflict'te degisiklik yapmadan islemi kapatir

        assert outcome == "conflict"
        assert _offer(conn, seed.auto_offer) == seed.match_product
        assert _candidate_status(conn, seed.auto_offer, seed.match_product) == "auto_accepted"
        # Yoneticinin adayi karara baglanmadi; kuyrukta kalir.
        assert _candidate_status(conn, seed.auto_offer, seed.admin_product) == "pending"


def test_one_conflict_does_not_stop_the_other_offers(
    seed: Seed, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Hem otomatik kabul hem yeni urun yolunda birer cakisma; geri kalan teklifler baglanir."""
    second = seed.new_offers[1]
    with _connect() as admin, _connect() as conn:

        def approve(offer_id: int) -> Callable[[], None]:
            def run() -> None:
                assert admin_approve(admin, seed.admin_candidates[offer_id]) == "ok"
                admin.commit()

            return run

        _hook_after(
            monkeypatch, "best_match", pipeline, _is_auto_offer(seed), approve(seed.auto_offer)
        )
        _hook_after(
            monkeypatch,
            "create_from_offer",
            pipeline.products,
            lambda call: call["title"] == NEW_TITLES[1],
            approve(second),
        )
        counts = resolve_offers(conn, merchant_id=seed.merchant_id)
        conn.commit()

        assert counts.considered == 1 + len(NEW_TITLES)
        assert counts.link_conflicts == 2
        assert counts.errors == []
        assert counts.auto_accepted == 0
        assert counts.products_created == len(NEW_TITLES) - 1
        assert _offer(conn, seed.auto_offer) == seed.admin_product
        assert _offer(conn, second) == seed.admin_product
        for offer_id in (seed.new_offers[0], seed.new_offers[2]):
            assert _offer(conn, offer_id) not in {None, seed.admin_product}


def test_offer_deactivated_meanwhile_is_not_linked(
    seed: Seed, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`is_active` korumasi: besleme teklifi secimden sonra pasiflestirirse baglanmaz."""
    with _connect() as other, _connect() as conn:

        def deactivate() -> None:
            other.execute("UPDATE offer SET is_active = FALSE WHERE id = %s", (seed.auto_offer,))
            other.commit()

        _hook_after(monkeypatch, "best_match", pipeline, _is_auto_offer(seed), deactivate)
        counts = resolve_offers(conn, merchant_id=seed.merchant_id)
        conn.commit()

        assert counts.link_conflicts == 1
        assert counts.errors == []
        assert _offer(conn, seed.auto_offer) is None
        assert _candidate_status(conn, seed.auto_offer, seed.match_product) is None
