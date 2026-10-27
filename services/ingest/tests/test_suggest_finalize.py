"""Iki asamali kategori sonucu (karar 0157): SAF karar kurallari, esleme dosyasi butunlugu, parca
parca yeniden baslatilabilir dosya ciktisi. Veritabani ve model yok."""

from __future__ import annotations

import csv
import json
import sqlite3
from pathlib import Path

import pytest

from classify.categories import is_within
from classify.dynamic import bridge
from classify.suggest.finalize import (
    MAP_FILE,
    SourceParent,
    decide_final,
    finalize,
    load_source_map,
)
from classify.text import path_norm

ROOT = Path(__file__).resolve().parents[3]
PLAN = ROOT / "docs" / "reference" / "trendyol" / "category-tree-map.csv"

HIGH = SourceParent("A > B", "yuksek", "giyim/ust-giyim", None, "test")
OPEN = SourceParent("A > C", "inceleme", None, "ev-mobilya/ev", "test")
NONE = SourceParent("A > D", "eslesmedi", None, None, "test")


def _sugg(status: str, path: str, *, penalty: bool = False, cid: int = 7) -> dict:
    why = "yol: x | ceza: parca_basligi_cihaz_dugumu" if penalty else "yol: x"
    return {"status": status, "candidates": [{"category_id": cid, "path": path, "rationale": why}]}


def _final(parent, suggestion, *, v5=None, current=None):
    return decide_final(current_path=current, parent=parent, suggestion=suggestion, v5_basis=v5)


def test_mevcut_kategori_korunur() -> None:
    f = _final(HIGH, _sugg("guclu", "giyim/ust-giyim/bluz"), current="moda/kadin-giyim")
    assert (f.category_path, f.level, f.basis) == ("moda/kadin-giyim", "korunan", "mevcut_kategori")


def test_guvenilir_ust_icinde_guclu_ve_orta_alt_kategori_olur() -> None:
    for status in ("guclu", "orta"):
        f = _final(HIGH, _sugg(status, "giyim/ust-giyim/bluz"))
        assert (f.category_path, f.level, f.basis) == (
            "giyim/ust-giyim/bluz",
            "alt",
            f"hibrit_{status}",
        )
        assert f.category_id == 7


def test_aday_ustle_ayniysa_seviye_ust() -> None:
    assert _final(HIGH, _sugg("guclu", "giyim/ust-giyim")).level == "ust"


def test_kanit_yetersizse_guvenilir_ustte_kalir() -> None:
    f = _final(HIGH, _sugg("inceleme", "giyim/ust-giyim/bluz"))
    assert (f.category_path, f.level, f.basis) == (
        "giyim/ust-giyim",
        "ust",
        "kaynak_ust:hibrit_inceleme",
    )
    f = _final(HIGH, None)
    assert (f.level, f.basis) == ("ust", "kaynak_ust:hibrit_aday_yok")


def test_cihaz_parca_cezali_aday_alt_kategori_olmaz() -> None:
    f = _final(HIGH, _sugg("guclu", "giyim/ust-giyim/bluz", penalty=True))
    assert (f.category_path, f.level, f.basis) == (
        "giyim/ust-giyim",
        "ust",
        "kaynak_ust:aday_tur_cezali",
    )


def test_aday_guvenilir_ust_disindaysa_zorla_yerlestirilmez() -> None:
    f = _final(HIGH, _sugg("guclu", "ayakkabi/sneaker"))
    assert (f.category_path, f.level, f.basis) == (None, "belirsiz", "aday_kaynak_ustu_disinda")


def test_belirsiz_kaynakta_yalniz_guclu_kabul_edilir() -> None:
    assert _final(OPEN, _sugg("guclu", "ev-mobilya/ev/vazo")).level == "alt"
    f = _final(OPEN, _sugg("orta", "ev-mobilya/ev/vazo"))
    assert (f.category_path, f.level, f.basis) == (None, "belirsiz", "kaynak_belirsiz_aday_orta")
    f = _final(OPEN, _sugg("inceleme", "ev-mobilya/ev/vazo"))
    assert (f.category_path, f.basis) == (None, "kaynak_belirsiz_kanit_yetersiz")


