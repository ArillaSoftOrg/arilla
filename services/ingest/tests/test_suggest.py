"""Hibrit kategori oneri motoru (karar 0155): SAF birim testleri (veritabani ve model yok).

Gomme yerine kavram tabanli sahte `Embedder` kullanilir: Turkce kategori adi ile Ingilizce baslik
ayni kavram boyutuna duser. Kapsam: agac surumu/onbellek gecersizlesmesi, bolge siniri, aday
sayisi ve bagimsizligi, kural+anlamsal uyum, cezalar, kontrol noktasi/devam/kirpma, surum
uyusmazligi, tekrar onbellegi, disa aktarim, model manifest dogrulamasi.
"""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from test_classify_dynamic import (
    CATEGORIES,
    PENS,
    SCOPES,
    WOMEN_JUMPSUIT,
)

from classify.dynamic import DynamicIndex
from classify.suggest import model as model_mod
from classify.suggest.batch import Row, RunMismatch, Runner, export, tsv_batches
from classify.suggest.engine import (
    SUGGEST_VERSION,
    CategoryRow,
    Item,
    Suggester,
    TreeIndex,
    tree_version,
)
from classify.text import fold

CONCEPTS = {
    "tulum": 0, "jumpsuit": 0, "romper": 0,
    "pijama": 1, "pajama": 1,
    "kalem": 2, "pen": 2, "ink": 2, "jel": 2,
    "telefon": 3, "phone": 3,
    "bluz": 4, "blouse": 4,
    "giyim": 5, "women": 5,
}  # fmt: skip


class FakeEmbedder:
    """Kavram sayimi + cok kucuk belirlenimli gurultu; L2 normlu."""

    model_version = "fake-1"

    def __init__(self, version: str = "fake-1") -> None:
        self.model_version = version

    def encode(self, texts):  # noqa: ANN001, ANN201
        out = np.zeros((len(texts), 24), dtype=np.float32)
        for row, text in enumerate(texts):
            for token in fold(text.replace(">", " ")).split():
                for key, dim in CONCEPTS.items():
                    if token.startswith(key):
                        out[row, dim] += 1.0
            noise = hashlib.sha256(text.encode()).digest()
            out[row, 8:] += np.frombuffer(noise[:16], dtype=np.uint8).astype(np.float32)[:16] * 1e-4
            out[row] /= max(float(np.linalg.norm(out[row])), 1e-9)
        return out


ROWS = [CategoryRow(i + 1, path, name) for i, (path, name) in enumerate(CATEGORIES)]
CALIB = [
    "Women Jumpsuit Casual",
    "Pajama Set Soft",
    "Gel Ink Pen Black",
    "Phone Stand Holder",
    "Women Blouse Summer",
    "Kitchen Tool Random",
    "Premium Quality Item",
    "Home Decor Piece",
]


def make_suggester(**kwargs) -> Suggester:  # noqa: ANN003
    emb = FakeEmbedder()
    index = TreeIndex.build(ROWS, emb)
    index.calibrate(emb.encode(CALIB))
    return Suggester(index, DynamicIndex(CATEGORIES, SCOPES), emb, **kwargs)


def test_agac_surumu_sira_bagimsiz_ve_degisimde_degisir() -> None:
    assert tree_version(ROWS) == tree_version(list(reversed(ROWS)))
    changed = [*ROWS[:-1], CategoryRow(ROWS[-1].id, ROWS[-1].path, ROWS[-1].name + " X")]
    assert tree_version(changed) != tree_version(ROWS)


def test_indeks_onbellegi_model_agac_ve_kural_surumune_baglidir(tmp_path: Path) -> None:
    emb = FakeEmbedder()
    index = TreeIndex.build(ROWS, emb)
    index.calibrate(emb.encode(CALIB))
    path = tmp_path / "index.npz"
    index.save(path)
    tv = tree_version(ROWS)
    loaded = TreeIndex.load(path, model_version="fake-1", tree_ver=tv)
    assert loaded is not None and loaded.mean is not None
    assert np.allclose(loaded.ep, index.ep) and loaded.paths == index.paths
    assert TreeIndex.load(path, model_version="fake-2", tree_ver=tv) is None
    assert TreeIndex.load(path, model_version="fake-1", tree_ver="x" * 16) is None
    assert SUGGEST_VERSION >= 1


