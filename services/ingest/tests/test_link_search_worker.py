"""Link aramasi: worker'in `link_resolution_request`e yazdigi arama durumu (0035).

`test_link_worker.py` durum gecislerini dogrular; burada link aramasinin
ihtiyac duydugu ciktilar: kararli hata kodu, sinyaller (`source`), fiyatsiz
referans sayfa ve kaynak gorselin embedding'i. Ag yok: sayfa ve gorsel
`MockTransport`, embedding `FakeEmbeddingClient`.
"""

from __future__ import annotations

import io
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pytest
from PIL import Image

from collect.link.robots import RobotsCache
from collect.link.worker import process_one
from db.connection import database_url
from enrich.client import FakeEmbeddingClient

pytestmark = pytest.mark.integration

DOMAIN = "test-link-arama-magaza.example"
FIXTURES = Path(__file__).parent / "fixtures" / "link"

CLEANUP_STATEMENTS = (
    "DELETE FROM link_resolution_request WHERE url_raw LIKE %(pattern)s",
    # Fiyatsiz referans gorseli: image_upload + 'query' embedding'i (oturum sabit).
    """WITH u AS (DELETE FROM image_upload WHERE session_id = 'test-session' RETURNING id)
       DELETE FROM embedding WHERE target_type = 'query' AND target_id IN (SELECT id FROM u)""",
    "DELETE FROM api_usage WHERE session_id = 'test-session' AND operation = 'image_embedding'",
    # Ic adres testi alan adi disinda bir URL kullanir.
    "DELETE FROM link_resolution_request WHERE url_raw LIKE 'http://169.254.169.254/%%'",
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


def _jpeg() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (900, 600), (20, 20, 20)).save(out, format="JPEG")
    return out.getvalue()


def _page_client(page: str, *, status: int = 200) -> httpx.Client:
    body = (FIXTURES / page).read_text(encoding="utf-8").replace("ornekmagaza.example", DOMAIN)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nAllow: /\n")
        return httpx.Response(
            status, text=body, headers={"content-type": "text/html; charset=utf-8"}
        )

    return httpx.Client(transport=httpx.MockTransport(handler))


