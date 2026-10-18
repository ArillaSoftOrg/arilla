"""Tek urun icin marka + kategori karari (SAF; veritabani yok, ayni girdi ayni sonuc).

Oncelik (karar 0133, 0138):
1. Urunde insan/besleme tarafindan yazilmis deger varsa KORUNUR (`existing`).
2. Kaynak kategori eslemesi (`category_source_map`: onayli = 100, oneri = kural guveni).
   Baslik kaynaktan BAGIMSIZ da okunur (karar 0138): AliExpress kaynagi iki seviyelidir ve
   saticinin secimidir ("Kitchen,Dining & Bar" icinde priz, NAS, yakit tanki). Baslikta kaynak
   dalini destekleyen kural yoksa ve
   a. baslik guclu bicimde BASKA bir dali gosteriyorsa: inceleme (`conflict`,
      `source_title_conflict`). Baslik kategoriyi tek basina DEGISTIRMEZ: olcumde bu tur
      "baslik kazansin" kararlarinin yarisi yanlisti (meyve kasesi -> mobilya, bira musluğu ->
      banyo). Onayli esleme de bu durumda incelemeye duser (yonetici yolu onayladi, urunu degil).
   b. yalnizca alan isareti ("car", "garden", "plug") baska alani gosteriyorsa: onerilmis
      kaynakta inceleme (`source_cue_conflict`); onayli kaynak korunur.
3. Baslik, kaynak kategorisinin ALTINDA daha ozel bir dal gosteriyorsa onu secer
   ("Earphones & Headphones" + "Gaming Headset" -> oyuncu kulakligi).
4. Kaynak zayifsa baslik ayni dali dogrularsa kabul; dogrulamazsa inceleme.
5. Kaynak yoksa yalnizca baslik; guven esigi gecilmezse inceleme. Kaynak yolu olup agacta
   karsiligi yoksa (`unmapped`, or. endustriyel kategoriler) baslik daha yuksek esik ister:
   olcumde bu kovada baslik tek basina cogunlukla yanlisti (kaynak makinesi -> taki).
Parca/uyumluluk basligi ("Replacement Chuck for Rotary Hammer", "Suitable for Coffee Machine")
bir cihaz kategorisine (`DEVICE_PATHS`) baslik kanitiyla girmez: basliktaki cihaz urunun
kendisi degil, uyumlu oldugu cihazdir.
Marka: yapilandirilmis kaynak > secilmis listeden baslik (uyumluluk ayrilir) > yok.
Model cagrisi YOK; belirsiz urun 'review' ile bekler (yanlis kategori yazilmaz).
"""

from __future__ import annotations

from dataclasses import dataclass

from classify.brands import clean_source_brand, find_title_brand
from classify.categories import TitleEvidence, is_within, title_evidence
from classify.taxonomy import ACCESSORY_PREFIXES, APPLY_MIN_CONFIDENCE, DEVICE_PATHS

#: Iki zayif kanit (kaynak + baslik) ayni dali gosterdiginde verilen guven.
AGREEMENT_CONFIDENCE = 85
#: Bu baslik guveninde (kural >= 85) kaynak disi aday celiski sayilir.
CONFLICT_MIN_CONFIDENCE = APPLY_MIN_CONFIDENCE
#: Kaynak yolu var ama agacta karsiligi yok ("Industrial & Business > Packaging ..."): urun
#: buyuk olasilikla hicbir dala ait degil; baslik ancak bu guvende (kural >= 90) yazilir.
UNMAPPED_TITLE_MIN_CONFIDENCE = 85


def _related(path: str, other: str) -> bool:
    return is_within(path, other) or is_within(other, path)


def _top(path: str) -> str:
    return path.split("/", 1)[0]


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
    #: Marka bos kaldiysa nedeni (`brands.NO_KNOWN_BRAND` ...); veritabanina yazilmaz.
    brand_reason: str | None = None

    @property
    def state(self) -> str:
        return (
            "applied"
            if self.category_basis not in ("none", "conflict", "low_confidence")
            else "review"
        )


Verdict = tuple[str | None, str, int, str | None]


