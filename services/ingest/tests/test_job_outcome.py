"""Is sonucu sozlesmesi (karar 0174): `detail.outcome`/`reason`, status ve cikis kodu.

Saf testler sozlesme tablosunu, dogrulamayi ve `track` davranisini; entegrasyon
testleri `python -m resolve` / `python -m similarity` giris noktalarini gercek
yerel PostgreSQL uzerinde dogrular. Advisory kilit testi iki bagimsiz baglantiyla,
uyku olmadan: kilit cagri ONCESINDE alinir, kosu bittikten SONRA birakilir.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest

from db import job_run
from db.connection import database_url
from resolve import __main__ as resolve_cli
from resolve import pipeline
from resolve.pipeline import ResolveCounts
from similarity import __main__ as similarity_cli
from similarity import edges as edges_module
from similarity.edges import EdgeCounts
from similarity.pipeline import SimilarityCounts, run

# --- saf: sozlesme tablosu ---------------------------------------------------

CONTRACT = {
    "completed": ("success", 0),
    "no_input": ("success", 0),
    "skipped_locked": ("partial", 75),
    "partial": ("partial", 1),
    "failed": ("failed", 1),
    "blocked_upstream": ("partial", 0),
}


def test_outcome_table_is_the_approved_contract() -> None:
    assert dict(job_run.OUTCOMES) == CONTRACT
    for name, (status, code) in CONTRACT.items():
        result = job_run.outcome(name, "some_reason")
        assert (result.name, result.status, result.exit_code) == (name, status, code)
        assert result.reason == "some_reason"
        assert job_run.exit_code(name) == code
    # status enum'u degismedi: her sonuc mevcut uc son durumdan birine duser.
    assert {status for status, _ in CONTRACT.values()} <= job_run.FINAL_STATUSES


@pytest.mark.parametrize("bad", ["", "done", "COMPLETED", "completed ", "success", None, 7])
def test_invalid_outcome_fails_closed(bad: Any) -> None:
    result = job_run.outcome(bad)
    assert (result.name, result.reason, result.status, result.exit_code) == (
        "failed",
        "invalid_outcome",
        "failed",
        1,
    )
    assert job_run.exit_code(bad) == 1


@pytest.mark.parametrize(
    "bad_reason", ["", "Lock Busy", "x", "a" * 41, "lock-busy", "postgresql://u:p@h/db", 5]
)
def test_invalid_reason_is_dropped_but_outcome_kept(bad_reason: Any) -> None:
    result = job_run.outcome("skipped_locked", bad_reason)
    assert (result.name, result.reason, result.exit_code) == ("skipped_locked", None, 75)


def test_with_outcome_puts_outcome_first_and_keeps_job_fields() -> None:
    detail = {"considered": 3, "link_conflicts": 1, "outcome": "stale", "reason": "old"}
    out = job_run.with_outcome(detail, job_run.outcome("no_input", "no_eligible_offers"))
    assert list(out)[:2] == ["outcome", "reason"]
    assert out == {
        "outcome": "no_input",
        "reason": "no_eligible_offers",
        "considered": 3,
        "link_conflicts": 1,
    }
    assert "reason" not in job_run.with_outcome({"a": 1}, job_run.outcome("completed"))


def test_bounded_detail_truncation_never_drops_the_outcome() -> None:
    huge = {f"key_{i}": "y" * 120 for i in range(60)}
    bounded = job_run.bounded_detail(
        job_run.with_outcome(huge, job_run.outcome("blocked_upstream", "no_embeddings"))
    )
    assert bounded["outcome"] == "blocked_upstream"
    assert bounded["reason"] == "no_embeddings"
    assert len(bounded) <= job_run.MAX_DETAIL_KEYS
    assert len(json.dumps(bounded, ensure_ascii=False)) <= job_run.MAX_DETAIL_JSON


# --- saf: track --------------------------------------------------------------


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> list[tuple[Any, ...]]:
    calls: list[tuple[Any, ...]] = []
    monkeypatch.setattr(job_run, "start", lambda job, trigger="manual": 1)
    monkeypatch.setattr(
        job_run,
        "finish",
        lambda run_id, status, detail=None, error_summary=None: calls.append(
            (status, dict(detail or {}), error_summary)
        ),
    )
    return calls


def test_track_without_outcomes_keeps_the_old_record_shape(captured: list) -> None:
    with job_run.track("collect") as run:
        run.detail["seen"] = 2
        run.status = "partial"
    with pytest.raises(RuntimeError), job_run.track("collect") as run:
        run.detail["seen"] = 1
        raise RuntimeError("patladi")
    assert captured[0] == ("partial", {"seen": 2}, None)
    assert captured[1][:2] == ("failed", {"seen": 1})  # outcome YOK: eski bicim
    assert captured[1][2] == "RuntimeError: patladi"


def test_track_with_outcomes_status_comes_from_the_outcome(captured: list) -> None:
    with job_run.track("resolve", outcomes=True) as run:
        run.status = "failed"  # sonuc tek dogru kaynak
        assert run.set_outcome("no_input", "no_eligible_offers") == 0
    assert captured[0][:2] == (
        "success",
        {"outcome": "no_input", "reason": "no_eligible_offers"},
    )


def test_track_with_outcomes_derives_outcome_from_status_when_not_set(captured: list) -> None:
    with job_run.track("resolve", outcomes=True) as run:
        run.status = "partial"
    with job_run.track("resolve", outcomes=True):
        pass
    assert captured[0][:2] == ("partial", {"outcome": "partial"})
    assert captured[1][:2] == ("success", {"outcome": "completed"})


def test_track_with_outcomes_exception_is_failed_and_reraised(captured: list) -> None:
    with pytest.raises(KeyError), job_run.track("resolve", outcomes=True) as run:
        run.detail["considered"] = 4
        run.set_outcome("completed")  # istisna onceki secimi ezer
        raise KeyError("x")
    status, detail, summary = captured[0]
    assert status == "failed"
    assert detail == {"outcome": "failed", "reason": "exception", "considered": 4}
    assert summary.startswith("KeyError")


def test_invalid_outcome_in_track_is_recorded_as_failure(captured: list) -> None:
    with job_run.track("resolve", outcomes=True) as run:
        assert run.set_outcome("all_good") == 1
    assert captured[0][:2] == ("failed", {"outcome": "failed", "reason": "invalid_outcome"})


# --- saf: siniflandirma ------------------------------------------------------


@pytest.mark.parametrize(
    ("counts", "expected"),
    [
        (ResolveCounts(considered=3, products_created=3), ("completed", None)),
        # Baglama cakismasi hata DEGILDIR (PR2-A, #289).
        (ResolveCounts(considered=2, link_conflicts=2), ("completed", None)),
        (ResolveCounts(considered=0), ("no_input", "no_eligible_offers")),
        (ResolveCounts(considered=3, errors=["offer 1: x"]), ("partial", "offer_errors")),
        (ResolveCounts(skipped_locked=True), ("skipped_locked", "lock_busy")),
        # Kilit her seyin onundedir: kosu hicbir seye dokunmadi.
        (ResolveCounts(skipped_locked=True, errors=["?"]), ("skipped_locked", "lock_busy")),
    ],
)
def test_resolve_classify(counts: ResolveCounts, expected: tuple) -> None:
    assert resolve_cli.classify(counts) == expected


def _sim(visual: int, semantic: int) -> SimilarityCounts:
    return SimilarityCounts(
        visual=EdgeCounts(products_with_vector=visual),
        semantic=EdgeCounts(products_with_vector=semantic),
    )


def test_similarity_edges_outcome_separates_no_products_from_no_embeddings() -> None:
    assert similarity_cli.edges_outcome(_sim(5, 0), True) == ("completed", None)
    assert similarity_cli.edges_outcome(_sim(0, 2), True) == ("completed", None)
    assert similarity_cli.edges_outcome(_sim(0, 0), True) == ("blocked_upstream", "no_embeddings")
    assert similarity_cli.edges_outcome(_sim(0, 0), False) == ("no_input", "no_eligible_products")


def test_similarity_classify_asks_the_database_only_when_nothing_had_vectors() -> None:
    class NoQuery:
        def cursor(self) -> None:
            raise AssertionError("gereksiz sorgu")

    conn: Any = NoQuery()
    assert similarity_cli.classify(conn, _sim(0, 0), do_edges=False) == ("completed", None)
    assert similarity_cli.classify(conn, _sim(1, 0), do_edges=True) == ("completed", None)


def test_similarity_classify_lock_busy_wins_and_asks_nothing() -> None:
    """Kilit mesgulken sayaclar bos: `blocked_upstream`/`no_input` uydurulmaz, sorgu yok."""

    class NoQuery:
        def cursor(self) -> None:
            raise AssertionError("gereksiz sorgu")

    conn: Any = NoQuery()
    counts = _sim(0, 0)
    counts.skipped_locked = True
    for do_edges in (True, False):
        assert similarity_cli.classify(conn, counts, do_edges=do_edges) == (
            "skipped_locked",
            "lock_busy",
        )
    assert job_run.exit_code("skipped_locked") == 75


@pytest.mark.parametrize("value", ["0", "-1", "abc", "1.5"])
def test_similarity_limit_must_be_positive_and_leaves_no_run_record(
    value: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--limit 0` eskiden gruba hic girmeden biter, `blocked_upstream` yazardi."""

    def no_run(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("gecersiz argumanla kosu acilmamali / veritabanina gidilmemeli")

    monkeypatch.setattr(job_run, "start", no_run)
    monkeypatch.setattr(similarity_cli, "connect", no_run)
    for flags in (["--edges"], ["--prices"], [], ["--edges", "--dry-run"]):
        with pytest.raises(SystemExit) as exc:
            similarity_cli.main([*flags, "--limit", value])
        assert exc.value.code == 2
    assert "--limit" in capsys.readouterr().err
    assert similarity_cli.positive_int("1") == 1


# --- entegrasyon: yerel PostgreSQL --------------------------------------------

DOMAIN = "test-is-sonucu.example"
EMPTY_DOMAIN = "test-is-sonucu-bos.example"
CLEANUP = (
    """DELETE FROM match_candidate WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = ANY(%(domains)s))""",
    """CREATE TEMP TABLE IF NOT EXISTS _p AS SELECT o.product_id FROM offer o
        JOIN merchant m ON m.id = o.merchant_id WHERE m.domain = ANY(%(domains)s)""",
    "DELETE FROM offer WHERE merchant_id IN"
    " (SELECT id FROM merchant WHERE domain = ANY(%(domains)s))",
    "DELETE FROM product WHERE id IN (SELECT product_id FROM _p WHERE product_id IS NOT NULL)",
    "DROP TABLE _p",
    "DELETE FROM merchant WHERE domain = ANY(%(domains)s)",
)
TITLES = ("Sonuc Test Fincan 1", "Sonuc Test Fincan 2", "Sonuc Test Fincan 3")
RESOLVE_DETAIL_KEYS = {
    "considered",
    "auto_accepted",
    "queued",
    "products_created",
    "aggregates_updated",
    "link_conflicts",
    "errors",
}


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _cleanup(cur: psycopg.Cursor) -> None:
    for statement in CLEANUP:
        cur.execute(statement, {"domains": [DOMAIN, EMPTY_DOMAIN]})


def _insert_merchant(cur: psycopg.Cursor, slug: str, domain: str) -> int:
    cur.execute(
        """INSERT INTO merchant (slug, name, domain, source_type)
           VALUES (%s, 'Test', %s, 'xml_feed') RETURNING id""",
        (slug, domain),
    )
    row = cur.fetchone()
    assert row is not None
    return int(row[0])


@pytest.fixture
def recorded_runs(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[int]]:
    """Bu testin actigi `job_run` satirlarinin kimlikleri; teardown YALNIZCA bunlari siler.

    `job_run.start` sarmalanir (gercek INSERT aynen calisir): baska testlerin ya da es
    zamanli islemlerin kosu kayitlarina dokunulmaz, kimlik araligi varsayilmaz.
    """
    try:
        _owner().close()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    # Giris noktalari `connect()`/`job_run` ile DATABASE_URL'i kullanir; yerel sahip rolu
    # (conftest yerel olmayan hostu oturum basinda zaten reddeder).
    monkeypatch.setenv("DATABASE_URL", database_url("DATABASE_URL_OWNER"))
    monkeypatch.delenv(job_run.TRIGGER_ENV, raising=False)
    ids: list[int] = []
    original = job_run.start

    def recording(job: str, trigger: str = "manual") -> int | None:
        run_id = original(job, trigger)
        if run_id is not None:
            ids.append(run_id)
        return run_id

    monkeypatch.setattr(job_run, "start", recording)
    yield ids
    if ids:
        with _owner() as conn:
            conn.execute("DELETE FROM job_run WHERE id = ANY(%s)", (ids,))
            conn.commit()


@pytest.fixture
def seeded(recorded_runs: list[int]) -> Iterator[dict[str, Any]]:
    """Uc bagsiz teklifli magaza + teklifsiz magaza (yalnizca bu testin alan adlari)."""
    owner = _owner()
    with owner:
        with owner.cursor() as cur:
            _cleanup(cur)
            mid = _insert_merchant(cur, "test-is-sonucu", DOMAIN)
            empty = _insert_merchant(cur, "test-is-sonucu-bos", EMPTY_DOMAIN)
            for index, title in enumerate(TITLES):
                cur.execute(
                    """INSERT INTO offer (merchant_id, external_id, url, title_raw,
                                          brand_raw, current_price, in_stock)
                       VALUES (%s, %s, %s, %s, 'Sonuc', 100000, TRUE)""",
                    (mid, f"fincan-{index}", f"https://{DOMAIN}/{index}", title),
                )
        owner.commit()
        yield {"merchant": mid, "empty": empty, "runs": recorded_runs}
        owner.rollback()
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()


def _runs(ids: list[int]) -> list[tuple[str, str, dict, str | None]]:
    """Yalnizca bu testin actigi kosular, acilis sirasiyla."""
    if not ids:
        return []
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT job, status, detail, error_summary FROM job_run WHERE id = ANY(%s) ORDER BY id",
            (ids,),
        )
        return cur.fetchall()


