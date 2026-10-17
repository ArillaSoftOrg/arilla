"""Tek urun icin marka + kategori karari (SAF; veritabani yok, ayni girdi ayni sonuc).

Oncelik (karar 0133):
1. Urunde insan/besleme tarafindan yazilmis deger varsa KORUNUR (`existing`).
2. Kaynak kategori eslemesi (`category_source_map`: onayli = 100, oneri = kural guveni).
3. Baslik, kaynak kategorisinin ALTINDA daha ozel bir dal gosteriyorsa onu secer
   ("Earphones & Headphones" + "Gaming Headset" -> oyuncu kulakligi).
4. Kaynak zayifsa baslik ayni dali dogrularsa kabul; dogrulamazsa inceleme.
5. Kaynak yoksa yalnizca baslik; guven esigi gecilmezse inceleme.
Marka: yapilandirilmis kaynak > secilmis listeden baslik (uyumluluk ayrilir) > yok.
Model cagrisi YOK; belirsiz urun 'review' ile bekler (yanlis kategori yazilmaz).
"""

from __future__ import annotations

from dataclasses import dataclass

from classify.brands import clean_source_brand, find_title_brand
from classify.categories import CategoryGuess, guess_title, is_within
from classify.taxonomy import ACCESSORY_PREFIXES, APPLY_MIN_CONFIDENCE

#: Iki zayif kanit (kaynak + baslik) ayni dali gosterdiginde verilen guven.
AGREEMENT_CONFIDENCE = 85


@dataclass(frozen=True)
class SourceVerdict:
    """Kaynak yolunun eslemesi: `confirmed` yonetici onayidir (guven 100)."""

    path: str | None
    confidence: int
    status: str  # 'confirmed' | 'suggested' | 'unmapped' | 'rejected'


@dataclass(frozen=True)
class ProductFacts:
    title: str
    #: Urunde zaten olan ve bu isin yazmadigi (korunacak) degerler.
    kept_brand: bool
    kept_category_path: str | None
    brand_raw: str | None
    merchant_name: str | None
    source: SourceVerdict | None


@dataclass(frozen=True)
class Decision:
    category_path: str | None
    category_basis: str
    confidence: int
    brand_name: str | None
    brand_basis: str
    compatible: tuple[str, ...]
    detail: str | None

    @property
    def state(self) -> str:
        return (
            "applied"
            if self.category_basis not in ("none", "conflict", "low_confidence")
            else "review"
        )


def _category(facts: ProductFacts) -> tuple[str | None, str, int, str | None]:
    if facts.kept_category_path is not None:
        return facts.kept_category_path, "existing", 100, None
    src = facts.source
    if src is not None and src.status == "rejected":
        src = None
    if src is not None and src.path is not None:
        confidence = 100 if src.status == "confirmed" else src.confidence
        refined = guess_title(facts.title, within=src.path)
        deeper = (
            refined.path is not None
            and refined.path != src.path
            and is_within(refined.path, src.path)
        )
        if confidence >= APPLY_MIN_CONFIDENCE:
            if deeper and refined.confidence >= APPLY_MIN_CONFIDENCE - 5:
                return refined.path, "source_title", max(confidence, refined.confidence), None
            return src.path, "source", confidence, None
        if deeper or refined.path == src.path:
            return refined.path, "source_title", AGREEMENT_CONFIDENCE, None
        broad = guess_title(facts.title)
        if broad.path is not None and is_within(src.path, broad.path):
            return src.path, "source_title", AGREEMENT_CONFIDENCE, None
        return None, "low_confidence", confidence, "weak_source"
    guess: CategoryGuess = guess_title(facts.title)
    if guess.path is not None and guess.confidence >= APPLY_MIN_CONFIDENCE:
        return guess.path, "title", guess.confidence, None
    if guess.kind == "conflict":
        return None, "conflict", 0, "title_conflict"
    if guess.path is not None:
        return None, "low_confidence", guess.confidence, "weak_title"
    return None, "none", 0, "no_evidence"


def decide(facts: ProductFacts) -> Decision:
    path, basis, confidence, detail = _category(facts)
    accessory = path is not None and any(is_within(path, p) for p in ACCESSORY_PREFIXES)
    finding = find_title_brand(facts.title, accessory=accessory, category_known=path is not None)
    if facts.kept_brand:
        brand_name, brand_basis = None, "existing"
    else:
        source_brand = clean_source_brand(facts.brand_raw, merchant_name=facts.merchant_name)
        if source_brand is not None:
            brand_name, brand_basis = source_brand, "source"
        else:
            brand_name, brand_basis = finding.brand, finding.basis
    return Decision(
        category_path=path,
        category_basis=basis,
        confidence=confidence,
        brand_name=brand_name,
        brand_basis=brand_basis,
        compatible=finding.compatible,
        detail=detail,
    )