def test_kalibre_edilmemis_indeks_reddedilir() -> None:
    emb = FakeEmbedder()
    index = TreeIndex.build(ROWS, emb)
    with pytest.raises(ValueError):
        Suggester(index, DynamicIndex(CATEGORIES, SCOPES), emb)


def test_kaynak_bolgesi_yoksa_aday_uretilmez_inceleme() -> None:
    sug = make_suggester().suggest([Item("Women Jumpsuit", "Special Category > Test")])[0]
    assert (sug.status, sug.reason, sug.candidates) == ("inceleme", "kaynak_bolgesi_yok", ())
    assert make_suggester().suggest([Item("Women Jumpsuit", None)])[0].status == "inceleme"


def test_adaylar_bolgeyle_sinirli_en_fazla_uc_ve_birbirinden_bagimsiz() -> None:
    sug = make_suggester().suggest([Item("Women Pajama Jumpsuit Blouse Set", WOMEN_JUMPSUIT)])[0]
    assert 1 <= len(sug.candidates) <= 3
    paths = [c.path for c in sug.candidates]
    assert all(p == "giyim" or p.startswith("giyim/") for p in paths)
    for i, a in enumerate(paths):
        for b in paths[i + 1 :]:
            assert not (a == b or a.startswith(b + "/") or b.startswith(a + "/"))
    assert all(c.rationale and c.name_path for c in sug.candidates)


def test_kural_eslesmesi_once_gelir_anlamsalla_ayni_dalda_ise_guclu() -> None:
    sug = make_suggester().suggest(
        [Item("Women Jumpsuit with Large Fur Collar Long Sleeve", WOMEN_JUMPSUIT)]
    )[0]
    first = sug.candidates[0]
    assert first.path == "giyim/salopet-tulum/tulum"
    assert first.source == "ikisi" and "kural:" in first.rationale
    assert sug.status == "guclu"
    # Kural kapatilinca ayni urun yalniz anlamsal kanitla gelir ve `guclu` olamaz.
    ablation = make_suggester(use_dynamic=False).suggest(
        [Item("Women Jumpsuit with Large Fur Collar Long Sleeve", WOMEN_JUMPSUIT)]
    )[0]
    assert ablation.status != "guclu"
    assert all(c.source == "embedding" for c in ablation.candidates)


def test_yeterli_kanit_yoksa_inceleme_kategori_zorlanmaz() -> None:
    sug = make_suggester().suggest([Item("Premium Quality Item 2024 New Arrival", WOMEN_JUMPSUIT)])[
        0
    ]
    assert sug.status == "inceleme"


def test_parca_basligi_cihaz_dugumune_ceza_ve_gerekce() -> None:
    sug = make_suggester().suggest([Item("Gel Ink Pen Replacement Refill Kit", PENS)])[0]
    notes = " ".join(c.rationale for c in sug.candidates)
    assert "ceza: parca_basligi_cihaz_dugumu" in notes
    off = make_suggester(guards=False).suggest([Item("Gel Ink Pen Replacement Refill Kit", PENS)])[
        0
    ]
    assert "ceza:" not in " ".join(c.rationale for c in off.candidates)


def test_ayni_girdi_ayni_cikti() -> None:
    items = [Item("Women Jumpsuit Long Sleeve", WOMEN_JUMPSUIT), Item("Gel Ink Pen", PENS)]
    a = [s.as_dict() for s in make_suggester().suggest(items)]
    b = [s.as_dict() for s in make_suggester().suggest(items)]
    assert a == b


# -- toplu kosu ----------------------------------------------------------------------------