def _against_source(evidence: TitleEvidence, src: SourceVerdict, confidence: int) -> Verdict | None:
    """Baslik kaynakla celisiyorsa inceleme karari; celismiyorsa None (kaynak kurallari surer)."""
    assert src.path is not None
    supported = [c for p, c in evidence.paths.items() if _related(p, src.path)]
    if supported:
        # Baslik kaynak dalini dogruluyor: zayif bir yabanci kelime kaynagi bozmaz. Ama yabanci
        # dal destekten DAHA guclu kanitliyorsa (karar 0139: "fitness stepper ... hydraulic")
        # baslik kaynagi dogrulamiyor, iki alan arasinda kaliyor: inceleme.
        strongest_foreign = max(
            (
                c
                for p, c in evidence.paths.items()
                if c >= CONFLICT_MIN_CONFIDENCE and not _related(p, src.path)
            ),
            default=0,
        )
        if strongest_foreign > max(supported):
            return None, "conflict", confidence, "source_title_conflict"
        return None
    foreign = [
        p
        for p, c in evidence.paths.items()
        if c >= CONFLICT_MIN_CONFIDENCE and not _related(p, src.path)
    ]
    if foreign:
        # Ayni ana kategoride kardes dal ve baslik kaynagin alanini da soyluyor ("Car Headlight
        # Film" Exterior Accessories'te: "headlight" yedek parca kurali, "car" arac alani):
        # urun alani dogru, yaprak secimi saticinin; kaynak surer.
        if any(_related(c, src.path) for c in evidence.cues) and all(
            _top(p) == _top(src.path) for p in foreign
        ):
            return None
        return None, "conflict", confidence, "source_title_conflict"
    if src.status != "confirmed" and any(not _related(c, src.path) for c in evidence.cues):
        return None, "conflict", confidence, "source_cue_conflict"
    return None


def _title_device(path: str | None, evidence: TitleEvidence) -> bool:
    """Parca/uyumluluk basligi bir cihaz kategorisini gosteriyor: kanit sayilmaz."""
    return evidence.part and path in DEVICE_PATHS


def _category(facts: ProductFacts) -> Verdict:
    if facts.kept_category_path is not None:
        return facts.kept_category_path, "existing", 100, None
    evidence = title_evidence(facts.title)
    src = facts.source
    if src is not None and src.status == "rejected":
        src = None
    if src is not None and src.path is not None:
        confidence = 100 if src.status == "confirmed" else src.confidence
        against = _against_source(evidence, src, confidence)
        if against is not None:
            return against
        refined = evidence.within(src.path)
        deeper = (
            refined.path is not None
            and refined.path != src.path
            and is_within(refined.path, src.path)
            and not _title_device(refined.path, evidence)
        )
        if confidence >= APPLY_MIN_CONFIDENCE:
            if deeper and refined.confidence >= APPLY_MIN_CONFIDENCE - 5:
                return refined.path, "source_title", max(confidence, refined.confidence), None
            return src.path, "source", confidence, None
        # Zayif kaynagi dogrulamak icin baslik kanitinin kendisi esigi gecmeli: tek bir genel
        # kelime ("hydraulic") onaylamaz (karar 0139).
        confirmed = refined.path is not None and refined.confidence >= APPLY_MIN_CONFIDENCE
        if confirmed and (
            deeper or (refined.path == src.path and not _title_device(src.path, evidence))
        ):
            return refined.path, "source_title", AGREEMENT_CONFIDENCE, None
        broad = evidence.guess
        if broad.path is not None and is_within(src.path, broad.path):
            return src.path, "source_title", AGREEMENT_CONFIDENCE, None
        if evidence.part and refined.path is not None:
            return None, "low_confidence", confidence, "part_title"
        return None, "low_confidence", confidence, "weak_source"
    guess = evidence.guess
    unmapped = src is not None and src.status == "unmapped"
    if guess.path is not None and guess.confidence >= APPLY_MIN_CONFIDENCE:
        if _title_device(guess.path, evidence):
            return None, "low_confidence", guess.confidence, "part_title"
        if unmapped and guess.confidence < UNMAPPED_TITLE_MIN_CONFIDENCE:
            return None, "low_confidence", guess.confidence, "unmapped_source"
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
    brand_reason: str | None = None
    if facts.kept_brand:
        brand_name, brand_basis = None, "existing"
    else:
        source_brand = clean_source_brand(facts.brand_raw, merchant_name=facts.merchant_name)
        if source_brand is not None:
            brand_name, brand_basis = source_brand, "source"
        else:
            brand_name, brand_basis = finding.brand, finding.basis
            brand_reason = finding.reason
    return Decision(
        category_path=path,
        category_basis=basis,
        confidence=confidence,
        brand_name=brand_name,
        brand_basis=brand_basis,
        compatible=finding.compatible,
        detail=detail,
        brand_reason=brand_reason,
    )