def _linked(merchant_id: int) -> dict[str, int | None]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT title_raw, product_id FROM offer WHERE merchant_id = %s", (merchant_id,)
        )
        return {title: product_id for title, product_id in cur.fetchall()}


def _resolve(seed: dict[str, Any], *extra: str, merchant: str = "merchant") -> int:
    return resolve_cli.main(["--merchant-id", str(seed[merchant]), *extra])


@pytest.mark.integration
def test_resolve_producing_output_is_completed(seeded: dict[str, Any]) -> None:
    assert _resolve(seeded) == 0
    [(job, status, detail, summary)] = _runs(seeded["runs"])
    assert (job, status, summary) == ("resolve", "success", None)
    assert detail["outcome"] == "completed"
    assert "reason" not in detail
    # Mevcut detail alanlari aynen yerinde.
    assert set(detail) >= RESOLVE_DETAIL_KEYS
    assert detail["considered"] == 3
    assert detail["products_created"] == 3
    assert detail["errors"] == 0
    assert all(product_id is not None for product_id in _linked(seeded["merchant"]).values())


@pytest.mark.integration
def test_resolve_without_eligible_offers_is_no_input_not_a_failure(
    seeded: dict[str, Any],
) -> None:
    assert _resolve(seeded, merchant="empty") == 0
    [(_job, status, detail, summary)] = _runs(seeded["runs"])
    assert (status, summary) == ("success", None)
    assert (detail["outcome"], detail["reason"]) == ("no_input", "no_eligible_offers")
    assert detail["considered"] == 0
    assert set(detail) >= RESOLVE_DETAIL_KEYS


