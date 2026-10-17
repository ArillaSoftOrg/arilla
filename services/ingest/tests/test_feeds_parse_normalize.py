"""Akis ayristirma ve normalizasyon (karar 0112)."""

from __future__ import annotations

import gzip
import json
import tracemalloc
import zipfile
from pathlib import Path

import pytest

from feeds.normalize import Rejected, normalize, parse_price, unwrap_url
from feeds.parsers import ParseResult, iter_records
from tests.feed_fixtures import AE_PROFILE, offer, tracking_url, write, yml

AE = "1005013326267337"


def records(path: Path, fmt: str = "yml", config: dict | None = None) -> tuple[list, ParseResult]:
    result = ParseResult()
    return list(iter_records(path, fmt, config or {}, result)), result


# --------------------------------------------------------------------------
# Ayristirma
# --------------------------------------------------------------------------


def test_yml_kategoriler_teklifler_parametreler(tmp_path: Path) -> None:
    path = write(tmp_path / "f.xml", yml([offer(AE), offer("1005000000000002", shop=None)]))
    recs, result = records(path)
    assert result.complete and result.error is None
    assert [r.fields["@id"] for r in recs] == [AE, "1005000000000002"]
    first = recs[0].fields
    assert first["name"] == f"Test product {AE}" and first["price"] == "22.11"
    assert len(first["picture"]) == 2
    assert first["param"]["shopId"] == "1105855203"
    assert "shopId" not in recs[1].fields["param"]
    assert result.categories["200000920"] == ("Kitchen Storage", "15")


def test_yml_kategori_ozniteliklerinin_sirasi_onemsiz(tmp_path: Path) -> None:
    """Karar 0133: `parentId` once gelirse ya da ek oznitelik varsa agac kaybolmamali."""
    body = yml([offer(AE, category="300")]).replace(
        b'<category id="200000920" parentId="15">Kitchen Storage</category>',
        b'<category parentId="15" id="300" lang="en">Coffeeware</category>'
        b"<category id='301'>Mugs</category>",
    )
    recs, result = records(write(tmp_path / "f.xml", body))
    assert len(recs) == 1
    assert result.categories["15"] == ("Home & Garden", None)
    assert result.categories["300"] == ("Coffeeware", "15")
    assert result.categories["301"] == ("Mugs", None)


def test_kesik_dosya_tamamlanmis_sayilmaz(tmp_path: Path) -> None:
    path = write(
        tmp_path / "f.xml", yml([offer(str(10**15 + i)) for i in range(50)], truncate=True)
    )
    recs, result = records(path)
    assert not result.complete
    assert 0 < len(recs) < 50


def test_gzip_ve_zip_icerikten_taninir(tmp_path: Path) -> None:
    data = yml([offer(AE)])
    gz = write(tmp_path / "f.bin", data, gz=True)
    assert records(gz)[1].complete and len(records(gz)[0]) == 1
    zpath = tmp_path / "f.zip"
    with zipfile.ZipFile(zpath, "w") as archive:
        archive.writestr("feed.xml", data)
    recs, result = records(zpath)
    assert result.complete and len(recs) == 1


