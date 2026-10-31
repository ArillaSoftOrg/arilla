"""Platform adapter testleri: esleme, JSON/CSV/XML/API adapter'lari, kontrol noktasi.

Veritabani ve ag YOK. Fixture'lar SENTETIKTIR (bkz. tests/fixtures/platforms/README.md).
"""

from __future__ import annotations

import json
import re
from collections import Counter
from datetime import UTC, datetime
from itertools import islice
from pathlib import Path

import pytest

from platforms.adapters import (
    CsvAdapter,
    JsonFileAdapter,
    JsonPagesAdapter,
    Page,
    SourceUnavailable,
    XmlAdapter,
    build_adapter,
    map_record,
)
from platforms.adapters.mapping import FieldMapping, clean_gtin, parse_money
from platforms.adapters.samples import (
    GENERIC_CSV_MAPPING,
    GENERIC_XML_MAPPING,
    HEPSIBURADA_SAMPLE_MAPPING,
    TRENDYOL_SAMPLE_MAPPING,
)
from platforms.constraints import SourceConstraints
from platforms.contract import (
    CanonicalListing,
    Checkpoint,
    Rejection,
    SourceAdapter,
    offer_key,
)
from platforms.registry import (
    HEPSIBURADA,
    HEPSIBURADA_URL,
    TRENDYOL,
    MerchantInfo,
    SourceDefinition,
)

FIXTURES = Path(__file__).parent / "fixtures" / "platforms"
NOW = datetime(2026, 10, 31, 12, 0, tzinfo=UTC)


def _definition(slug: str, kind: str, currency: str | None = "TRY") -> SourceDefinition:
    return SourceDefinition(
        slug=slug,
        kind=kind,  # type: ignore[arg-type]
        merchant=MerchantInfo(name=slug, domain=f"{slug}.example.invalid", source_type="xml_feed"),
        constraints=SourceConstraints(),
        currency=currency,
    )


def _hb(**kw) -> JsonFileAdapter:
    return build_adapter(
        HEPSIBURADA,
        FIXTURES / "hepsiburada_sample.json",
        HEPSIBURADA_SAMPLE_MAPPING,
        records_path="products",
        observed_at=NOW,
        **kw,
    )  # type: ignore[return-value]


def _ty(**kw) -> JsonFileAdapter:
    return build_adapter(
        TRENDYOL,
        FIXTURES / "trendyol_sample.json",
        TRENDYOL_SAMPLE_MAPPING,
        records_path="content",
        observed_at=NOW,
        **kw,
    )  # type: ignore[return-value]


def _csv() -> CsvAdapter:
    return build_adapter(
        _definition("csvshop", "csv"),
        FIXTURES / "generic.csv",
        GENERIC_CSV_MAPPING,
        observed_at=NOW,
    )  # type: ignore[return-value]


def _xml() -> XmlAdapter:
    return build_adapter(
        _definition("xmlshop", "xml"),
        FIXTURES / "generic.xml",
        GENERIC_XML_MAPPING,
        observed_at=NOW,
    )  # type: ignore[return-value]


def _split(items):
    good = [i for i in items if isinstance(i, CanonicalListing)]
    bad = [i for i in items if isinstance(i, Rejection)]
    return good, bad


def _codes(items) -> Counter:
    return Counter(i.code for i in items if isinstance(i, Rejection))


# ---------------------------------------------------------------- esleme / para


@pytest.mark.parametrize(
    ("raw", "kurus"),
    [
        ("1.299,90", 129990),
        ("1299,90", 129990),
        ("1.299.999,99", 129999999),
        ("0,99", 99),
        ("12,345", 1235),  # yarim kurus yukari (1234.5)
        ("12,344", 1234),
        ("249,90 TL", 24990),
        ("TRY 45", 4500),
        ("   ", None),
        (None, None),
        (1299.9, 129990),  # JSON sayisi: yazilan haneler, ikili kesir hatasi yok
        (0.1 + 0.2, 30),
        (899, 89900),
        ("", None),
    ],
)
def test_parse_money_tr_formats(raw, kurus):
    assert parse_money(raw) == kurus