def test_v5_celiskisinde_ust_kategoriye_dusulmez() -> None:
    f = _final(HIGH, _sugg("inceleme", "giyim/ust-giyim/bluz"), v5="conflict")
    assert (f.category_path, f.level, f.basis) == (None, "belirsiz", "baslik_kaynak_celiskisi")
    f = _final(HIGH, _sugg("orta", "giyim/ust-giyim/bluz"), v5="conflict")
    assert (f.category_path, f.basis) == (None, "baslik_kaynak_celiskisi")
    f = _final(HIGH, _sugg("guclu", "giyim/ust-giyim/bluz"), v5="conflict")
    assert (f.level, f.basis) == ("alt", "hibrit_guclu_v5_celiskili")


def test_eslesmeyen_ve_bilinmeyen_kaynak_belirsiz() -> None:
    assert _final(NONE, _sugg("guclu", "x/y")).basis == "kaynak_eslesmedi"
    assert _final(None, _sugg("guclu", "x/y")).basis == "kaynak_eslemesi_yok"


def test_esleme_dosyasi_kopruyle_ayni_kume_ve_agacta() -> None:
    smap = load_source_map()
    table = bridge()
    assert set(smap) == set(table)  # 275 kaynak yolunun hicbiri atlanmaz
    raw = [ln for ln in MAP_FILE.read_text(encoding="utf-8").splitlines() if ln and ln[0] != "#"]
    assert len(raw) == len(smap)
    plan = {r["manicepte_path"] for r in csv.DictReader(PLAN.open(encoding="utf-8"))}
    for key, p in smap.items():
        assert p.rationale, p.source
        for path in (p.path, p.hint):
            assert path is None or path in plan, (p.source, path)
        if p.state == "yuksek":
            # Motorun adaylari kaynak bolgeleriyle sinirli: her bolge guvenilir ustun ICINDE olmali,
            # boylece kabul edilen alt kategori asla ustun disina cikmaz.
            for region in table[key]:
                assert is_within(region, p.path), (p.source, region, p.path)


