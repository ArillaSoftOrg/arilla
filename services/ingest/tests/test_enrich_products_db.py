"""Urun metin embedding toplu isi (karar 0177): gercek PostgreSQL + sahte istemci.

Kurulum SAHIP rolle, is UYGULAMA rolu baglantisiyla (uretimdeki gibi). Dogrulananlar: artimli
calisma (ikinci kosu bos), yalniz degisen urunun yeniden uretilmesi, metni degismeyen kaynak
degisikliginde API'siz ozet guncellemesi, ayni metnin tek kez gonderilip kopyalanmasi, kuru
calismanin hicbir sey yazmamasi, token tavani ve kaldigi yerden devam, 4xx ayiklama, ardisik
hata esigi, danisma kilidi, FK CASCADE, SQL/Python kaynak ozeti esitligi, `api_usage` kaydi.
"""

from __future__ import annotations

import math
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

import psycopg
import pytest

from db.connection import database_url
from enrich import products
from enrich.client import EmbeddingBatch, EmbeddingError, EmbeddingRejected, FakeEmbeddingClient
from enrich.product_text import TEXT_VERSION, build_product_text, content_hash, source_hash

pytestmark = pytest.mark.integration

PREFIX = "test-pte-"
MODEL = "jina-embeddings-v3-fake"


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


def _cleanup(cur: psycopg.Cursor) -> None:
    cur.execute("DELETE FROM product WHERE slug LIKE %s", (PREFIX + "%",))
    cur.execute("DELETE FROM brand WHERE slug LIKE %s", (PREFIX + "%",))
    cur.execute(
        "DELETE FROM api_usage WHERE operation = %s AND model_version LIKE %s",
        (products.OPERATION, "%-fake"),
    )
    cur.execute("DELETE FROM embedding_dataset WHERE model_version = %s", (MODEL,))


@dataclass
class World:
    owner: psycopg.Connection
    app: psycopg.Connection
    serial: int = 0

    def brand(self, name: str) -> int:
        self.serial += 1
        with self.owner.cursor() as cur:
            cur.execute(
                "INSERT INTO brand (slug, name, name_norm) VALUES (%s, %s, %s) RETURNING id",
                (f"{PREFIX}b{self.serial}", name, name.lower()),
            )
            (brand_id,) = cur.fetchone()
        self.owner.commit()
        return int(brand_id)

    def product(
        self, title: str, brand_id: int | None = None, *, offers: int = 1, foreign: int = 0
    ) -> int:
        self.serial += 1
        with self.owner.cursor() as cur:
            cur.execute(
                """INSERT INTO product (slug, title, brand_id, offer_count, foreign_offer_count)
                   VALUES (%s, %s, %s, %s, %s) RETURNING id""",
                (f"{PREFIX}{self.serial}", title, brand_id, offers, foreign),
            )
            (product_id,) = cur.fetchone()
        self.owner.commit()
        return int(product_id)

    def set_title(self, product_id: int, title: str) -> None:
        with self.owner.cursor() as cur:
            cur.execute("UPDATE product SET title = %s WHERE id = %s", (title, product_id))
        self.owner.commit()

    def rows(self) -> dict[int, tuple]:
        with self.owner.cursor() as cur:
            cur.execute(
                """SELECT e.product_id, e.text_version, e.content_hash, e.source_hash,
                          e.embedding::text, e.embedded_at
                     FROM product_text_embedding e JOIN product p ON p.id = e.product_id
                    WHERE p.slug LIKE %s AND e.model_version = %s""",
                (PREFIX + "%", MODEL),
            )
            found = {int(r[0]): r[1:] for r in cur.fetchall()}
        self.owner.commit()
        return found

    def usage_rows(self) -> list[tuple[str, int]]:
        with self.owner.cursor() as cur:
            cur.execute(
                "SELECT model_version, units FROM api_usage"
                " WHERE operation = %s AND model_version = %s",
                (products.OPERATION, MODEL),
            )
            found = [(r[0], int(r[1])) for r in cur.fetchall()]
        self.owner.commit()
        return found


@pytest.fixture
def world() -> Iterator[World]:
    try:
        owner = _owner()
    except psycopg.OperationalError:
        pytest.skip("yerel PostgreSQL yok")
    app = _app()
    with owner.cursor() as cur:
        _cleanup(cur)
    owner.commit()
    try:
        yield World(owner=owner, app=app)
    finally:
        app.rollback()
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()
        app.close()
        owner.close()