def test_parse_money_never_float_and_minor():
    for raw in ("1.299,90", 1299.9, 5, "0,01"):
        assert type(parse_money(raw)) is int
    assert parse_money("129990", minor=True) == 129990
    assert parse_money(1.005) == 101  # Decimal('1.005') yarim yukari; float 1.00499.. tuzagi yok


@pytest.mark.parametrize("raw", ["abc", "1.29,90", "1,2,3", "12,3.4", "ucretsiz", True, "--"])
def test_parse_money_rejects_garbage(raw):
    with pytest.raises(ValueError):
        parse_money(raw)


def test_parse_money_custom_separators():
    assert parse_money("1,299.90", decimal_separator=".", thousands_separator=",") == 129990
    assert parse_money("1299.90", decimal_separator=".", thousands_separator="") == 129990


M = FieldMapping(
    listing_id="id",
    title="title",
    url="url",
    price="price",
    currency="TRY",
    in_stock="stock",
    seller_id="seller.id",
    category="cat",
    images="imgs",
    options={"renk": "meta.color"},
)


def _rec(**kw):
    base = {"id": "A1", "title": "T", "url": "https://x.example.invalid/a", "price": "10,50"}
    base.update(kw)
    return base


def test_map_record_basic_and_nested_paths():
    got = map_record(
        _rec(seller={"id": 77}, meta={"color": "Mavi"}, cat="A > B >  C", imgs=["https://i/1.jpg"]),
        M,
        "shop",
        NOW,
        "ref1",
    )
    assert isinstance(got, CanonicalListing)
    assert got.price == 1050 and type(got.price) is int
    assert got.seller_id == "77"
    assert got.options == {"renk": "Mavi"}
    assert got.category_path == ("A", "B", "C")
    assert got.image_urls == ("https://i/1.jpg",)
    assert got.source_ref == "ref1" and got.observed_at == NOW and got.currency == "TRY"


def test_missing_stock_is_none_never_out_of_stock():
    assert map_record(_rec(), M, "shop", NOW).in_stock is None
    assert map_record(_rec(stock=""), M, "shop", NOW).in_stock is None
    assert map_record(_rec(stock="belki"), M, "shop", NOW).in_stock is None
    assert map_record(_rec(stock="in stock"), M, "shop", NOW).in_stock is True
    assert map_record(_rec(stock="YOK"), M, "shop", NOW).in_stock is False
    assert map_record(_rec(stock=False), M, "shop", NOW).in_stock is False
    assert map_record(_rec(stock=1), M, "shop", NOW).in_stock is True


def test_custom_stock_value_sets():
    m = FieldMapping(
        "id",
        "title",
        "url",
        currency="TRY",
        in_stock="s",
        in_stock_true=frozenset({"evet"}),
        in_stock_false=frozenset({"hayir"}),
    )
    assert map_record(_rec(s="Evet"), m, "shop", NOW).in_stock is True
    assert map_record(_rec(s="hayir"), m, "shop", NOW).in_stock is False
    assert map_record(_rec(s="yes"), m, "shop", NOW).in_stock is None


@pytest.mark.parametrize(
    ("patch", "code"),
    [
        ({"id": None}, "missing_listing_id"),
        ({"id": "  "}, "missing_listing_id"),
        ({"id": "a b"}, "bad_listing_id"),
        ({"id": "a~b"}, "bad_listing_id"),
        ({"title": ""}, "missing_title"),
        ({"url": None}, "missing_url"),
        ({"url": "ftp://x/y"}, "bad_url"),
        ({"url": "/goreli"}, "bad_url"),
        ({"price": "bedava"}, "price_not_numeric"),
        ({"price": "-1,00"}, "price_negative"),
        ({"price": "99999999999"}, "price_out_of_range"),
    ],
)
def test_map_record_rejections(patch, code):
    got = map_record(_rec(**patch), M, "shop", NOW, "r")
    assert isinstance(got, Rejection)
    assert got.code == code and got.source_ref == "r"