def _setup(tmp: Path, last_id: int, n_lines: int) -> dict:
    run = tmp / "run"
    run.mkdir()
    lines = [
        json.dumps({"product_id": i, "v": "m|t|1", **_sugg("guclu", "giyim/ust-giyim/bluz")}) + "\n"
        for i in range(1, n_lines + 1)
    ]
    data = "".join(lines).encode()
    (run / "suggestions.jsonl").write_bytes(data + b'{"product_id": 99, "yarim')
    db = sqlite3.connect(run / "state.sqlite")
    db.execute("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
    db.executemany(
        "INSERT INTO meta VALUES (?, ?)", [("last_id", str(last_id)), ("out_bytes", str(len(data)))]
    )
    db.commit()
    db.close()
    items = tmp / "items.tsv"
    items.write_text(
        "".join(f"{i}\tbaslik {i}\t{'A > B' if i % 2 else 'A > D'}\n" for i in range(1, 7)),
        encoding="utf-8",
    )
    cats = tmp / "cat.csv"
    cats.write_text(
        "id,path,name,parent_id\n1,giyim,Giyim,\n2,giyim/ust-giyim,Üst Giyim,1\n"
        "3,giyim/ust-giyim/bluz,Bluz,2\n",
        encoding="utf-8",
    )
    smap = tmp / "map.tsv"
    smap.write_text(
        "# test\nA > B\tyuksek\tgiyim/ust-giyim\t\tt\nA > D\teslesmedi\t\t\tt\n", encoding="utf-8"
    )
    return {
        "run_dir": run,
        "items_tsv": items,
        "categories_csv": cats,
        "source_map": smap,
        "shard": 2,
        "v5": False,
    }


def _rows(dest: Path) -> list[dict]:
    out = []
    for part in sorted(dest.glob("parca_*.tsv")):
        out += list(csv.DictReader(part.open(encoding="utf-8"), delimiter="\t"))
    return out


def test_kontrol_noktasini_asan_parca_yazilmaz_ve_devam_eder(tmp_path: Path) -> None:
    kw = _setup(tmp_path, last_id=3, n_lines=3)
    dest = tmp_path / "out"
    r = finalize(dest=dest, **kw)
    # 6 urun / parca 2: hibrit 3'te; parca 0 (1-2) yazilir, parca 1 (3-4) bitmedigi icin yazilmaz.
    assert (r["durum"], r["islenen_urun"], r["tamamlanan_parca"]) == ("suruyor", 2, 1)
    assert [x["product_id"] for x in _rows(dest)] == ["1", "2"]
    first = (dest / "parca_00000.tsv").read_bytes()

    # Hibrit koşu tamamlandi: ayni hedefle devam biten parcayi DEGISTIRMEZ, kalanlari yazar.
    run = kw["run_dir"]
    lines = [
        json.dumps({"product_id": i, "v": "m|t|1", **_sugg("orta", "giyim/ust-giyim/bluz")}) + "\n"
        for i in range(1, 7)
    ]
    data = "".join(lines).encode()
    (run / "suggestions.jsonl").write_bytes(data)
    db = sqlite3.connect(run / "state.sqlite")
    db.execute("UPDATE meta SET v = ? WHERE k = 'last_id'", ("6",))
    db.execute("UPDATE meta SET v = ? WHERE k = 'out_bytes'", (str(len(data)),))
    db.commit()
    db.close()
    r = finalize(dest=dest, **kw)
    assert (r["durum"], r["islenen_urun"], r["tamamlanan_parca"]) == ("bitti", 6, 3)
    assert (dest / "parca_00000.tsv").read_bytes() == first
    rows = _rows(dest)
    assert [x["product_id"] for x in rows] == [str(i) for i in range(1, 7)]
    by = {x["product_id"]: x for x in rows}
    assert (by["1"]["seviye"], by["1"]["category_id"]) == ("alt", "3")
    assert (by["2"]["seviye"], by["2"]["karar_kaynagi"]) == ("belirsiz", "kaynak_eslesmedi")
    assert by["3"]["category_name_path"] == "Giyim > Üst Giyim > Bluz"
    table = list(csv.DictReader((dest / "kaynak_eslesme.csv").open(encoding="utf-8")))
    assert {(t["kaynak_yolu"], t["urun_sayisi"], t["kategori_id"]) for t in table} == {
        ("A > B", "3", "2"),
        ("A > D", "3", ""),
    }
    assert all(t["dogrulama"].startswith("AI onerisi") for t in table)


def test_esleme_degisince_ayni_hedefle_devam_reddedilir(tmp_path: Path) -> None:
    kw = _setup(tmp_path, last_id=6, n_lines=6)
    dest = tmp_path / "out"
    finalize(dest=dest, **kw)
    kw["source_map"].write_text(
        "A > B\tyuksek\tgiyim\t\tt\nA > D\teslesmedi\t\t\tt\n", encoding="utf-8"
    )
    with pytest.raises(SystemExit):
        finalize(dest=dest, **kw)


def test_agacta_olmayan_esleme_yolu_reddedilir(tmp_path: Path) -> None:
    kw = _setup(tmp_path, last_id=6, n_lines=6)
    kw["source_map"].write_text("A > B\tyuksek\tyok/boyle\t\tt\n", encoding="utf-8")
    with pytest.raises(ValueError):
        finalize(dest=tmp_path / "out", **kw)


def test_gecersiz_esleme_satiri_reddedilir(tmp_path: Path) -> None:
    bad = tmp_path / "m.tsv"
    bad.write_text("A > B\tyuksek\t\t\tustsuz yuksek\n", encoding="utf-8")
    with pytest.raises(ValueError):
        load_source_map(bad)
    bad.write_text("A > B\teslesmedi\t\t\tt\nA  >  B\teslesmedi\t\t\tt\n", encoding="utf-8")
    assert path_norm("A  >  B") == path_norm("A > B")
    with pytest.raises(ValueError):
        load_source_map(bad)