def _image_client(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def _good_image(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, content=_jpeg(), headers={"content-type": "image/jpeg"})


@pytest.fixture
def clean_domain() -> Iterator[None]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    params = {"domain": DOMAIN, "pattern": f"%{DOMAIN}%"}
    with owner:
        with owner.cursor() as cur:
            for statement in CLEANUP_STATEMENTS:
                cur.execute(statement, params)
        owner.commit()
        yield
        with owner.cursor() as cur:
            for statement in CLEANUP_STATEMENTS:
                cur.execute(statement, params)
        owner.commit()


def _run(url: str, page_client: httpx.Client, **kwargs: Any) -> dict[str, Any]:
    with _app() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO link_resolution_request (url_raw, session_id) "
                "VALUES (%s, 'test-session') RETURNING id",
                (url,),
            )
            row = cur.fetchone()
        conn.commit()
        assert row is not None
        request_id = str(row[0])
        process_one(
            conn,
            request_id,
            client=page_client,
            robots=RobotsCache(client=page_client),
            **kwargs,
        )

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT status, offer_id, error_code, normalized_url, source,
                   image_embedding_id, finished_at IS NOT NULL
              FROM link_resolution_request WHERE id = %s
            """,
            (request_id,),
        )
        result = cur.fetchone()
    assert result is not None
    keys = ("status", "offer_id", "error_code", "normalized_url", "source", "embedding", "done")
    return dict(zip(keys, result, strict=True))


def test_product_page_yields_signals_and_image_embedding(clean_domain: None) -> None:
    embedder = FakeEmbeddingClient()
    row = _run(
        f"https://www.{DOMAIN}/urun/deri-canta?utm_source=ig#yorumlar",
        _page_client("product_jsonld.html"),
        embedder=embedder,
        image_http=_image_client(_good_image),
    )

    assert row["status"] == "resolved" and row["done"]
    assert row["offer_id"] is not None
    assert row["error_code"] is None
    # Izleme parametresi ve fragment yok; `www.` getirilen adreste kalir.
    assert row["normalized_url"] == f"https://www.{DOMAIN}/urun/deri-canta"

    source = row["source"]
    assert source["title"] == "Deri Omuz Cantasi Siyah"
    assert source["brand"] == "Kuzey Deri"
    assert source["gtin"] == "8680000000123"
    assert source["mpn"] == "KD-CN-001"
    assert source["price"] == 189990 and source["currency"] == "TRY"
    assert source["extraction_layer"] == "json_ld"
    assert source["image_status"] == "embedded"
    assert row["embedding"] is not None
    assert embedder.calls == 1


def test_second_resolution_of_same_image_does_not_call_the_provider(clean_domain: None) -> None:
    embedder = FakeEmbeddingClient()
    for _ in range(2):
        row = _run(
            f"https://{DOMAIN}/urun/deri-canta",
            _page_client("product_jsonld.html"),
            embedder=embedder,
            image_http=_image_client(_good_image),
        )
        assert row["source"]["image_status"] == "embedded"
    assert embedder.calls == 1


def test_shopify_page_uses_image_object_url_and_sku(clean_domain: None) -> None:
    requested: list[str] = []

    def image(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return _good_image(request)

    row = _run(
        f"https://{DOMAIN}/products/siyah-deri-sirt-cantasi",
        _page_client("product_shopify.html"),
        embedder=FakeEmbeddingClient(),
        image_http=_image_client(image),
    )
    source = row["source"]
    assert source["sku"] == "ODB-SRT-001-BLK"
    assert source["image_url"] == "https://cdn.shopify.example/s/files/1/0001/canta-1.jpg?v=1"
    assert source["price"] == 249900 and source["currency"] == "TRY"
    assert requested == [source["image_url"]]


def test_missing_image_resolves_for_text_search(clean_domain: None) -> None:
    # Sezgisel katman: gorsel yok. Fiyat kataloga dusuk guvenle girer ama
    # kaynak kartina (sinyallere) yazilmaz.
    embedder = FakeEmbeddingClient()
    row = _run(
        f"https://{DOMAIN}/urun/yalin",
        _page_client("product_bare.html"),
        embedder=embedder,
        image_http=_image_client(_good_image),
    )
    assert row["status"] == "resolved"
    assert "image_url" not in row["source"]
    assert row["source"]["image_status"] == "missing"
    assert row["source"]["extraction_layer"] == "heuristic"
    assert "price" not in row["source"]
    assert row["embedding"] is None
    assert embedder.calls == 0


def test_broken_image_still_resolves_without_embedding(clean_domain: None) -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"bu bir gorsel degil", headers={"content-type": "image/jpeg"}
        )

    embedder = FakeEmbeddingClient()
    row = _run(
        f"https://{DOMAIN}/urun/deri-canta",
        _page_client("product_jsonld.html"),
        embedder=embedder,
        image_http=_image_client(broken),
    )
    assert row["status"] == "resolved"
    assert row["embedding"] is None
    assert row["source"]["image_status"] == "rejected"
    assert embedder.calls == 0


def test_no_embedding_provider_resolves_text_only(clean_domain: None) -> None:
    row = _run(f"https://{DOMAIN}/urun/deri-canta", _page_client("product_jsonld.html"))
    assert row["status"] == "resolved"
    assert row["source"]["image_status"] == "unavailable"
    assert row["embedding"] is None


def test_price_less_product_page_is_a_reference_not_an_offer(clean_domain: None) -> None:
    before = _catalog_counts()
    row = _run(
        f"https://{DOMAIN}/urun/sandalye",
        _page_client("product_reference_no_price.html"),
        embedder=FakeEmbeddingClient(),
        image_http=_image_client(_good_image),
    )
    assert row["status"] == "resolved"
    assert row["offer_id"] is None  # kataloga fiyatsiz offer yazilmadi
    source = row["source"]
    assert source["title"] == "Ahsap Yemek Sandalyesi Ceviz"
    # Govdedeki "1299 TL" fiyat SAYILMADI.
    assert "price" not in source and "currency" not in source
    assert source["image_url"] == f"https://{DOMAIN}/media/sandalye-ceviz.jpg"
    assert source["image_status"] == "embedded"
    assert row["embedding"] is not None
    assert _catalog_counts() == before


def _catalog_counts() -> tuple[int, ...]:
    """Katalog yazilmadigini kanitlamak icin: offer, price_point, product satir sayilari."""
    with _owner() as conn, conn.cursor() as cur:
        counts: list[int] = []
        for table in ("offer", "price_point", "product"):
            cur.execute(f"SELECT count(*) FROM {table}")  # noqa: S608 - sabit ad
            counts.append(cur.fetchone()[0])  # type: ignore[index]
    return tuple(counts)


def _reference_rows() -> list[tuple[Any, ...]]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT u.id, u.user_id, u.session_id, u.status, u.object_key, u.has_face,
                   length(u.image_hash), u.embedding_id, e.target_type, e.target_id,
                   e.kind, e.model_version
              FROM image_upload u JOIN embedding e ON e.id = u.embedding_id
             WHERE u.session_id = 'test-session' ORDER BY u.id
            """
        )
        return cur.fetchall()


def _usage(cache_hit: bool) -> int:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM api_usage WHERE session_id = 'test-session'"
            " AND operation = 'image_embedding' AND cache_hit = %s",
            (cache_hit,),
        )
        return cur.fetchone()[0]  # type: ignore[index]