def test_map_record_never_raises_on_odd_input():
    for odd in (None, 5, "str", [], {"id": {"x": 1}, "title": [], "url": 3}):
        got = map_record(odd, M, "shop", NOW)  # type: ignore[arg-type]
        assert isinstance(got, Rejection)


def test_currency_from_field_overrides_fixed_and_missing_rejects():
    m = FieldMapping("id", "title", "url", currency="TRY", currency_field="cur")
    assert map_record(_rec(cur="usd"), m, "shop", NOW).currency == "USD"
    assert map_record(_rec(cur=""), m, "shop", NOW).currency == "TRY"
    none = FieldMapping("id", "title", "url")
    assert map_record(_rec(), none, "shop", NOW).code == "missing_currency"  # type: ignore[union-attr]
    assert map_record(_rec(cur="Lira"), m, "shop", NOW).code == "bad_currency"  # type: ignore[union-attr]


def test_never_invents_optional_fields():
    got = map_record(_rec(), M, "shop", NOW)
    assert (got.brand, got.gtin, got.mpn, got.seller_id, got.list_price) == (None,) * 5
    assert got.category_path == () and got.image_urls == () and dict(got.options) == {}


def test_gtin_cleaning():
    assert clean_gtin("8690000000012") == "8690000000012"
    assert clean_gtin("8690000000013") is None  # kontrol basamagi yanlis
    assert clean_gtin("0000000000000") is None  # yer tutucu
    assert clean_gtin("") is None and clean_gtin(None) is None
    assert clean_gtin("abc") is None


def test_images_delimited_and_dict_items_dedup():
    m = FieldMapping("id", "title", "url", currency="TRY", images="imgs", image_separator="|")
    got = map_record(
        _rec(imgs="https://a/1.jpg|https://a/1.jpg|junk|https://a/2.jpg"), m, "shop", NOW
    )
    assert got.image_urls == ("https://a/1.jpg", "https://a/2.jpg")
    m2 = FieldMapping("id", "title", "url", currency="TRY", images="imgs", image_key="u")
    got2 = map_record(_rec(imgs=[{"u": "https://a/9.jpg"}, {"x": 1}]), m2, "shop", NOW)
    assert got2.image_urls == ("https://a/9.jpg",)


def test_category_list_and_relative_url_base():
    m = FieldMapping(
        "id",
        "title",
        "url",
        currency="TRY",
        category="cat",
        url_base="https://shop.example.invalid/",
    )
    got = map_record(_rec(cat=["A", " B ", ""], url="/p/1"), m, "shop", NOW)
    assert got.category_path == ("A", "B") and got.url == "https://shop.example.invalid/p/1"


# ---------------------------------------------------------------- uc uca adapter'lar


def test_adapters_satisfy_protocol():
    pages = JsonPagesAdapter("shop", M, lambda t: Page([]))
    for adapter in (_hb(), _ty(), _csv(), _xml(), pages):
        assert isinstance(adapter, SourceAdapter)