def test_kesik_gzip_tamamlanmamis(tmp_path: Path) -> None:
    raw = gzip.compress(yml([offer(str(10**15 + i)) for i in range(200)]))
    path = tmp_path / "f.gz"
    path.write_bytes(raw[: len(raw) // 2])
    assert not records(path)[1].complete


def test_csv_ndjson_json(tmp_path: Path) -> None:
    csv_path = tmp_path / "f.csv"
    csv_path.write_text("id;name;price\n1;A;10,5\n2;B;3\n", encoding="utf-8")
    recs, result = records(csv_path, "csv", {"delimiter": ";"})
    assert result.complete and [r.fields["name"] for r in recs] == ["A", "B"]

    nd = tmp_path / "f.ndjson"
    nd.write_text('{"id":"1"}\n\n{"id":"2"}\n', encoding="utf-8")
    assert [r.fields["id"] for r in records(nd, "ndjson")[0]] == ["1", "2"]

    arr = tmp_path / "f.json"
    arr.write_text(
        json.dumps([{"id": str(i), "t": "x" * 50} for i in range(300)]), encoding="utf-8"
    )
    recs, result = records(arr, "json")
    assert result.complete and len(recs) == 300

    cut = tmp_path / "cut.json"
    cut.write_text(arr.read_text(encoding="utf-8")[:-40], encoding="utf-8")
    recs, result = records(cut, "json")
    assert not result.complete and len(recs) < 300


def test_buyuk_besleme_bellekte_tutulmaz(tmp_path: Path) -> None:
    """Kisitli kaynak: 30k kayitlik (gzip) besleme akisla; bellek kayit sayisiyla buyumez."""
    path = write(tmp_path / "big.gz", yml(offer(str(10**15 + i)) for i in range(30_000)), gz=True)
    tracemalloc.start()
    count = 0
    for _ in iter_records(path, "yml", {}, ParseResult()):
        count += 1
    _current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert count == 30_000
    # Dosya ~15 MB cozulmus; tepe bellek bunun cok altinda kalmali.
    assert peak < 8 * 1024 * 1024, peak


# --------------------------------------------------------------------------
# Normalizasyon
# --------------------------------------------------------------------------


def norm(rec_fields: dict, config: dict | None = None, currency: str | None = "USD"):
    path_cfg = config if config is not None else AE_PROFILE
    from feeds.parsers import FeedRecord

    return normalize(
        FeedRecord(rec_fields, 0, "t"),
        path_cfg,
        expected_currency=currency,
        categories={
            "15": ("Home & Garden", None),
            "200000920": ("Kitchen Storage", "15"),
        },
    )


def ae_fields(**kw: object) -> dict:
    o = offer(AE, **kw)  # type: ignore[arg-type]
    fields: dict = {
        "@id": o["id"],
        "name": o["name"],
        "url": o["url"],
        "price": o["price"],
        "currencyId": o["currencyId"],
        "categoryId": o["categoryId"],
        "picture": o["pictures"],
        "param": o["params"],
    }
    if o["oldprice"]:
        fields["oldprice"] = o["oldprice"]
    return fields


def test_aliexpress_kanonik_adres_ve_affiliate_baglanti_ayri() -> None:
    result = norm(ae_fields())
    assert result.url == f"https://www.aliexpress.com/item/{AE}.html"
    assert result.affiliate_url is not None and result.affiliate_url.startswith(
        "https://rzekl.com/g/"
    )
    assert result.seller_external_id == "1105855203"
    assert (result.price_minor, result.old_price_minor, result.currency) == (2211, 3000, "USD")
    assert result.category_path == "Home & Garden > Kitchen Storage"
    assert result.attributes == {"discount": "26%", "commissionRate": "5.38%"}


def test_kaynakta_olmayan_bilgi_uydurulmaz() -> None:
    result = norm(ae_fields())
    assert result.gtin is None and result.brand is None and result.mpn is None
    # YML'de 'available' yoksa varsayilan: satista (YML kurali), ayri stok iddiasi yok.
    assert result.in_stock is True


def test_affiliate_parametresi_degisirse_urun_degismis_sayilmaz() -> None:
    a = norm(ae_fields())
    fields = ae_fields()
    fields["url"] = tracking_url(AE, f_id="99999")
    b = norm(fields)
    assert a.affiliate_url != b.affiliate_url
    assert a.fingerprint() == b.fingerprint()
    fields["price"] = "22.12"
    assert norm(fields).fingerprint() != a.fingerprint()


@pytest.mark.parametrize(
    ("change", "code"),
    [
        ({"url": "https://rzekl.com/g/x/?i=5"}, "url_unresolved"),
        (
            {"url": tracking_url(AE).replace("www.aliexpress.com", "www.evil.test")},
            "url_host_not_allowed",
        ),
        ({"price": "0"}, "price_invalid"),
        ({"price": "abc"}, "price_invalid"),
        ({"currency": "EUR"}, "currency_mismatch"),
    ],
)
def test_gecersiz_kayitlar_reddedilir(change: dict, code: str) -> None:
    fields = ae_fields()
    if "currency" in change:
        fields["currencyId"] = change["currency"]
    else:
        fields.update(change)
    with pytest.raises(Rejected) as error:
        norm(fields)
    assert error.value.code == code


def test_eski_fiyat_yeni_fiyattan_buyuk_degilse_atilir_ve_kurus_hassasiyeti() -> None:
    assert norm(ae_fields(oldprice="22.11")).old_price_minor is None
    assert parse_price("1,234.565") == 123457
    assert parse_price("10,5", decimal_separator=",") == 1050
    with pytest.raises(Rejected):
        parse_price("-1")


def test_unwrap_url() -> None:
    assert unwrap_url(tracking_url(AE), ["ulp", "dl_target_url"]) == (
        f"https://www.aliexpress.com/item/{AE}.html"
    )
    assert unwrap_url("https://x.test/?a=1", ["ulp"]) is None


def test_csv_yapilandirma_eslemesiyle(tmp_path: Path) -> None:
    from feeds.parsers import FeedRecord

    config = {
        "mapping": {
            "id": "sku",
            "title": "baslik",
            "url": "link",
            "price": "fiyat",
            "currency": "pb",
        },
        "value_formats": {"decimal_separator": ","},
    }
    rec = FeedRecord(
        {"sku": "A1", "baslik": "T", "link": "https://m.test/a1", "fiyat": "1.299,90", "pb": "TRY"},
        0,
        "r",
    )
    result = normalize(rec, config, expected_currency="TRY")
    assert (result.external_id, result.price_minor, result.affiliate_url) == ("A1", 129990, None)


def test_erken_birakilan_ayristirma_dosyayi_kapatir(tmp_path: Path) -> None:
    """Ornek kipi: uretec sonuna kadar tuketilmez; dosya silinebilmeli (Windows dahil)."""
    for name, gz in (("a.xml", False), ("b.gz", True)):
        path = write(tmp_path / name, yml(offer(str(10**15 + i)) for i in range(50)), gz=gz)
        source = iter_records(path, "yml", {}, ParseResult())
        next(source)
        source.close()
        path.unlink()
        assert not path.exists()


def test_bozuk_tek_kayit_dosyayi_durdurmaz(tmp_path: Path) -> None:
    """Gercek beslemedeki gibi: ortada gecersiz karakterli bir kayit (karar 0114)."""
    good = yml([offer(str(10**15 + i)) for i in range(5)])
    head, _, tail = good.partition(b"</offer>")
    # Kacissiz "&": gercekten bozuk kayit (kurtarilamaz) -> hata kaydi.
    bad_offer = f'<offer id="{10**15 + 99}"><name>bozuk & metin</name></offer>'.encode()
    path = tmp_path / "f.xml"
    path.write_bytes(head + b"</offer>" + bad_offer + tail)
    recs, result = records(path)
    assert result.complete
    assert len(recs) == 6
    malformed = [r for r in recs if "__malformed__" in r.fields]
    assert len(malformed) == 1 and malformed[0].fields["@id"] == str(10**15 + 99)
    with pytest.raises(Rejected) as error:
        norm(malformed[0].fields)
    assert error.value.code == "malformed_xml"
    # Digerleri normal.
    assert sum(1 for r in recs if "__malformed__" not in r.fields) == 5


def test_blok_siniri_kayit_ortasina_dusse_de_kayit_kaybolmaz(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import feeds.parsers as parsers

    data = yml(offer(str(10**15 + i)) for i in range(300))
    path = write(tmp_path / "f.xml", data)
    for block in (7, 64, 97, 1000, 4096):
        monkeypatch.setattr(parsers, "_BLOCK", block)
        recs, result = records(path)
        assert result.complete and len(recs) == 300, block
        assert len({r.fields["@id"] for r in recs}) == 300


def test_gecersiz_kontrol_karakteri_kaydi_kurtarilir(tmp_path: Path) -> None:
    """Gercek beslemedeki "Reflective E\x1eBike": kayit kaybolmaz, karakter bosluk olur."""
    data = yml([offer(AE, title="Reflective E\x1eBike Scooter")])
    path = write(tmp_path / "f.xml", data)
    recs, result = records(path)
    assert result.complete and len(recs) == 1
    assert recs[0].fields["name"] == "Reflective E Bike Scooter"


def test_gercek_dosya_bicimi_girintili_kapanis_tamam_sayilir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Gercek AliExpress dosyasi girintili/satir sonlu biter; tam kosu kesik sayilmamali."""
    import feeds.parsers as parsers

    body = yml(offer(str(10**15 + i)) for i in range(120)).replace(b"</offers>", b"\n")
    body = body.replace(b"</shop></yml_catalog>", b"")
    real_tail = b"            </offer>\n        </offers>\n    </shop>\n</yml_catalog>\n\n"
    data = body.rstrip(b"\n") + b"\n" + real_tail.replace(b"            </offer>\n", b"")
    path = write(tmp_path / "f.xml", data)
    for block in (5, 16, 33, 64, 4096, 1 << 16):
        monkeypatch.setattr(parsers, "_BLOCK", block)
        recs, result = records(path)
        assert result.complete, (block, result.error)
        assert len(recs) == 120


def test_gercek_kaynak_kesigi_gzip_saglam_xml_yarim_kesik_sayilir(tmp_path: Path) -> None:
    """14-15 Ekim 2026 olcumu: Admitad dosyasi gzip'i GECERLI kapatip XML'i bir
    <picture> etiketinin ortasinda bitiriyor (</offers> ve </yml_catalog> yok).
    Tam kabul yalnizca kapanis etiketiyle: bu dosya kesik sayilmali, yarim son kayit
    uretilmemeli, onceki kayitlar islenmeli."""
    full = yml(offer(str(10**15 + i)) for i in range(50))
    cut = full.index(b"<picture>", len(full) - 900) + len(
        b"<picture>https://ae-pic-a1.aliexpress-media.com/kf/S44e6"
    )
    path = write(tmp_path / "f.gz", full[:cut], gz=True)  # gzip GECERLI kapanir
    recs, result = records(path)
    assert not result.complete
    assert result.error and "kapanis etiketi" in result.error
    assert len(recs) == 49  # yarim son kayit uretilmez
