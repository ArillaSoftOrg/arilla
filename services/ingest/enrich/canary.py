"""Altin vektor kanaryasi: kendi calistirdigimiz modelin GERCEK ciktisini dogrular (karar 0184).

Sorun: yanlis havuzlama, yanlis revizyon, eksik onek ya da yanlis TEI ayari yine dogru boyutta
birim vektor uretir; `validate_batch` (sayi/boyut/sonluluk/norm) bunu yakalayamaz. Vektor uzayi
sessizce bozulur.

Cozum: `enrich/golden/<model_id>.json`, modelin RESMI referans uygulamasiyla (sabit revizyon,
sentence-transformers; `enrich.golden_build`) uretilmis sabit metinlerin vektorlerini tutar.
Yazmadan once ayni metinler canli saglayiciyla gomulur ve kosinusle karsilastirilir.

Fail-closed kurallari (hepsi `CanaryFailed`):
- Altin dosya yok, bozuk ya da kayit defteriyle uyusmuyor (kimlik, kaynak revizyonu, havuzlama,
  boyut, normalizasyon, on isleme surumu, onekler).
- Tolerans OLCULMEDI (`tolerance: null`) ya da olcum kaniti yok: esik tahminle konmaz.
- Herhangi bir metnin kosinusu esigin altinda ya da bir cikti kendi altin vektorune degil baska
  bir metninkine en yakin (sira/karisma hatasi).
- Saglayici hata verir.

Jina (API) modelleri kapsam disidir: havuzlama saglayicidadir ve mevcut davranis degismez.
Bu modul ag/DB'ye kendisi baglanmaz; saglayiciyi cagiran verir.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from enrich.registry import PURPOSES, ModelSpec, RegistryError, load_registry

GOLDEN_DIR = Path(__file__).with_name("golden")
GOLDEN_FORMAT = 1
#: Olcumden esik turetilirken birakilan pay ve esigin alabilecegi en dusuk deger. Bunun altinda
#: bir esik "ayni uzay" iddiasini tasimaz (yanlis havuzlama tipik olarak 0.3-0.9 verir).
MIN_ALLOWED_THRESHOLD = 0.99
_GOLDEN_FIELDS = frozenset(
    {
        "format",
        "model_id",
        "source",
        "pooling",
        "dimensions",
        "normalization",
        "preprocessing_version",
        "prefixes",
        "reference",
        "cases",
        "tolerance",
    }
)


class CanaryFailed(RuntimeError):
    """Model ciktisi dogrulanamadi; gercek embedding yazilmaz."""


@dataclass(frozen=True)
class GoldenCase:
    purpose: str
    text: str
    vector: tuple[float, ...]


@dataclass(frozen=True)
class Golden:
    model_id: str
    source: Mapping[str, Any]
    pooling: str
    dimensions: int
    normalization: str
    preprocessing_version: str
    prefixes: Mapping[str, str]
    reference: Mapping[str, Any]
    cases: tuple[GoldenCase, ...]
    #: None: henuz olculmedi -> kanarya her zaman basarisiz.
    tolerance: Mapping[str, Any] | None


@dataclass
class CanaryResult:
    model_id: str
    threshold: float | None
    cosines: list[tuple[str, str, float]] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.problems and bool(self.cosines)

    @property
    def min_cosine(self) -> float | None:
        return min((c for _, _, c in self.cosines), default=None)

    def summary(self) -> str:
        low = self.min_cosine
        low_text = f"{low:.6f}" if low is not None else "-"
        if self.threshold is None:
            state = "OLCUM (esik uygulanmadi; gecti/kaldi DEGIL)"
        else:
            state = "GECTI" if self.passed else "BASARISIZ"
        lines = [
            f"kanarya {self.model_id}: {state} (en dusuk kosinus {low_text}, esik "
            f"{self.threshold if self.threshold is not None else 'olculmedi'})"
        ]
        lines += [f"  - {p}" for p in self.problems]
        return "\n".join(lines)


def golden_path(model_id: str, directory: Path = GOLDEN_DIR) -> Path:
    return directory / f"{model_id}.json"


def _vector(where: str, raw: Any, dimensions: int) -> tuple[float, ...]:
    if not isinstance(raw, list) or len(raw) != dimensions:
        raise CanaryFailed(f"{where}: {dimensions} boyutlu vektor olmali")
    values = tuple(float(v) for v in raw)
    if not all(math.isfinite(v) for v in values):
        raise CanaryFailed(f"{where}: sonlu olmayan deger")
    return values


def parse_golden(raw: Any) -> Golden:
    if not isinstance(raw, dict) or set(raw) != _GOLDEN_FIELDS:
        raise CanaryFailed("altin dosya alanlari beklenenle ayni degil")
    if raw["format"] != GOLDEN_FORMAT:
        raise CanaryFailed(f"altin dosya bicimi desteklenmiyor: {raw['format']!r}")
    dimensions = raw["dimensions"]
    if not isinstance(dimensions, int) or dimensions < 1:
        raise CanaryFailed("dimensions gecersiz")
    cases = []
    for i, case in enumerate(raw["cases"] or []):
        where = f"cases[{i}]"
        if not isinstance(case, dict) or case.get("purpose") not in PURPOSES:
            raise CanaryFailed(f"{where}: purpose passage|query olmali")
        if not isinstance(case.get("text"), str) or not case["text"].strip():
            raise CanaryFailed(f"{where}: metin bos")
        cases.append(
            GoldenCase(
                case["purpose"], case["text"], _vector(where, case.get("vector"), dimensions)
            )
        )
    if len(cases) < 2:
        raise CanaryFailed("en az iki altin metin gerekli (ayirt edicilik denetimi icin)")
    tolerance = raw["tolerance"]
    if tolerance is not None and not isinstance(tolerance, dict):
        raise CanaryFailed("tolerance nesne ya da null olmali")
    return Golden(
        model_id=str(raw["model_id"]),
        source=dict(raw["source"] or {}),
        pooling=str(raw["pooling"]),
        dimensions=dimensions,
        normalization=str(raw["normalization"]),
        preprocessing_version=str(raw["preprocessing_version"]),
        prefixes=dict(raw["prefixes"] or {}),
        reference=dict(raw["reference"] or {}),
        cases=tuple(cases),
        tolerance=tolerance,
    )


def load_golden(model_id: str, directory: Path = GOLDEN_DIR) -> Golden:
    path = golden_path(model_id, directory)
    if not path.is_file():
        raise CanaryFailed(
            f"{model_id}: altin vektor dosyasi yok ({path.name}); "
            "`python -m enrich.golden_build` ile resmi referanstan uretilmeli"
        )
    try:
        return parse_golden(json.loads(path.read_text(encoding="utf-8")))
    except json.JSONDecodeError as error:
        raise CanaryFailed(f"{path.name}: bozuk JSON ({error})") from error


def metadata_problems(spec: ModelSpec, golden: Golden) -> list[str]:
    """Altin dosya bu kayit girdisi icin mi uretildi? Her uyusmazlik ayri satir."""
    problems = []
    expected = {
        "model_id": (golden.model_id, spec.id),
        "kaynak deposu": (golden.source.get("repo"), spec.source.get("repo")),
        "kaynak revizyonu": (golden.source.get("revision"), spec.source.get("revision")),
        "havuzlama": (golden.pooling, spec.pooling),
        "boyut": (golden.dimensions, spec.dimensions),
        "normalizasyon": (golden.normalization, spec.normalization),
        "on isleme": (golden.preprocessing_version, spec.preprocessing_version),
        "onekler": (dict(golden.prefixes), dict(spec.prefixes)),
    }
    for name, (have, want) in expected.items():
        if have != want:
            problems.append(f"{name}: altin dosya {have!r}, kayit defteri {want!r}")
    return problems


def threshold_of(golden: Golden) -> float:
    """Olculmus esik; olculmediyse ya da kanitsizsa `CanaryFailed` (tahmini esik yok)."""
    tol = golden.tolerance
    if tol is None:
        raise CanaryFailed(
            f"{golden.model_id}: tolerans henuz OLCULMEDI; "
            "`python -m enrich.canary --measure` sonucu kanitiyla yazilmadan yazma yapilamaz"
        )
    value, evidence = tol.get("min_cosine"), tol.get("evidence")
    if not isinstance(value, int | float) or not MIN_ALLOWED_THRESHOLD <= value <= 1.0:
        raise CanaryFailed(
            f"{golden.model_id}: min_cosine [{MIN_ALLOWED_THRESHOLD}, 1] araliginda olmali"
        )
    if not isinstance(evidence, dict) or not evidence.get("observed_min_cosine"):
        raise CanaryFailed(f"{golden.model_id}: tolerans olcum kaniti (evidence) eksik")
    return float(value)


def dump_golden(raw: Mapping[str, Any]) -> str:
    """Okunur ve kararli bicim: ust alanlar girintili, her vaka (vektoruyle) tek satir."""
    head = {k: v for k, v in raw.items() if k != "cases"}
    text = json.dumps(head, ensure_ascii=False, indent=1)
    cases = ",\n".join("  " + json.dumps(c, ensure_ascii=False) for c in raw["cases"])
    return text[:-2] + ',\n "cases": [\n' + cases + "\n ]\n}\n"


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


ProviderFactory = Callable[[str], Any]


def compare(
    spec: ModelSpec, golden: Golden, factory: ProviderFactory, *, threshold: float | None
) -> CanaryResult:
    """Canli ciktiyi altin vektorlerle karsilastirir; esik None ise yalniz olcer (--measure)."""
    result = CanaryResult(model_id=spec.id, threshold=threshold)
    result.problems.extend(metadata_problems(spec, golden))
    if result.problems:
        return result
    for purpose in sorted({c.purpose for c in golden.cases}):
        cases = [c for c in golden.cases if c.purpose == purpose]
        try:
            batch = factory(purpose).embed_texts([c.text for c in cases])
        except Exception as error:  # noqa: BLE001 - her saglayici hatasi fail-closed
            result.problems.append(f"{purpose}: saglayici hatasi {type(error).__name__}: {error}")
            continue
        if len(batch.vectors) != len(cases):
            result.problems.append(f"{purpose}: {len(cases)} metin, {len(batch.vectors)} vektor")
            continue
        for case, vector in zip(cases, batch.vectors, strict=True):
            sims = [cosine(vector, other.vector) for other in cases]
            own = cosine(vector, case.vector)
            result.cosines.append((purpose, case.text, own))
            if threshold is not None and own < threshold:
                result.problems.append(
                    f"{purpose} {case.text[:40]!r}: kosinus {own:.6f} < {threshold}"
                )
            if max(sims) > own + 1e-9:
                result.problems.append(
                    f"{purpose} {case.text[:40]!r}: cikti baska bir altin metne daha yakin"
                )
    return result


def require_canary(
    spec: ModelSpec, factory: ProviderFactory, directory: Path = GOLDEN_DIR
) -> CanaryResult:
    """Yazma oncesi kapi. Kendi calistirdigimiz modelde basarisizsa `CanaryFailed` firlatir."""
    if not spec.self_hosted:
        return CanaryResult(model_id=spec.id, threshold=None)  # Jina: kapsam disi (karar 0184)
    golden = load_golden(spec.id, directory)
    problems = metadata_problems(spec, golden)
    if problems:
        raise CanaryFailed(f"{spec.id}: altin dosya kayitla uyusmuyor: " + "; ".join(problems))
    result = compare(spec, golden, factory, threshold=threshold_of(golden))
    if not result.passed:
        raise CanaryFailed(result.summary())
    return result


def measured_tolerance(result: CanaryResult, *, margin: float, served_by: str) -> dict[str, Any]:
    """`--measure` sonucundan esik ve kanit. Esik = gozlenen en dusuk - pay (4 haneye asagi)."""
    low = result.min_cosine
    if low is None or result.problems:
        raise CanaryFailed("olcum basarisiz; esik turetilemez:\n" + result.summary())
    value = math.floor((low - margin) * 10_000) / 10_000
    if value < MIN_ALLOWED_THRESHOLD:
        raise CanaryFailed(
            f"gozlenen en dusuk kosinus {low:.6f}; esik {value} < {MIN_ALLOWED_THRESHOLD}. "
            "Cikti referansla ayni uzayda degil (havuzlama/revizyon/onek?)."
        )
    return {
        "min_cosine": value,
        "evidence": {
            "observed_min_cosine": round(low, 6),
            "cases": len(result.cosines),
            "margin": margin,
            "served_by": served_by,
            "measured_at": datetime.now(UTC).isoformat(timespec="seconds"),
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m enrich.canary",
        description="Kendi calistirilan modeli altin vektorlerle dogrular (karar 0184). Yazmaz.",
    )
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-dir", type=Path, help="local_onnx icin model dizini")
    parser.add_argument("--golden-dir", type=Path, default=GOLDEN_DIR)
    parser.add_argument("--measure", action="store_true", help="esik uygulamadan kosinuslari olc")
    parser.add_argument(
        "--record-tolerance",
        metavar="SERVED_BY",
        help="olcumden esigi altin dosyaya yaz (or. 'tei cpu-1.9.4 sha256:...'); --measure ister",
    )
    parser.add_argument("--margin", type=float, default=0.0005)
    args = parser.parse_args(argv)

    from enrich.providers import build_text_provider

    try:
        spec = load_registry().get(args.model)
    except RegistryError as error:
        print(f"HATA: {error}", file=sys.stderr)
        return 2
    if not spec.self_hosted:
        print(f"{spec.id}: API modeli; kanarya kapsam disi (karar 0184).")
        return 0

    def factory(purpose: str) -> Any:
        return build_text_provider(spec, purpose=purpose, model_dir=args.model_dir)

    try:
        golden = load_golden(spec.id, args.golden_dir)
        if args.measure:
            result = compare(spec, golden, factory, threshold=None)
            for purpose, text, value in result.cosines:
                print(f"{purpose:7s} {value:.6f}  {text[:60]}")
            print(result.summary())
            if args.record_tolerance:
                path = golden_path(spec.id, args.golden_dir)
                raw = json.loads(path.read_text(encoding="utf-8"))
                raw["tolerance"] = measured_tolerance(
                    result, margin=args.margin, served_by=args.record_tolerance
                )
                path.write_text(dump_golden(raw), encoding="utf-8", newline="\n")
                print(f"esik yazildi: {raw['tolerance']['min_cosine']} ({path.name})")
            return 0 if not result.problems else 1
        print(require_canary(spec, factory, args.golden_dir).summary())
        return 0
    except (CanaryFailed, RegistryError) as error:
        print(f"HATA: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
