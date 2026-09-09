"""Esik kalibrasyonu — regresyon setinden olcum.

`.env`'deki 0.92/0.70 degerleri bir yerden gelmiyordu. Bu modul 60 ciftlik
regresyon setini skorlar ve esikleri KANITA baglar:

    AUTO_ACCEPT  esleşmemelerin en yuksek skorunun USTUNDE  -> yanlis pozitif sifir
    QUEUE        esleşmelerin en dusuk skorunun ALTINDA     -> yanlis negatif sifir

Ikisi cakisiyorsa (eslesmemelerin maksimumu, eslesmelerin minimumundan buyuk)
skorlama zayif demektir; esigi kaydirmak yerine skorlama duzeltilir.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from statistics import median

from resolve.normalize import ProductKey
from resolve.score import combine

PAIRS_PATH = (
    Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "matching" / "pairs.json"
)


@dataclass(frozen=True)
class Scored:
    case: str
    score: float
    method: str
    veto: str | None


@dataclass(frozen=True)
class Distribution:
    label: str
    scores: list[Scored]

    @property
    def values(self) -> list[float]:
        return [item.score for item in self.scores]

    @property
    def minimum(self) -> float:
        return min(self.values) if self.values else 0.0

    @property
    def maximum(self) -> float:
        return max(self.values) if self.values else 0.0

    @property
    def middle(self) -> float:
        return median(self.values) if self.values else 0.0


def _key(entry: dict) -> ProductKey:
    return ProductKey.build(
        title=entry["title"],
        brand=entry.get("brand"),
        color=entry.get("color"),
        gtin=entry.get("gtin"),
        mpn=entry.get("mpn"),
    )


def load_pairs(path: Path = PAIRS_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def score_group(pairs: list[dict]) -> list[Scored]:
    results: list[Scored] = []
    for pair in pairs:
        outcome = combine(_key(pair["a"]), _key(pair["b"]))
        results.append(
            Scored(
                case=pair["case"],
                score=outcome.score,
                method=outcome.method,
                veto=outcome.veto,
            )
        )
    return results


def distributions(path: Path = PAIRS_PATH) -> tuple[Distribution, Distribution]:
    data = load_pairs(path)
    return (
        Distribution("eslesme", score_group(data["should_match"])),
        Distribution("eslesmeme", score_group(data["should_not_match"])),
    )


def report(path: Path = PAIRS_PATH) -> int:
    matches, non_matches = distributions(path)

    for group in (matches, non_matches):
        print(f"--- {group.label} ({len(group.scores)} cift) ---")
        print(f"  min     {group.minimum:.3f}")
        print(f"  medyan  {group.middle:.3f}")
        print(f"  max     {group.maximum:.3f}")

    print("\n--- ayrim ---")
    gap = matches.minimum - non_matches.maximum
    print(f"  eslesmelerin min : {matches.minimum:.3f}")
    print(f"  eslesmemelerin max: {non_matches.maximum:.3f}")
    print(f"  bosluk           : {gap:+.3f}")

    if gap <= 0:
        print("\n  UYARI: gruplar ORTUSUYOR. Esik kaydirmak cozmez; skorlama duzeltilmeli.")
        print("  Ortusen eslesmeme ornekleri:")
        for item in sorted(non_matches.scores, key=lambda s: -s.score)[:5]:
            if item.score >= matches.minimum:
                print(f"    {item.score:.3f}  {item.case}")
        return 1

    # Iki esik farkli sorulari yanitlar; ayni araliktan turetilemezler.
    #
    # QUEUE  "insana gostermeye deger mi?" — yanlis NEGATIFE karsi korur.
    #        Iki grubun arasindaki bosluğun ortasi: hicbir gercek eslesme
    #        dusmez, hicbir yanlis eslesme kuyruga girmez.
    #
    # AUTO   "insana hic sormadan baglayabilir miyiz?" — yanlis POZITIFE
    #        karsi korur. Eslesmelerin kendi araligindan secilir: en zayif
    #        gercek eslesmeler (tek tarafli renk/hacim bilgisi) insan onayina
    #        DUSMELI, yalnizca kesin olanlar otomatik baglanmali.
    queue = round((non_matches.maximum + matches.minimum) / 2, 2)
    auto_accept = round((matches.minimum + matches.maximum) / 2, 2)

    print("\n--- onerilen esikler ---")
    print(f"  MATCH_AUTO_ACCEPT_THRESHOLD={auto_accept}")
    print(f"  MATCH_QUEUE_THRESHOLD={queue}")

    print("\n--- en zor ornekler ---")
    print("  en dusuk skorlu eslesmeler:")
    for item in sorted(matches.scores, key=lambda s: s.score)[:3]:
        print(f"    {item.score:.3f}  {item.case}")
    print("  en yuksek skorlu eslesmemeler:")
    for item in sorted(non_matches.scores, key=lambda s: -s.score)[:3]:
        veto = f"  [veto: {item.veto}]" if item.veto else ""
        print(f"    {item.score:.3f}  {item.case}{veto}")

    return 0
