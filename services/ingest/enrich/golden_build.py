"""GELISTIRICI ARACI: altin vektorleri RESMI referans uygulamadan uretir (karar 0184).

Uretim imajinda kosmaz; agir bagimliliklar (`.[model-build]`: sentence-transformers, torch) ve
model indirmesi ister. Yalniz yerel gelistirme makinesinde, sabit revizyonla calistirilir:

    python -m enrich.golden_build --model qwen3-embedding-0.6b-97b0c614

Kurallar:
- Model kayit defterindeki `source.repo` + `source.revision` ile indirilir (baska revizyon yok).
- Modelin resmi `1_Pooling` ayari kayit defterindeki `pooling` ile ayni degilse DURUR; altin
  dosya yazilmaz (yanlis kayit, yanlis referans uretmesin).
- Onekler kayit defterinden aynen `prompt` olarak verilir; vektorler L2 normalize edilir.
- `tolerance` her zaman `null` yazilir: esik ancak canli sunucuyla OLCULEREK konur
  (`python -m enrich.canary --measure --record-tolerance ...`). Olculmemis dosya kapiyi acmaz.
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

from enrich.canary import GOLDEN_DIR, GOLDEN_FORMAT, dump_golden, golden_path
from enrich.model_files import verify_snapshot
from enrich.registry import ModelSpec, load_registry

#: Sabit kanarya metinleri. Degistirmek tum altin dosyalarin yeniden uretilmesini gerektirir.
#: Turkce urun metinleri (urun metni v1 bicimi: marka + baslik) ve kisa arama sorgulari; ayirt
#: edicilik denetimi icin birbirinden farkli kategoriler.
PASSAGE_TEXTS = (
    "Philips HD9252/90 Airfryer Essential 4,1 L Siyah Fritöz",
    "Apple iPhone 15 128 GB Siyah Akıllı Telefon",
    "Logitech G305 Lightspeed Kablosuz Oyuncu Mouse",
    "Nike Air Force 1 '07 Beyaz Erkek Spor Ayakkabı",
    "Arçelik 9 kg 1200 Devir Çamaşır Makinesi",
    "La Roche-Posay Effaclar Duo+ 40 ml Krem",
    "Lego Technic 42141 McLaren Formula 1 Yarış Arabası",
    "Tefal Ingenio 10 Parça Granit Tencere Seti",
)
QUERY_TEXTS = (
    "500 TL altı kablolu oyuncu faresi",
    "yağsız kızartma makinesi büyük hazneli",
    "kadın kışlık su geçirmez bot",
    "akne için gece kremi",
)
_POOLING_FROM_ST = {"cls": "cls", "mean": "mean", "lasttoken": "last_token"}


def official_pooling(model) -> str:  # noqa: ANN001 - SentenceTransformer
    from sentence_transformers.models import Pooling

    modes = [m for m in model if isinstance(m, Pooling)]
    if len(modes) != 1:
        raise SystemExit("modelde tek bir Pooling modulu beklenir")
    mode = modes[0].get_pooling_mode_str()
    if mode not in _POOLING_FROM_ST:
        raise SystemExit(f"desteklenmeyen resmi havuzlama: {mode!r}")
    return _POOLING_FROM_ST[mode]


def build(
    spec: ModelSpec,
    out_dir: Path = GOLDEN_DIR,
    device: str = "cpu",
    source_dir: Path | None = None,
) -> Path:
    import importlib.metadata as md

    from sentence_transformers import SentenceTransformer

    repo, revision = spec.source.get("repo"), spec.source.get("revision")
    if not repo or not revision:
        raise SystemExit(f"{spec.id}: kaynak deposu/revizyonu kayit defterinde yok")
    if source_dir is not None:
        # Elle indirilmis dizin: once revizyon + agirlik SHA-256 dogrulanir (TEI'nin okudugu
        # dizinin AYNISI referansa da verilir; iki taraf ayni dosyalari kullanir).
        verify_snapshot(source_dir, str(revision))
        model = SentenceTransformer(str(source_dir), device=device)
    else:
        model = SentenceTransformer(repo, revision=revision, device=device)
    pooling = official_pooling(model)
    if pooling != spec.pooling:
        raise SystemExit(
            f"{spec.id}: resmi havuzlama {pooling!r}, kayit defteri {spec.pooling!r}. Durdu."
        )
    cases = []
    for purpose, texts in (("passage", PASSAGE_TEXTS), ("query", QUERY_TEXTS)):
        prompt = spec.prefix(purpose) or None
        vectors = model.encode(
            list(texts), prompt=prompt, normalize_embeddings=True, convert_to_numpy=True
        )
        if vectors.shape[1] != spec.dimensions:
            raise SystemExit(f"{spec.id}: boyut {vectors.shape[1]} != {spec.dimensions}")
        cases += [
            {"purpose": purpose, "text": t, "vector": [round(float(v), 7) for v in vec]}
            for t, vec in zip(texts, vectors, strict=True)
        ]
    golden = {
        "format": GOLDEN_FORMAT,
        "model_id": spec.id,
        "source": {"repo": repo, "revision": revision},
        "pooling": spec.pooling,
        "dimensions": spec.dimensions,
        "normalization": spec.normalization,
        "preprocessing_version": spec.preprocessing_version,
        "prefixes": dict(spec.prefixes),
        "reference": {
            "implementation": "sentence-transformers",
            "versions": {
                name: md.version(name)
                for name in ("sentence-transformers", "transformers", "torch")
            },
            "device": device,
            "official_pooling": pooling,
            "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        },
        "cases": cases,
        "tolerance": None,
    }
    path = golden_path(spec.id, out_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dump_golden(golden), encoding="utf-8", newline="\n")
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m enrich.golden_build")
    parser.add_argument("--model", required=True)
    parser.add_argument("--out-dir", type=Path, default=GOLDEN_DIR)
    parser.add_argument(
        "--source-dir", type=Path, help="hf download --revision ile indirilmis yerel dizin"
    )
    args = parser.parse_args(argv)
    spec = load_registry().get(args.model)
    if not spec.self_hosted:
        print(f"{spec.id}: API modeli; altin vektor gerekmez", file=sys.stderr)
        return 2
    print(f"yazildi: {build(spec, args.out_dir, source_dir=args.source_dir)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