def test_price_less_reference_stores_upload_and_query_embedding(clean_domain: None) -> None:
    embedder = FakeEmbeddingClient()
    before = _catalog_counts()
    row = _run(
        f"https://{DOMAIN}/urun/sandalye",
        _page_client("product_reference_no_price.html"),
        embedder=embedder,
        image_http=_image_client(_good_image),
    )
    assert row["offer_id"] is None and row["source"]["image_status"] == "embedded"
    assert _catalog_counts() == before

    rows = _reference_rows()
    assert len(rows) == 1
    (
        upload_id,
        user_id,
        session,
        status,
        object_key,
        has_face,
        hash_len,
        embedding_id,
        target_type,
        target_id,
        kind,
        model_version,
    ) = rows[0]
    assert (user_id, session, status, object_key, has_face) == (
        None,
        "test-session",
        "embedded",
        None,
        False,
    )
    assert hash_len == 64
    assert (target_type, target_id, kind) == ("query", upload_id, "image")
    assert model_version == embedder.model_version
    assert row["embedding"] == embedding_id
    assert embedder.calls == 1
    assert _usage(cache_hit=False) == 1


def test_same_reference_image_twice_skips_the_provider(clean_domain: None) -> None:
    embedder = FakeEmbeddingClient()
    ids = []
    for _ in range(2):
        row = _run(
            f"https://{DOMAIN}/urun/sandalye",
            _page_client("product_reference_no_price.html"),
            embedder=embedder,
            image_http=_image_client(_good_image),
        )
        assert row["source"]["image_status"] == "embedded"
        ids.append(row["embedding"])
    assert embedder.calls == 1
    assert ids[0] != ids[1]  # her istek kendi satirini tutar
    assert len(_reference_rows()) == 2
    assert _usage(cache_hit=False) == 1 and _usage(cache_hit=True) == 1


def test_price_less_without_image_is_missing(clean_domain: None) -> None:
    embedder = FakeEmbeddingClient()
    row = _run(
        f"https://{DOMAIN}/urun/sehpa",
        _page_client("product_reference_no_image.html"),
        embedder=embedder,
        image_http=_image_client(_good_image),
    )
    assert row["status"] == "resolved" and row["offer_id"] is None
    assert row["source"]["image_status"] == "missing"
    assert row["embedding"] is None and embedder.calls == 0
    assert _reference_rows() == []


def test_price_less_download_failure_is_failed(clean_domain: None) -> None:
    def gone(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="yok")

    embedder = FakeEmbeddingClient()
    row = _run(
        f"https://{DOMAIN}/urun/sandalye",
        _page_client("product_reference_no_price.html"),
        embedder=embedder,
        image_http=_image_client(gone),
    )
    assert row["status"] == "resolved"
    assert row["source"]["image_status"] == "failed"
    assert row["embedding"] is None and embedder.calls == 0
    assert _reference_rows() == []


def test_price_less_rejected_image_is_rejected(clean_domain: None) -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"gorsel degil", headers={"content-type": "image/jpeg"})

    row = _run(
        f"https://{DOMAIN}/urun/sandalye",
        _page_client("product_reference_no_price.html"),
        embedder=FakeEmbeddingClient(),
        image_http=_image_client(broken),
    )
    assert row["source"]["image_status"] == "rejected" and row["embedding"] is None


def test_price_less_without_embedder_is_unavailable(clean_domain: None) -> None:
    row = _run(f"https://{DOMAIN}/urun/sandalye", _page_client("product_reference_no_price.html"))
    assert row["status"] == "resolved"
    assert row["source"]["image_status"] == "unavailable" and row["embedding"] is None


def test_page_without_product_fails_with_stable_code(clean_domain: None) -> None:
    row = _run(f"https://{DOMAIN}/hakkimizda", _page_client("not_a_product.html"))
    assert row["status"] == "failed" and row["done"]
    assert row["error_code"] == "no_product"


@pytest.mark.parametrize(
    ("status", "code"), [(404, "not_found"), (429, "rate_limited"), (502, "upstream_error")]
)
def test_http_failures_are_terminal_with_code(clean_domain: None, status: int, code: str) -> None:
    row = _run(f"https://{DOMAIN}/urun/yok", _page_client("product_jsonld.html", status=status))
    assert row["status"] == "failed" and row["done"]
    assert row["error_code"] == code
    assert row["offer_id"] is None


def test_internal_address_is_never_fetched(clean_domain: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"ic adrese istek gitmemeliydi: {request.url}")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    row = _run("http://169.254.169.254/latest/meta-data/", client)
    assert row["status"] == "failed"
    assert row["error_code"] in {"invalid_url", "blocked_destination"}