def _run(
    world: World, ids: Sequence[int], client: FakeEmbeddingClient | None = None, **kwargs: object
) -> tuple[products.ProductCounts, FakeEmbeddingClient]:
    client = client or FakeEmbeddingClient(model=MODEL)
    options = products.Options(dry_run=False, ids=list(ids), **kwargs)  # type: ignore[arg-type]
    return products.embed_products(world.app, client, options), client


def _halfvec(text: str) -> list[float]:
    return [float(v) for v in text.strip("[]").split(",")]


# --- temel akis -----------------------------------------------------------------------------


def test_first_run_embeds_every_product_and_second_run_is_a_noop(world: World) -> None:
    logi = world.brand("Logitech")
    ids = [world.product("Wireless Mouse", logi), world.product("Gaming Keyboard RGB")]

    counts, client = _run(world, ids)

    assert (counts.candidates, counts.new, counts.written, counts.api_calls) == (2, 2, 2, 1)
    assert client.inputs_seen == ["Logitech Wireless Mouse", "Gaming Keyboard RGB"]
    assert products.decide_outcome(counts) == ("completed", None)
    rows = world.rows()
    assert set(rows) == set(ids)
    version, chash, shash, vector_text, _ = rows[ids[0]]
    assert version == TEXT_VERSION
    assert bytes(chash) == content_hash(MODEL, "Logitech Wireless Mouse")
    assert bytes(shash) == source_hash("Wireless Mouse", "Logitech")
    expected = client._vector("Logitech Wireless Mouse")
    stored = _halfvec(vector_text)
    assert len(stored) == 768
    assert max(abs(a - b) for a, b in zip(stored, expected, strict=True)) < 1e-3
    assert world.usage_rows() == [(MODEL, sum(max(1, len(t) // 4) for t in client.inputs_seen))]

    again, client2 = _run(world, ids)
    assert again.candidates == 0
    assert client2.calls == 0
    assert products.decide_outcome(again) == ("no_input", "up_to_date")


def test_only_the_changed_product_is_re_embedded(world: World) -> None:
    ids = [world.product("Wireless Mouse"), world.product("USB Hub 4 Port")]
    _run(world, ids)
    before = world.rows()

    world.set_title(ids[0], "Wireless Mouse Silent Click")
    counts, client = _run(world, ids)

    assert (counts.candidates, counts.refreshed, counts.new) == (1, 1, 0)
    assert client.inputs_seen == ["Wireless Mouse Silent Click"]
    after = world.rows()
    assert after[ids[1]] == before[ids[1]]
    assert after[ids[0]][1] != before[ids[0]][1]


def test_source_change_with_identical_canonical_text_skips_the_api(world: World) -> None:
    pid = world.product("Wireless Mouse")
    _run(world, [pid])
    before = world.rows()[pid]

    world.set_title(pid, "  Wireless   Mouse  Free Shipping")
    counts, client = _run(world, [pid])

    assert (counts.candidates, counts.touched, counts.written) == (1, 1, 0)
    assert client.calls == 0
    after = world.rows()[pid]
    assert after[1] == before[1]  # icerik ozeti ayni
    assert after[3] == before[3]  # vektor ayni
    assert after[4] == before[4]  # embedded_at degismedi
    assert bytes(after[2]) == source_hash("  Wireless   Mouse  Free Shipping", None)
    assert _run(world, [pid])[0].candidates == 0


def test_identical_text_is_sent_once_and_copied_across_products(world: World) -> None:
    first = [world.product("Phone Case Black"), world.product("Phone Case Black")]
    counts, client = _run(world, first)
    assert client.inputs_seen == ["Phone Case Black"]
    assert (counts.unique_texts, counts.written) == (1, 2)

    later = world.product("Phone Case Black")
    counts2, client2 = _run(world, [later])
    assert client2.calls == 0
    assert (counts2.reused, counts2.written) == (1, 1)
    rows = world.rows()
    assert rows[later][3] == rows[first[0]][3]


def test_dry_run_writes_nothing_and_estimates_tokens(world: World) -> None:
    ids = [world.product("Phone Case Black"), world.product("Phone Case Black")]
    ids.append(world.product("x" * 110))
    client = FakeEmbeddingClient(model=MODEL)
    counts = products.embed_products(world.app, client, products.Options(dry_run=True, ids=ids))

    assert client.calls == 0
    assert world.rows() == {}
    assert world.usage_rows() == []
    assert (counts.candidates, counts.unique_texts, counts.api_texts) == (3, 2, 2)
    expected = products.estimate_tokens("Phone Case Black") + products.estimate_tokens("x" * 110)
    assert counts.estimated_tokens == expected


def test_dry_run_counts_cross_window_duplicates_as_copies(world: World) -> None:
    ids = [world.product("Same Title"), world.product("Same Title")]
    client = FakeEmbeddingClient(model=MODEL)
    counts = products.embed_products(
        world.app, client, products.Options(dry_run=True, ids=ids, scan_step=1)
    )
    assert (counts.windows, counts.api_texts, counts.reused) == (2, 1, 1)


def test_offerless_products_are_skipped_unless_requested(world: World) -> None:
    offerless = world.product("Lonely Product", offers=0)
    foreign = world.product("AliExpress Only", offers=0, foreign=1)

    counts, _ = _run(world, [offerless, foreign])
    assert set(world.rows()) == {foreign}
    assert counts.candidates == 1

    counts2, _ = _run(world, [offerless, foreign], include_offerless=True)
    assert counts2.candidates == 1
    assert set(world.rows()) == {offerless, foreign}


def test_empty_canonical_text_is_skipped(world: World) -> None:
    pid = world.product("Free Shipping")
    counts, client = _run(world, [pid])
    assert (counts.candidates, counts.skipped_empty, client.calls) == (1, 1, 0)
    assert world.rows() == {}


def test_deleting_the_product_removes_its_vector(world: World) -> None:
    pid = world.product("Desk Lamp")
    _run(world, [pid])
    assert pid in world.rows()
    with world.owner.cursor() as cur:
        cur.execute("DELETE FROM product WHERE id = %s", (pid,))
    world.owner.commit()
    assert world.rows() == {}


def test_sql_source_hash_matches_python_definition(world: World) -> None:
    brand = world.brand("İpek Yolu")
    pid = world.product("Şık Kadın Çanta ğüşiöç", brand)
    with world.app.cursor() as cur:
        cur.execute(
            """SELECT decode(md5(p.title || chr(31) || coalesce(b.name, '')), 'hex')
                 FROM product p LEFT JOIN brand b ON b.id = p.brand_id WHERE p.id = %s""",
            (pid,),
        )
        (digest,) = cur.fetchone()
    world.app.rollback()
    assert bytes(digest) == source_hash("Şık Kadın Çanta ğüşiöç", "İpek Yolu")


# --- sinirlar ve hata yollari ----------------------------------------------------------------


def test_token_ceiling_stops_cleanly_and_the_next_run_resumes(world: World) -> None:
    ids = [world.product(f"Distinct Product Number {i:02d}") for i in range(6)]
    per_text = products.estimate_tokens("Distinct Product Number 00")

    counts, client = _run(world, ids, api_batch=2, max_tokens=per_text * 2)
    assert counts.budget_stopped
    assert products.decide_outcome(counts) == ("completed", "token_budget_reached")
    assert len(world.rows()) == 2
    assert counts.resume_after == ids[2] - 1

    rest, _ = _run(world, ids)
    assert rest.candidates == 4
    assert len(world.rows()) == 6


def test_limit_caps_the_run_and_reports_where_to_resume(world: World) -> None:
    ids = [world.product(f"Limited Item {i}") for i in range(5)]
    counts, _ = _run(world, ids, limit=3)
    assert counts.limit_reached and counts.candidates == 3
    assert counts.resume_after == ids[2]
    assert products.decide_outcome(counts) == ("completed", "limit_reached")


def test_range_scan_walks_primary_key_windows(world: World) -> None:
    ids = [world.product(f"Range Item {i}") for i in range(5)]
    client = FakeEmbeddingClient(model=MODEL)
    options = products.Options(dry_run=False, after_id=ids[0] - 1, until_id=ids[-1], scan_step=2)
    counts = products.embed_products(world.app, client, options)
    assert counts.windows == math.ceil(len(ids) / 2)
    assert set(world.rows()) == set(ids)
    assert counts.resume_after == ids[-1]


@dataclass
class _RejectingClient(FakeEmbeddingClient):
    attempts: int = 0

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        self.attempts += 1
        if any("BAD" in t for t in texts):
            raise EmbeddingRejected("saglayici 400: gecersiz girdi")
        return super().embed_texts(texts)


def test_a_rejected_input_is_isolated_by_bisection(world: World) -> None:
    ids = [world.product(f"Good Item {i}") for i in range(3)]
    bad = world.product("BAD input")
    client = _RejectingClient(model=MODEL)

    counts, _ = _run(world, [*ids, bad], client=client)

    assert counts.rejected == 1
    assert set(world.rows()) == set(ids)
    assert products.decide_outcome(counts) == ("partial", "item_errors")
    # Basarili alt cagrilar kaydedildi; reddedilen cagri kaydedilmedi.
    assert len(world.usage_rows()) == client.calls


@dataclass
class _FailingClient(FakeEmbeddingClient):
    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        raise EmbeddingError("saglayici 503 dondu, 5 denemede gecmedi")


def test_consecutive_provider_failures_abort_the_run(world: World) -> None:
    ids = [world.product(f"Failing Item {i}") for i in range(10)]
    counts, _ = _run(world, ids, client=_FailingClient(model=MODEL), api_batch=2)
    assert counts.aborted
    assert counts.failed == 2 * products.MAX_CONSECUTIVE_FAILURES
    assert world.rows() == {}
    assert world.usage_rows() == []
    assert products.decide_outcome(counts) == ("failed", "provider_errors")


def test_a_second_concurrent_run_is_skipped_by_the_advisory_lock(world: World) -> None:
    pid = world.product("Locked Item")
    holder = _app()
    try:
        with holder.cursor() as cur:
            cur.execute("SELECT pg_advisory_lock(%s)", (products.LOCK_KEY,))
        holder.commit()
        counts, client = _run(world, [pid])
        assert counts.locked and client.calls == 0
        assert products.decide_outcome(counts) == ("skipped_locked", "lock_busy")
    finally:
        holder.close()
    counts2, _ = _run(world, [pid])
    assert counts2.written == 1


def test_stop_request_finishes_cleanly(world: World) -> None:
    ids = [world.product(f"Stop Item {i}") for i in range(4)]
    client = FakeEmbeddingClient(model=MODEL)
    options = products.Options(dry_run=False, ids=ids, scan_step=2)
    counts = products.embed_products(world.app, client, options, should_stop=lambda: True)
    assert counts.interrupted
    assert world.rows() == {}
    assert products.decide_outcome(counts) == ("partial", "interrupted")


def test_cli_fake_client_run_against_local_database(world: World, tmp_path: Path) -> None:
    ids = [world.product("Cli Product One"), world.product("Cli Product Two")]
    ids_file = tmp_path / "ids.txt"
    ids_file.write_text("\n".join(str(i) for i in ids), encoding="utf-8")

    assert products.main(["--ids-file", str(ids_file)]) == 0  # kuru calisma
    assert world.rows() == {}

    assert products.main(["--fake-client", "--execute", "--ids-file", str(ids_file)]) == 0
    assert set(world.rows()) == set(ids)
    assert build_product_text("Cli Product One") == "Cli Product One"


# --- kalici veri seti (karar 0179) -------------------------------------------------------------


def _dataset(world: World) -> dict[bytes, tuple]:
    with world.owner.cursor() as cur:
        cur.execute(
            """SELECT content_hash, input_text, task, text_version, source, first_product_id,
                      embedding::text
                 FROM embedding_dataset WHERE model_version = %s""",
            (MODEL,),
        )
        found = {bytes(r[0]): r[1:] for r in cur.fetchall()}
    world.owner.commit()
    return found


def test_every_api_result_is_archived_once_with_its_text(world: World) -> None:
    ids = [world.product("Phone Case Black"), world.product("Phone Case Black")]
    other = world.product("USB Hub 4 Port")
    counts, _ = _run(world, [*ids, other])

    assert counts.archived == 2
    data = _dataset(world)
    digest = content_hash(MODEL, "Phone Case Black")
    text, task, version, source, first, vector = data[digest]
    assert (text, task, version, source) == (
        "Phone Case Black",
        products.PASSAGE_TASK,
        TEXT_VERSION,
        "api",
    )
    assert first in ids
    assert vector == world.rows()[ids[0]][3]

    later = world.product("Phone Case Black")
    counts2, client2 = _run(world, [later])
    assert client2.calls == 0 and counts2.archived == 0
    assert len(_dataset(world)) == 2


def test_archive_survives_product_deletion_and_title_change(world: World) -> None:
    pid = world.product("Desk Lamp LED")
    _run(world, [pid])
    world.set_title(pid, "Desk Lamp LED Dimmable")
    _run(world, [pid])
    with world.owner.cursor() as cur:
        cur.execute("DELETE FROM product WHERE id = %s", (pid,))
    world.owner.commit()

    assert world.rows() == {}
    texts = {row[0] for row in _dataset(world).values()}
    assert texts == {"Desk Lamp LED", "Desk Lamp LED Dimmable"}


def test_app_role_cannot_rewrite_the_archive(world: World) -> None:
    pid = world.product("Archive Guard Item")
    _run(world, [pid])
    for statement in (
        "UPDATE embedding_dataset SET input_text = 'x' WHERE model_version = %s",
        "DELETE FROM embedding_dataset WHERE model_version = %s",
    ):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), world.app.cursor() as cur:
            cur.execute(statement, (MODEL,))
        world.app.rollback()


def test_backfill_restores_only_rows_whose_text_still_matches(world: World) -> None:
    from enrich.dataset import backfill_dataset

    keep = world.product("Backfill Keep Item")
    changed = world.product("Backfill Changed Item")
    _run(world, [keep, changed])
    with world.owner.cursor() as cur:
        cur.execute("DELETE FROM embedding_dataset WHERE model_version = %s", (MODEL,))
        # Vektor uretildikten sonra baslik degisti ama henuz yeniden embed edilmedi.
        cur.execute("UPDATE product SET title = 'Backfill Changed Later' WHERE id = %s", (changed,))
    world.owner.commit()

    dry = backfill_dataset(world.app, model=MODEL, dry_run=True, step=1)
    assert _dataset(world) == {}
    assert dry.matched >= 1 and dry.stale >= 1

    done = backfill_dataset(world.app, model=MODEL, dry_run=False, step=1)
    data = _dataset(world)
    assert {row[0] for row in data.values()} == {"Backfill Keep Item"}
    assert next(iter(data.values()))[3] == "backfill"
    assert done.inserted == 1
    assert backfill_dataset(world.app, model=MODEL, dry_run=False).inserted == 0


# --- karar 0180: model/boyut izolasyonu ve vektor kapisi ------------------------------------


def test_other_dimension_model_writes_nothing(world: World) -> None:
    pid = world.product("Isolation Mouse")
    client = FakeEmbeddingClient(model="e5-small-int8-0bcc8ca76950-fake", dimensions=384)
    options = products.Options(dry_run=False, ids=[pid])
    counts = products.embed_products(world.app, client, options)
    assert counts.incompatible and client.calls == 0
    assert products.decide_outcome(counts) == ("failed", "incompatible_index")
    with world.owner.cursor() as cur:
        cur.execute("SELECT count(*) FROM product_text_embedding WHERE product_id = %s", (pid,))
        assert cur.fetchone()[0] == 0
    world.owner.commit()


@dataclass
class _UnnormalizedClient(FakeEmbeddingClient):
    """Bicimce gecerli ama normalize olmayan vektor: kapi partiyi yazdirmamali."""

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        batch = super().embed_texts(texts)
        return EmbeddingBatch(
            vectors=[[v * 3 for v in vec] for vec in batch.vectors],
            model_version=batch.model_version,
            total_tokens=batch.total_tokens,
        )


def test_invalid_vectors_are_never_written(world: World) -> None:
    ids = [world.product(f"Bad Vector {i}") for i in range(2)]
    counts, client = _run(world, ids, client=_UnnormalizedClient(model=MODEL))
    assert counts.failed == 2 and counts.written == 0
    assert world.rows() == {}
    # Cagri yapildi ve maliyeti kayitli (kural 9); yalniz vektor yazilmadi.
    assert len(world.usage_rows()) == client.calls == 1
    assert products.decide_outcome(counts) == ("partial", "item_errors")


def test_detail_records_provider_latency(world: World) -> None:
    pid = world.product("Latency Mouse")
    counts, _ = _run(world, [pid])
    detail = counts.detail()
    assert detail["model"] == MODEL and detail["provider"] == "jina"
    assert detail["embed_ms_p50"] >= 0 and detail["items_per_s"] is not None
