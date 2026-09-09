"""Kabul kriteri: embedding'ler uretiliyor, ayni gorsel iki kez islenmiyor.

Kurulum ve temizlik SAHIP rolle, boru hatti UYGULAMA rolu (`arilla_app`) ile —
B1 ve B2'deki ayrimin aynisi.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import httpx
import psycopg
import pytest

from db.connection import database_url
from enrich.client import FakeEmbeddingClient
from enrich.pipeline import embed_images, embed_texts

pytestmark = pytest.mark.integration

DOMAIN = "test-enrich-magaza.example"
FIXTURES = Path(__file__).parent / "fixtures" / "images"

#: 12 offer, 3 farkli gorsel. Yineleme yolu boyle gorunur olur.
OFFER_COUNT = 12
DISTINCT_IMAGES = 3

CLEANUP = (
    """DELETE FROM embedding WHERE target_type = 'offer' AND target_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = %(domain)s)""",
    """DELETE FROM price_point WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = %(domain)s)""",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = %(domain)s)",
    "DELETE FROM merchant WHERE domain = %(domain)s",
)


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


#: Her test kosusuna ozgu tuz. Fixture PNG'lerinin AYNISI tohum verisinde de
#: kullaniliyor; tuzlamazsak hash'ler catisir ve boru hatti (dogru olarak)
#: veritabanindaki onceki vektoru yeniden kullanir — o zaman test kendi API
#: cagrilarini degil, katalogun durumunu olcer. Goruntu hicbir yerde
#: cozulmuyor, yalnizca hash'lenip base64'e ceviriliyor; sondaki fazladan
#: baytlar zararsiz.
RUN_SALT = uuid4().bytes


def _images() -> list[bytes]:
    paths = sorted(FIXTURES.glob("*.png"))[:DISTINCT_IMAGES]
    return [path.read_bytes() + RUN_SALT for path in paths]


def _image_client() -> httpx.Client:
    """`/img/N.png` -> N numarali fixture gorseli."""
    images = _images()

    def handler(request: httpx.Request) -> httpx.Response:
        index = int(request.url.path.rsplit("/", 1)[-1].split(".")[0])
        return httpx.Response(
            200, content=images[index % len(images)], headers={"content-type": "image/png"}
        )

    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.fixture
def offers() -> Iterator[int]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    with owner:
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, {"domain": DOMAIN})
            cur.execute(
                """
                INSERT INTO merchant (slug, name, domain, source_type)
                VALUES ('test-enrich', 'Test Enrich', %s, 'xml_feed') RETURNING id
                """,
                (DOMAIN,),
            )
            row = cur.fetchone()
            assert row is not None
            merchant_id = int(row[0])

            for index in range(OFFER_COUNT):
                cur.execute(
                    """
                    INSERT INTO offer
                        (merchant_id, external_id, url, title_raw, brand_raw, category_raw,
                         image_url, current_price, in_stock)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, TRUE)
                    RETURNING id
                    """,
                    (
                        merchant_id,
                        f"enr-{index:03d}",
                        f"https://{DOMAIN}/urun/{index}",
                        # Her uc offer ayni basligi paylasir: metin yinelemesi
                        # de sinanabilsin.
                        f"Test Urun {index % DISTINCT_IMAGES}",
                        "Test Marka",
                        "moda/canta",
                        f"https://{DOMAIN}/img/{index}.png",
                        10000 + index,
                    ),
                )
                assert cur.fetchone() is not None
        owner.commit()

        yield merchant_id

        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, {"domain": DOMAIN})
        owner.commit()


def _count(sql: str, params: tuple = ()) -> int:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
    return int(row[0]) if row else 0


EMBEDDINGS = """
SELECT count(*) FROM embedding e
  JOIN offer o ON o.id = e.target_id
  JOIN merchant m ON m.id = o.merchant_id
 WHERE e.target_type = 'offer' AND e.kind = %s AND m.domain = %s
"""

DISTINCT_HASHES = """
SELECT count(DISTINCT o.image_hash) FROM offer o
  JOIN merchant m ON m.id = o.merchant_id
 WHERE m.domain = %s AND o.image_hash IS NOT NULL