def write_tsv(path: Path, n: int = 12) -> Path:
    titles = [
        ("Women Jumpsuit with Large Fur Collar Long Sleeve", WOMEN_JUMPSUIT),
        ("Gel Ink Pen Black 0.5mm", PENS),
        ("Premium Quality Item 2024 New Arrival", WOMEN_JUMPSUIT),
    ]
    lines = []
    for i in range(n):
        title, source = titles[i % 3]
        # Ilk uc urun ayni baslik/kaynakla tekrar eder: ayni calismada yeniden hesaplanmaz.
        lines.append(f"{100 + i}\t{title}\t{source}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def make_runner(tmp_path: Path, *, model: str = "fake-1", restart: bool = False) -> Runner:
    return Runner(
        tmp_path / "out",
        make_suggester(),
        model_version=model,
        tree_version=tree_version(ROWS),
        restart=restart,
    )


def lines(tmp_path: Path) -> list[dict]:
    text = (tmp_path / "out" / "suggestions.jsonl").read_text(encoding="utf-8")
    return [json.loads(x) for x in text.splitlines()]


def test_tek_seferde_kosu_her_urunu_bir_kez_yazar_ve_surumleri_kaydeder(tmp_path: Path) -> None:
    tsv = write_tsv(tmp_path / "in.tsv")
    runner = make_runner(tmp_path)
    summary = runner.run(lambda after: tsv_batches(tsv, after_id=after, size=5))
    recs = lines(tmp_path)
    assert [r["product_id"] for r in recs] == list(range(100, 112))
    assert summary["toplam"] == 12 and summary["durum"] == "bitti"
    assert summary["versions"] == {"model": "fake-1", "tree": tree_version(ROWS), "suggest": "1"}
    assert all(r["v"].startswith("fake-1|") and r["current_category_id"] is None for r in recs)
    assert summary["sayaclar"].get("onbellek", 0) >= 6  # tekrar eden baslik/kaynak ciftleri


def test_devam_ayni_sonucu_verir_ve_yarim_partiyi_kirpar(tmp_path: Path) -> None:
    tsv = write_tsv(tmp_path / "in.tsv")
    whole = tmp_path / "whole"
    Runner(whole, make_suggester(), model_version="fake-1", tree_version=tree_version(ROWS)).run(
        lambda a: tsv_batches(tsv, after_id=a, size=4)
    )
    expected = (whole / "suggestions.jsonl").read_text(encoding="utf-8")

    first = make_runner(tmp_path).run(
        lambda a: tsv_batches(tsv, after_id=a, size=4), max_products=5
    )
    assert first["durum"] == "urun_siniri" and first["son_urun_id"] == 104
    # Cokus benzetimi: kontrol noktasindan SONRA yazilmis yarim parti.
    with (tmp_path / "out" / "suggestions.jsonl").open("ab") as f:
        f.write(b'{"product_id": 105, "yarim')
    second = make_runner(tmp_path).run(lambda a: tsv_batches(tsv, after_id=a, size=4))
    assert second["bu_kosuda_urun"] == 7 and second["toplam"] == 12
    assert (tmp_path / "out" / "suggestions.jsonl").read_text(encoding="utf-8") == expected


def test_baska_model_ya_da_agac_surumuyle_devam_reddedilir(tmp_path: Path) -> None:
    tsv = write_tsv(tmp_path / "in.tsv", 4)
    make_runner(tmp_path).run(lambda a: tsv_batches(tsv, after_id=a, size=4))
    with pytest.raises(RunMismatch):
        make_runner(tmp_path, model="fake-2")
    # --restart temiz baslar.
    runner = make_runner(tmp_path, model="fake-2", restart=True)
    assert runner.last_id == 0


def test_sure_sinirinda_durur_ve_kaldigi_yerden_surer(tmp_path: Path) -> None:
    tsv = write_tsv(tmp_path / "in.tsv")
    partial = make_runner(tmp_path).run(
        lambda a: tsv_batches(tsv, after_id=a, size=3), max_seconds=0
    )
    assert partial["durum"] == "sure" and partial["bu_kosuda_urun"] == 0
    done = make_runner(tmp_path).run(lambda a: tsv_batches(tsv, after_id=a, size=3))
    assert done["toplam"] == 12


def test_disa_aktarim_csv_ve_json_urun_basina_son_kayit(tmp_path: Path) -> None:
    tsv = write_tsv(tmp_path / "in.tsv", 6)
    make_runner(tmp_path).run(lambda a: tsv_batches(tsv, after_id=a, size=3))
    out = tmp_path / "out"
    # Ayni urun iki kez yazilmis olsa bile (eski cokus kalintisi) disa aktarim tekillestirir.
    with (out / "suggestions.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({**lines(tmp_path)[0], "status": "inceleme", "reason": "son"}) + "\n")
    assert export(out, tmp_path / "e.csv", "csv", top=3) == 6
    with (tmp_path / "e.csv").open(encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    assert rows[0]["neden"] == "son" and "o3_gerekce" in rows[0] and len(rows) == 6
    assert export(out, tmp_path / "e.json", "json") == 6
    assert len(json.loads((tmp_path / "e.json").read_text(encoding="utf-8"))) == 6


# -- model manifesti -----------------------------------------------------------------------


def fake_model_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "model"
    root.mkdir()
    files = {}
    for name, body in ((model_mod.MODEL_FILE, b"onnx-bytes"), (model_mod.TOKENIZER_FILE, b"{}")):
        (root / name).write_bytes(body)
        files[name] = {"sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}
    monkeypatch.setattr(model_mod, "EXPECTED_SHA256", {n: e["sha256"] for n, e in files.items()})
    manifest = {
        "format": model_mod.MANIFEST_FORMAT,
        "model_version": "e5-small-int8-test",
        "source_repo": model_mod.SOURCE_REPO,
        "source_revision": model_mod.SOURCE_REVISION,
        "files": files,
    }
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def test_manifest_dogru_dizini_kabul_eder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = fake_model_dir(tmp_path, monkeypatch)
    assert model_mod.verify_model_dir(root).model_version == "e5-small-int8-test"


def test_manifest_bozulmus_ya_da_yanlis_kaynagi_reddeder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = fake_model_dir(tmp_path, monkeypatch)
    (root / model_mod.MODEL_FILE).write_bytes(b"tampered")
    with pytest.raises(model_mod.ModelError, match="SHA-256"):
        model_mod.verify_model_dir(root)
    root2 = (
        fake_model_dir(tmp_path / "b", monkeypatch) if (tmp_path / "b").mkdir() is None else root
    )
    manifest = json.loads((root2 / "manifest.json").read_text(encoding="utf-8"))
    manifest["source_revision"] = "0" * 40
    (root2 / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(model_mod.ModelError, match="kaynak"):
        model_mod.verify_model_dir(root2)
    with pytest.raises(model_mod.ModelError, match="manifest.json yok"):
        model_mod.verify_model_dir(tmp_path / "bos")


def test_manifest_ozeti_dosyayla_uyusmuyorsa_reddeder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = fake_model_dir(tmp_path, monkeypatch)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    manifest["files"][model_mod.MODEL_FILE]["sha256"] = "f" * 64
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(model_mod.ModelError, match="manifestteki"):
        model_mod.verify_model_dir(root)


def test_gercek_model_varsa_gommeler_birim_norm_ve_anlamli(tmp_path: Path) -> None:
    """Yerelde `SUGGEST_MODEL_DIR` verilirse calisir; CI'da (model yok) atlanir."""
    import os

    model_dir = os.environ.get("SUGGEST_MODEL_DIR")
    if not model_dir:
        pytest.skip("SUGGEST_MODEL_DIR tanimli degil")
    pytest.importorskip("onnxruntime")
    pytest.importorskip("tokenizers")
    emb = model_mod.OnnxEmbedder(model_dir, threads=2, prefix="query: ")
    vecs = emb.encode(["Phone battery replacement", "Women dress", "Phone battery replacement"])
    assert vecs.shape == (3, model_mod.DIM)
    assert np.allclose(np.linalg.norm(vecs, axis=1), 1.0, atol=1e-4)
    assert np.allclose(vecs[0], vecs[2])  # sira/parti bagimsiz, belirlenimli
    passage = emb.with_prefix("passage: ").encode(["Telefon Bataryası", "Kadın Elbise"])
    sims = vecs[0] @ passage.T
    assert sims[0] > sims[1]


def test_row_varsayilan_mevcut_kategori_yok() -> None:
    assert Row(1, "x", None).current_category_id is None