def test_hepsiburada_sample_end_to_end():
    adapter = _hb()
    items = list(adapter.fetch())
    good, bad = _split(items)
    assert (len(good), len(bad)) == (11, 3)
    assert _codes(items) == {"missing_title": 1, "price_not_numeric": 1, "bad_url": 1}
    first = good[0]
    assert (first.listing_id, first.price, first.list_price) == ("HBSAMPLE001", 2499990, 2799900)
    assert first.in_stock is True and first.currency == "TRY" and first.seller_id is None
    assert first.category_path == ("Elektronik", "Telefon", "Akilli Telefon")
    assert first.options == {"renk": "Siyah"} and first.mpn == "MDL-1"
    by_id = {g.listing_id: g for g in good}
    assert by_id["HBSAMPLE005"].in_stock is None and by_id["HBSAMPLE005"].brand is None
    assert by_id["HBSAMPLE003"].in_stock is False
    assert by_id["HBSAMPLE004"].gtin is None  # eksik
    assert by_id["HBSAMPLE006"].gtin is None  # yer tutucu
    assert by_id["HBSAMPLE011"].gtin is None  # kontrol basamagi bozuk
    assert by_id["HBSAMPLE002"].gtin is not None
    for g in good:  # kimlik, adresteki p/pm koduyla ayni
        assert HEPSIBURADA_URL.match(g.url).group(1) == g.listing_id
    assert adapter.checkpoint.processed == 14


def test_trendyol_multi_seller_keys_distinct():
    items = list(_ty().fetch())
    good, bad = _split(items)
    assert (len(good), len(bad)) == (10, 3)
    assert _codes(items) == {
        "missing_seller_id": 1,
        "price_negative": 1,
        "price_not_numeric": 1,
    }
    keys = [offer_key("listing_seller", g.listing_id, g.seller_id) for g in good]
    assert len(set(keys)) == len(keys) == 10
    same_listing = [g for g in good if g.listing_id == "700001"]
    assert len(same_listing) == 3 and len({g.seller_id for g in same_listing}) == 3
    assert [g.price for g in same_listing] == [129990, 134900, 127550]
    assert [g.in_stock for g in same_listing] == [True, True, False]
    ids = {g.listing_id: g for g in good if g.seller_id == "1004"}
    assert ids["700002"].in_stock is None  # inStock yok -> bilinmiyor
    assert ids["700006"].in_stock is True and ids["700006"].price == 100000
    assert {g.listing_id: g.in_stock for g in good}["700007"] is False
    assert same_listing[0].image_urls
    assert same_listing[0].options == {"renk": "Siyah"}


def test_trendyol_without_seller_scheme_would_collide():
    """Anahtar semasi `listing` olsaydi ayni ilan 3 saticida cakisirdi (neden listing_seller)."""
    good, _ = _split(list(_ty().fetch()))
    plain = [offer_key("listing", g.listing_id, g.seller_id) for g in good]
    assert len(set(plain)) < len(plain)


def test_csv_end_to_end():
    items = list(_csv().fetch())
    good, bad = _split(items)
    assert (len(good), len(bad)) == (7, 1)
    assert _codes(items) == {"missing_listing_id": 1}
    by_id = {g.listing_id: g for g in good}
    assert by_id["CSV002"].price == 123456 and by_id["CSV002"].in_stock is False
    assert by_id["CSV002"].list_price is None and by_id["CSV002"].gtin is None
    assert by_id["CSV003"].in_stock is None  # bos hucre
    assert by_id["CSV003"].gtin is None  # yer tutucu
    assert by_id["CSV005"].price == 1235
    assert by_id["CSV001"].gtin == "8690000000012"
    assert len(by_id["CSV001"].image_urls) == 2
    assert by_id["CSV007"].in_stock is False


def test_xml_end_to_end():
    items = list(_xml().fetch())
    good, bad = _split(items)
    assert (len(good), len(bad)) == (5, 1)
    assert _codes(items) == {"price_not_numeric": 1}
    by_id = {g.listing_id: g for g in good}
    assert by_id["XML001"].price == 14990 and by_id["XML001"].currency == "TRY"
    assert by_id["XML003"].price == 109900 and by_id["XML003"].in_stock is None
    assert by_id["XML002"].in_stock is False
    assert (
        by_id["XML001"].image_urls[0].endswith("xml1b.jpg") and len(by_id["XML001"].image_urls) == 2
    )
    assert by_id["XML001"].category_path == ("Ev", "Dekorasyon")
    assert by_id["XML004"].gtin is None and by_id["XML001"].gtin is not None