@pytest.mark.integration
def test_resolve_lock_held_by_another_connection_is_skipped_locked(
    seeded: dict[str, Any],
) -> None:
    # Bagimsiz ikinci baglanti kilidi kosudan ONCE alir, kosu bitene kadar tutar.
    with _owner() as holder, holder.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (pipeline.RESOLVE_LOCK_KEY,))
        assert _resolve(seeded) == 75
        assert _resolve(seeded, "--dry-run") == 75  # dry-run: ayni sonuc, kayit yok
        holder.rollback()

    [(_job, status, detail, summary)] = _runs(seeded["runs"])
    assert status == "partial"
    assert (detail["outcome"], detail["reason"]) == ("skipped_locked", "lock_busy")
    # Kilit beklemesi oge hatasi degildir.
    assert detail["errors"] == 0
    assert detail["considered"] == 0
    assert summary is None
    assert all(product_id is None for product_id in _linked(seeded["merchant"]).values())

    # Kilit birakilinca sonraki kosu isi yapar.
    assert _resolve(seeded) == 0
    assert all(product_id is not None for product_id in _linked(seeded["merchant"]).values())


@pytest.mark.integration
def test_resolve_offer_level_error_is_partial(
    seeded: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    original = pipeline.products.create_from_offer

    def flaky(conn: psycopg.Connection, **kwargs: Any) -> int:
        if kwargs["title"] == TITLES[1]:
            conn.execute("SELECT 1 / 0")  # gercek veritabani hatasi, teklif savepoint'inde
        return original(conn, **kwargs)

    monkeypatch.setattr(pipeline.products, "create_from_offer", flaky)
    assert _resolve(seeded) == 1
    [(_job, status, detail, summary)] = _runs(seeded["runs"])
    assert status == "partial"
    assert (detail["outcome"], detail["reason"]) == ("partial", "offer_errors")
    assert detail["errors"] == 1
    assert detail["products_created"] == 2
    assert summary is not None and summary.startswith("1 hata")


@pytest.mark.integration
def test_resolve_technical_exception_is_failed(
    seeded: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(conn: psycopg.Connection) -> None:
        conn.execute("SELECT 1 / 0")  # teklif dongusunun DISINDA: kosu yarida kalir

    monkeypatch.setattr(pipeline, "tune_ann_search", broken)
    with pytest.raises(psycopg.errors.DivisionByZero):
        _resolve(seeded)  # yakalanmayan istisna: surec cikisi 1
    [(_job, status, detail, summary)] = _runs(seeded["runs"])
    assert status == "failed"
    assert detail == {"outcome": "failed", "reason": "exception"}
    assert summary is not None and summary.startswith("DivisionByZero")
    assert all(product_id is None for product_id in _linked(seeded["merchant"]).values())


@pytest.mark.integration
def test_resolve_dry_run_writes_nothing_and_leaves_no_run_record(
    seeded: dict[str, Any],
) -> None:
    assert _resolve(seeded, "--dry-run") == 0
    assert _resolve(seeded, "--dry-run", merchant="empty") == 0
    assert _runs(seeded["runs"]) == []
    assert all(product_id is None for product_id in _linked(seeded["merchant"]).values())


@pytest.mark.integration
def test_resolve_link_conflict_is_counted_not_an_error(
    seeded: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """PR2-A (#289): teklif secildikten sonra besleme onu pasiflestirir; korumali
    LINK_OFFER 0 satir gunceller, savepoint geri alinir, kosu `completed` kalir."""
    original = pipeline.products.create_from_offer

    def deactivate_first(conn: psycopg.Connection, **kwargs: Any) -> int:
        if kwargs["title"] == TITLES[0]:
            with _owner() as feed:  # bagimsiz baglanti, kendi isleminde commit
                feed.execute(
                    "UPDATE offer SET is_active = FALSE WHERE merchant_id = %s AND title_raw = %s",
                    (seeded["merchant"], TITLES[0]),
                )
        return original(conn, **kwargs)

    monkeypatch.setattr(pipeline.products, "create_from_offer", deactivate_first)
    assert _resolve(seeded) == 0
    [(_job, status, detail, _summary)] = _runs(seeded["runs"])
    assert status == "success"
    assert detail["outcome"] == "completed"
    assert detail["link_conflicts"] == 1
    assert detail["errors"] == 0
    assert detail["products_created"] == 2
    linked = _linked(seeded["merchant"])
    assert linked[TITLES[0]] is None
    assert linked[TITLES[1]] is not None and linked[TITLES[2]] is not None


@pytest.mark.integration
def test_invalid_outcome_is_recorded_as_failure_in_the_database(
    seeded: dict[str, Any],
) -> None:
    with job_run.track("test_job_outcome", outcomes=True) as tracked:
        tracked.detail["kept"] = 1
        assert tracked.set_outcome("totally_fine", "Not A Reason") == 1
    [(job, status, detail, _summary)] = _runs(seeded["runs"])
    assert (job, status) == ("test_job_outcome", "failed")
    assert detail == {"outcome": "failed", "reason": "invalid_outcome", "kept": 1}


SIM_DOMAIN = "test-is-sonucu-benzerlik.example"


@pytest.fixture
def owner_tx() -> Iterator[psycopg.Connection]:
    """Tek islem, sonunda geri alinir: katalog durumu yalnizca bu islemde degisir.

    On kosul test icinde KURULUR (tohum verisine ya da baska testlerin biraktigi
    embedding'lere bagli degil): bu teste ait bir bagli aktif teklif eklenir.
    """
    try:
        conn = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with conn:
        with conn.cursor() as cur:
            mid = _insert_merchant(cur, "test-is-sonucu-benzerlik", SIM_DOMAIN)
            cur.execute(
                "INSERT INTO product (slug, title) VALUES ('test-is-sonucu-urun', 'Sonuc Urun')"
                " RETURNING id"
            )
            row = cur.fetchone()
            assert row is not None
            cur.execute(
                """INSERT INTO offer (merchant_id, external_id, url, title_raw, current_price,
                                      in_stock, product_id)
                   VALUES (%s, 'urun-1', %s, 'Sonuc Urun', 100000, TRUE, %s)""",
                (mid, f"https://{SIM_DOMAIN}/1", int(row[0])),
            )
        yield conn
        conn.rollback()


def _without_offer_embeddings(conn: psycopg.Connection) -> None:
    """Uretimdeki durum (bagli urun var, offer embedding'i yok), yalnizca bu islemde."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM embedding WHERE target_type = 'offer'")


def _without_eligible_products(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("UPDATE offer SET is_active = FALSE WHERE is_active")


class _InTestTransaction:
    """Gercek baglanti; CLI'nin commit/rollback/kapanisi test isleminde yutulur.

    Tum SQL (kenar uretimi, EXISTS) gercek veritabaninda, `owner_tx` isleminde kosar;
    yalnizca islem sinirlari bastirilir ki on kosul baska testleri etkilemesin ve
    sonunda fixture tek seferde geri alsin. `job_run` kendi baglantisiyla gercekten yazar.
    """

    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def __getattr__(self, name: str) -> Any:
        return getattr(self._conn, name)

    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass

    def __enter__(self) -> _InTestTransaction:
        return self

    def __exit__(self, *_exc: object) -> None:
        return None


@pytest.mark.integration
def test_similarity_products_without_embeddings_is_blocked_upstream(
    owner_tx: psycopg.Connection,
) -> None:
    _without_offer_embeddings(owner_tx)
    counts = run(owner_tx, do_edges=True, do_prices=False)
    assert counts.visual.products_with_vector == counts.semantic.products_with_vector == 0
    assert similarity_cli.classify(owner_tx, counts, do_edges=True) == (
        "blocked_upstream",
        "no_embeddings",
    )


@pytest.mark.integration
def test_similarity_without_any_eligible_product_is_no_input(
    owner_tx: psycopg.Connection,
) -> None:
    _without_eligible_products(owner_tx)
    counts = run(owner_tx, do_edges=True, do_prices=False)
    assert similarity_cli.classify(owner_tx, counts, do_edges=True) == (
        "no_input",
        "no_eligible_products",
    )


EDGE_DETAIL_KEYS = {
    "visual_edges",
    "semantic_edges",
    "visual_products",
    "semantic_products",
    "edges_pruned",
}


@pytest.mark.integration
@pytest.mark.parametrize(
    ("prepare", "expected"),
    [
        (_without_offer_embeddings, ("blocked_upstream", "no_embeddings", "partial")),
        (_without_eligible_products, ("no_input", "no_eligible_products", "success")),
    ],
)
def test_similarity_cli_records_outcome_with_exit_zero(
    owner_tx: psycopg.Connection,
    recorded_runs: list[int],
    monkeypatch: pytest.MonkeyPatch,
    prepare: Any,
    expected: tuple[str, str, str],
) -> None:
    """Uctan uca `python -m similarity --edges`: on kosul testin kendi isleminde kurulur."""
    prepare(owner_tx)
    monkeypatch.setattr(similarity_cli, "connect", lambda: _InTestTransaction(owner_tx))

    assert similarity_cli.main(["--edges", "--dry-run"]) == 0
    assert recorded_runs == []  # dry-run kosu kaydi birakmaz
    assert similarity_cli.main(["--edges"]) == 0

    outcome_name, reason, status = expected
    [(job, row_status, detail, summary)] = _runs(recorded_runs)
    assert (job, row_status, summary) == ("similarity_edges", status, None)
    assert (detail["outcome"], detail["reason"]) == (outcome_name, reason)
    assert set(detail) >= EDGE_DETAIL_KEYS  # mevcut alanlar korunur
    assert detail["visual_products"] == detail["semantic_products"] == 0


def _edge_lock_free() -> bool:
    """Kilit baska bir oturumdan alinabiliyor mu (alinirsa hemen birakilir)."""
    with _owner() as probe, probe.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s)", (edges_module.EDGE_LOCK_KEY,))
        row = cur.fetchone()
        free = bool(row and row[0])
        if free:
            cur.execute("SELECT pg_advisory_unlock(%s)", (edges_module.EDGE_LOCK_KEY,))
        return free


@pytest.mark.integration
def test_similarity_lock_held_by_another_connection_is_skipped_locked(
    recorded_runs: list[int],
) -> None:
    """Gercek eszamanlilik: ikinci, bagimsiz oturum kenar kilidini kosudan ONCE alir.

    Eskiden `build_edges` RuntimeError firlatir, kosu `failed`/exception ve cikis 1 olurdu.
    """
    with _owner() as holder, holder.cursor() as cur:
        cur.execute("SELECT pg_advisory_lock(%s)", (edges_module.EDGE_LOCK_KEY,))
        try:
            assert similarity_cli.main(["--edges"]) == 75
            assert similarity_cli.main(["--edges", "--dry-run"]) == 75  # kayit yok
            # Birlesik kosu: fiyat adimi da atlanir ("hicbir seye dokunmadi").
            assert similarity_cli.main([]) == 75
            # Yalnizca fiyat kosusu kenar kilidine bagli degildir.
            assert similarity_cli.main(["--prices", "--dry-run"]) == 0
        finally:
            cur.execute("SELECT pg_advisory_unlock(%s)", (edges_module.EDGE_LOCK_KEY,))
            holder.commit()

    runs = _runs(recorded_runs)
    assert [(job, status) for job, status, _detail, _summary in runs] == [
        ("similarity_edges", "partial"),
        ("similarity", "partial"),
    ]
    for _job, _status, detail, summary in runs:
        assert (detail["outcome"], detail["reason"]) == ("skipped_locked", "lock_busy")
        assert summary is None  # istisna degil
        assert detail["visual_edges"] == detail["semantic_edges"] == 0
    assert runs[1][2]["price_products"] == 0
    # Kosular kilidi sizdirmadi: baska oturum yeniden alabilir.
    assert _edge_lock_free()


@pytest.mark.integration
def test_similarity_run_takes_the_edge_lock_once_and_releases_it(
    owner_tx: psycopg.Connection,
) -> None:
    """Kilit iki tur icin bir kez alinir (yeniden girilir) ve sayaci dengeli birakilir."""
    run(owner_tx, do_edges=True, do_prices=False)
    assert _edge_lock_free()
    # Kilit mesgulken `run` istisna firlatmaz, hicbir sey hesaplamaz.
    with _owner() as holder, holder.cursor() as cur:
        cur.execute("SELECT pg_advisory_lock(%s)", (edges_module.EDGE_LOCK_KEY,))
        counts = run(owner_tx, do_edges=True, do_prices=True)
        cur.execute("SELECT pg_advisory_unlock(%s)", (edges_module.EDGE_LOCK_KEY,))
        holder.commit()
    assert counts.skipped_locked
    assert counts.visual.products_with_vector == counts.semantic.products_with_vector == 0
    assert counts.prices.products == counts.prices.aggregates_updated == 0
    assert _edge_lock_free()


PRICE_DETAIL_KEYS = {"price_products", "price_aggregates", "price_stats_removed"}


@pytest.mark.integration
def test_combined_similarity_with_blocked_edges_is_partial_and_keeps_price_counters(
    owner_tx: psycopg.Connection,
    recorded_runs: list[int],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Birlesik kosu tek sonuc yazar; sonuc kenar adimindandir (bilincli, karar 0174).

    Kenar engellendi -> `partial`/`blocked_upstream`, cikis 0; fiyat adimi kostu ve
    sayaclari yazildi (panel fiyat asamasini bu kosudan bayat saymaz, PR1b).
    """
    _without_offer_embeddings(owner_tx)
    monkeypatch.setattr(similarity_cli, "connect", lambda: _InTestTransaction(owner_tx))

    assert similarity_cli.main([]) == 0
    [(job, status, detail, summary)] = _runs(recorded_runs)
    assert (job, status, summary) == ("similarity", "partial", None)
    assert (detail["outcome"], detail["reason"]) == ("blocked_upstream", "no_embeddings")
    assert set(detail) >= EDGE_DETAIL_KEYS | PRICE_DETAIL_KEYS
    # Fiyat adimi en az bu testin bagli urununu isledi.
    assert detail["price_products"] >= 1


@pytest.mark.integration
def test_similarity_positive_limit_still_classifies_from_the_catalogue(
    owner_tx: psycopg.Connection,
) -> None:
    """`--limit 1` (gecerli en kucuk deger) embedding'siz katalogda yine `blocked_upstream`."""
    _without_offer_embeddings(owner_tx)
    counts = run(owner_tx, do_edges=True, do_prices=False, limit=1)
    assert similarity_cli.classify(owner_tx, counts, do_edges=True) == (
        "blocked_upstream",
        "no_embeddings",
    )