"""


def test_every_offer_gets_a_row_but_each_image_is_embedded_once(offers: int) -> None:
    """Kabul kriteri: cok satir, az cagri.

    12 offer, 3 farkli gorsel -> 12 embedding satiri ama saglayiciya yalnizca
    3 gorsel gider. Pahali olan satir degil, model cagrisi.
    """
    fake = FakeEmbeddingClient()
    with _app() as conn:
        counts = embed_images(conn, fake, merchant_id=offers, http=_image_client())
        conn.commit()

    assert counts.considered == OFFER_COUNT
    assert counts.embedded == OFFER_COUNT
    assert counts.deduped == OFFER_COUNT - DISTINCT_IMAGES

    # Saglayiciya giden FARKLI girdi sayisi tam olarak gorsel sayisi kadar.
    assert len(fake.inputs_seen) == DISTINCT_IMAGES
    assert len(set(fake.inputs_seen)) == DISTINCT_IMAGES

    assert _count(EMBEDDINGS, ("image", DOMAIN)) == OFFER_COUNT
    assert _count(DISTINCT_HASHES, (DOMAIN,)) == DISTINCT_IMAGES


def test_image_hash_is_a_real_sha256(offers: int) -> None:
    with _app() as conn:
        embed_images(conn, FakeEmbeddingClient(), merchant_id=offers, http=_image_client())
        conn.commit()

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT o.image_hash FROM offer o JOIN merchant m ON m.id = o.merchant_id
             WHERE m.domain = %s
            """,
            (DOMAIN,),
        )
        hashes = [row[0] for row in cur.fetchall()]

    assert len(hashes) == DISTINCT_IMAGES
    for value in hashes:
        assert len(value) == 64
        assert all(char in "0123456789abcdef" for char in value)


def test_second_run_makes_no_api_calls(offers: int) -> None:
    """Idempotentlik: ikinci kosu hicbir offer secmez."""
    with _app() as conn:
        embed_images(conn, FakeEmbeddingClient(), merchant_id=offers, http=_image_client())
        conn.commit()

    second = FakeEmbeddingClient()
    with _app() as conn:
        counts = embed_images(conn, second, merchant_id=offers, http=_image_client())
        conn.commit()

    assert counts.considered == 0
    assert counts.embedded == 0
    assert second.calls == 0
    assert _count(EMBEDDINGS, ("image", DOMAIN)) == OFFER_COUNT


def test_text_embeddings_share_calls_for_identical_titles(offers: int) -> None:
    fake = FakeEmbeddingClient()
    with _app() as conn:
        counts = embed_texts(conn, fake, merchant_id=offers)
        conn.commit()

    assert counts.embedded == OFFER_COUNT
    # 12 offer ama 3 farkli kanonik metin.
    assert len(set(fake.inputs_seen)) == DISTINCT_IMAGES
    assert counts.deduped == OFFER_COUNT - DISTINCT_IMAGES
    assert _count(EMBEDDINGS, ("text", DOMAIN)) == OFFER_COUNT


def test_model_calls_are_recorded_in_api_usage(offers: int) -> None:
    """CLAUDE.md 9. kural: her model cagrisi api_usage'a yazilir."""
    fake = FakeEmbeddingClient()
    before = _count("SELECT count(*) FROM api_usage WHERE operation = 'image_embedding'")

    with _app() as conn:
        counts = embed_images(conn, fake, merchant_id=offers, http=_image_client())
        conn.commit()

    after = _count("SELECT count(*) FROM api_usage WHERE operation = 'image_embedding'")
    assert after - before == counts.api_calls == fake.calls


def test_unreachable_image_is_skipped_not_fatal(offers: int) -> None:
    """Tek bir bozuk gorsel kosuyu durdurmaz; sayilir ve gecilir."""

    def handler(request: httpx.Request) -> httpx.Response:
        index = int(request.url.path.rsplit("/", 1)[-1].split(".")[0])
        if index == 0:
            return httpx.Response(404)
        images = _images()
        return httpx.Response(
            200, content=images[index % len(images)], headers={"content-type": "image/png"}
        )

    with _app() as conn:
        counts = embed_images(
            conn,
            FakeEmbeddingClient(),
            merchant_id=offers,
            http=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        conn.commit()

    assert counts.skipped > 0
    assert counts.embedded == OFFER_COUNT - counts.skipped
    assert counts.errors