def test_total_fixture_volume_and_validation():
    everything = [*_hb().fetch(), *_ty().fetch(), *_csv().fetch(), *_xml().fetch()]
    assert len(everything) >= 25
    good, _ = _split(everything)
    for g in good:
        # CanonicalListing yeniden dogrulanir (post_init); float yok.
        CanonicalListing(**{f: getattr(g, f) for f in g.__dataclass_fields__})
        assert g.price is None or type(g.price) is int
        assert g.list_price is None or type(g.list_price) is int
        assert g.observed_at == NOW


# ---------------------------------------------------------------- kontrol noktasi / idempotans


def _resume_matches(make, n):
    full = list(make().fetch())
    n = min(n, len(full))
    first = make()
    head = list(islice(first.fetch(), n))
    cp = first.checkpoint
    assert cp.processed == n
    tail = list(make().fetch(cp))
    assert head + tail == full  # bosluk ve tekrar yok
    return full


@pytest.mark.parametrize("make", [_hb, _ty, _csv, _xml])
@pytest.mark.parametrize("n", [0, 1, 5, 9])
def test_checkpoint_resume_no_gap_no_dup(make, n):
    _resume_matches(make, n)


@pytest.mark.parametrize("make", [_hb, _ty, _csv, _xml])
def test_resume_at_end_yields_nothing_and_run_twice_identical(make):
    a = make()
    first = list(a.fetch())
    assert list(make().fetch(a.checkpoint)) == []
    assert list(make().fetch()) == first  # idempotent


def _pages_of(path: Path, key: str, size: int):
    records = json.loads(path.read_text(encoding="utf-8"))[key]
    calls: list[str | None] = []

    def source(token):
        calls.append(token)
        start = int(token or 0)
        nxt = start + size
        return Page(records[start:nxt], str(nxt) if nxt < len(records) else None)

    return source, calls


def _api(size=4):
    source, calls = _pages_of(FIXTURES / "trendyol_sample.json", "content", size)
    return build_adapter(TRENDYOL, source, TRENDYOL_SAMPLE_MAPPING, observed_at=NOW), calls


def test_api_pages_full_run_matches_file_run():
    api, calls = _api()
    items = list(api.fetch())
    assert calls == [None, "4", "8", "12"]
    assert [i.code if isinstance(i, Rejection) else i.listing_id for i in items][:3] == [
        "700001"
    ] * 3
    from_file = list(_ty().fetch())

    # sayfa referanslari farkli; yalniz icerik ayni olmali
    def strip(i):
        return (i.code,) if isinstance(i, Rejection) else (i.listing_id, i.seller_id, i.price)

    assert [strip(i) for i in items] == [strip(i) for i in from_file]
    assert api.checkpoint.cursor == {"done": True} and api.checkpoint.processed == 13


@pytest.mark.parametrize("n", [0, 1, 3, 4, 5, 8, 12, 13])
def test_api_pages_resume_no_gap_no_dup(n):
    api, _ = _api()
    full = list(api.fetch())
    first, _ = _api()
    head = list(islice(first.fetch(), n))
    cp = first.checkpoint
    second, calls = _api()
    tail = list(second.fetch(cp))
    assert head + tail == full
    if n in (4, 8):  # sayfa sinirinda: onceki sayfa yeniden istenmez
        assert calls[0] == str(n)
    if n == 13:
        assert calls == []


def test_api_pages_cycle_and_failure_are_unavailable():
    loop = JsonPagesAdapter("shop", M, lambda t: Page([], "x"))
    with pytest.raises(SourceUnavailable) as exc:
        list(loop.fetch())
    assert exc.value.code == "page_cycle"

    def boom(token):
        raise TimeoutError

    with pytest.raises(SourceUnavailable) as exc2:
        list(JsonPagesAdapter("shop", M, boom).fetch())
    assert exc2.value.code == "page_fetch_failed"

    with pytest.raises(SourceUnavailable) as exc3:
        list(JsonPagesAdapter("shop", M, lambda t: Page([])).fetch(Checkpoint({"skip": -1})))
    assert exc3.value.code == "bad_checkpoint"


def test_api_non_object_record_is_rejection_only():
    page = Page([_rec(), "garip", None, _rec(id="A2")])
    items = list(JsonPagesAdapter("shop", M, lambda t: page).fetch())
    good, bad = _split(items)
    assert len(good) == 2 and _codes(items) == {"record_not_object": 2}


# ---------------------------------------------------------------- NDJSON / kaynak hatalari


def test_ndjson_resume_and_invalid_line(tmp_path):
    lines = [json.dumps(_rec(id=f"N{i}")) for i in range(6)]
    lines.insert(2, "{bozuk json")
    lines.insert(4, "")  # bos satir sayilmaz
    path = tmp_path / "feed.ndjson"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")

    def make():
        return build_adapter(_definition("ndshop", "json"), path, M, observed_at=NOW)

    full = list(make().fetch())
    good, bad = _split(full)
    assert (len(good), len(bad)) == (6, 1) and bad[0].code == "invalid_json_line"
    assert [g.listing_id for g in good] == [f"N{i}" for i in range(6)]
    first = make()
    head = list(islice(first.fetch(), 4))
    assert head + list(make().fetch(first.checkpoint)) == full


def test_json_array_file(tmp_path):
    path = tmp_path / "a.json"
    path.write_text(json.dumps([_rec(id="J1"), _rec(id="J2", price="x")]), encoding="utf-8")
    items = list(build_adapter(_definition("jshop", "json"), path, M, observed_at=NOW).fetch())
    assert [type(i).__name__ for i in items] == ["CanonicalListing", "Rejection"]


def test_source_unavailable_cases(tmp_path):
    d = _definition("badshop", "json")
    with pytest.raises(SourceUnavailable) as e1:
        list(build_adapter(d, tmp_path / "yok.json", M).fetch())
    assert e1.value.code == "file_unreadable"

    broken = tmp_path / "broken.json"
    broken.write_text('[{"id": 1,', encoding="utf-8")
    with pytest.raises(SourceUnavailable) as e2:
        list(build_adapter(d, broken, M).fetch())
    assert e2.value.code == "json_invalid"

    obj = tmp_path / "obj.json"
    obj.write_text('{"items": []}', encoding="utf-8")
    with pytest.raises(SourceUnavailable) as e3:
        list(build_adapter(d, obj, M, records_path="products").fetch())
    assert e3.value.code == "json_schema"

    empty = tmp_path / "empty.json"
    empty.write_text("  \n", encoding="utf-8")
    with pytest.raises(SourceUnavailable) as e4:
        list(build_adapter(d, empty, M).fetch())
    assert e4.value.code == "json_empty"

    binary = tmp_path / "b.json"
    binary.write_bytes(b"[\xff\xfe\x00]")
    with pytest.raises(SourceUnavailable) as e5:
        list(build_adapter(d, binary, M).fetch())
    assert e5.value.code == "file_unreadable"

    with pytest.raises(SourceUnavailable) as e6:
        list(build_adapter(d, tmp_path / "x.json", M).fetch(Checkpoint({"offset": -3})))
    assert e6.value.code == "bad_checkpoint"


def test_csv_missing_columns_and_empty(tmp_path):
    d = _definition("csvshop", "csv")
    bad = tmp_path / "bad.csv"
    bad.write_text("id;title;price\nA;B;1,00\n", encoding="utf-8")
    with pytest.raises(SourceUnavailable) as e1:
        list(build_adapter(d, bad, GENERIC_CSV_MAPPING).fetch())
    assert e1.value.code == "csv_missing_columns" and "link" in e1.value.detail

    empty = tmp_path / "empty.csv"
    empty.write_text("", encoding="utf-8")
    with pytest.raises(SourceUnavailable) as e2:
        list(build_adapter(d, empty, GENERIC_CSV_MAPPING).fetch())
    assert e2.value.code == "csv_empty"

    with pytest.raises(SourceUnavailable) as e3:
        list(build_adapter(d, tmp_path / "yok.csv", GENERIC_CSV_MAPPING).fetch())
    assert e3.value.code == "file_unreadable"

    wrong_delim = tmp_path / "w.csv"
    wrong_delim.write_text("id,title,link,price\nA,B,https://x/y,1\n", encoding="utf-8")
    with pytest.raises(SourceUnavailable) as e4:
        list(build_adapter(d, wrong_delim, GENERIC_CSV_MAPPING).fetch())
    assert e4.value.code == "csv_missing_columns"
    comma = list(
        CsvAdapter(
            "csvshop",
            GENERIC_CSV_MAPPING,
            wrong_delim,
            delimiter=",",
            observed_at=NOW,
        ).fetch()
    )
    assert comma[0].code == "missing_currency"  # para birimi tanimdan gelmedi


def test_xml_broken_and_no_records(tmp_path):
    d = _definition("xmlshop", "xml")
    broken = tmp_path / "b.xml"
    broken.write_text("<rss><channel><item><id>1</id></item><item>", encoding="utf-8")
    with pytest.raises(SourceUnavailable) as e1:
        list(build_adapter(d, broken, GENERIC_XML_MAPPING).fetch())
    assert e1.value.code == "xml_invalid"

    none = tmp_path / "n.xml"
    none.write_text("<rss><channel><x/></channel></rss>", encoding="utf-8")
    with pytest.raises(SourceUnavailable) as e2:
        list(build_adapter(d, none, GENERIC_XML_MAPPING).fetch())
    assert e2.value.code == "xml_no_records"

    with pytest.raises(SourceUnavailable) as e3:
        list(build_adapter(d, tmp_path / "yok.xml", GENERIC_XML_MAPPING).fetch())
    assert e3.value.code == "file_unreadable"


def test_xml_nested_and_custom_record_path(tmp_path):
    path = tmp_path / "n.xml"
    path.write_text(
        "<root><products><product><sku>S1</sku><name>Ad</name><url>https://x.example.invalid/1</url>"
        "<price>5,00</price><seller><id>9</id></seller></product></products></root>",
        encoding="utf-8",
    )
    m = FieldMapping("sku", "name", "url", price="price", seller_id="seller.id", currency="TRY")
    items = list(
        XmlAdapter("nest", m, path, record_path="root/products/product", observed_at=NOW).fetch()
    )
    assert items[0].seller_id == "9" and items[0].price == 500


# ---------------------------------------------------------------- build_adapter


def test_build_adapter_dispatch_and_currency_rules(tmp_path):
    assert isinstance(_hb(), JsonFileAdapter) and _hb().kind == "json"
    assert _csv().kind == "csv" and _xml().kind == "xml"
    api, _ = _api()
    assert isinstance(api, JsonPagesAdapter) and api.kind == "api"
    assert _ty().offer_key_scheme == "listing_seller"
    assert _hb().mapping.currency == "TRY"  # tanimdan dolduruldu

    wrong = FieldMapping("id", "title", "url", currency="USD")
    with pytest.raises(ValueError):
        build_adapter(_definition("s1", "csv"), tmp_path / "a.csv", wrong)
    with pytest.raises(ValueError):
        build_adapter(_definition("s2", "api"), tmp_path / "a.bin", M)


def test_fixtures_are_marked_synthetic():
    text = (FIXTURES / "README.md").read_text(encoding="utf-8")
    assert "SENTETIK" in text and "gercek" in text
    for name in ("hepsiburada_sample.json", "trendyol_sample.json"):
        assert "SENTETIK" in json.loads((FIXTURES / name).read_text(encoding="utf-8"))["_note"]
    assert not re.search(r"\r", (FIXTURES / "generic.csv").read_text(encoding="utf-8"))
