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
from classify.taxonomy import (
    ACCESSORY_HOSTS,
    ACCESSORY_PREFIXES,
    APPLY_MIN_CONFIDENCE,
    DEVICE_PATHS,
    MACHINERY_WORDS,
)
from classify.text import words

ENDUSTRIYEL = "ev-yasam/yapi-market/endustriyel"
MOTOSIKLET = "oto-bahce/motosiklet"
TEKNE = "oto-bahce/tekne-deniz"

#: OEM/parca numarasi tasiyan basligin dogal oldugu ust dallar (karar 0141). Bebek, moda, kozmetik
#: gibi tuketici dallarinda parca numarasi, urunun yanlis kovaya konmus bir yedek parca oldugunu
#: gosterir ("Baby Strollers" kovasinda Porsche kupa tutucu): kaynak guveni ne olursa olsun
#: inceleme.
PART_NUMBER_TOPS = ("oto-bahce", "elektronik", "ev-yasam/yapi-market")
#: Arac TURUNU soyleyen dallar: parca numarasi tek basina turu (otomobil mi, motosiklet mi, tekne
#: mi) kanitlamaz; baslik de turu desteklemiyorsa inceleme.
VEHICLE_TYPED = (MOTOSIKLET, TEKNE)
#: Baslik kelimelerinin bu orani sonrasi "son" sayilir: kaynak dalini yalnizca sonda destekleyen
#: baslik, basinda baska bir urun turu soyluyorsa anahtar kelime yiginidir ("IC Chip Picker ...
#: Manicure Cotton Ball Claw" tirnak kovasinda).
TAIL_FRACTION = 0.75
HEAD_FRACTION = 0.4
MIN_TAIL_WORDS = 12

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
    #: Kaynak yolunun cinsiyet baglami (`categories.source_gender`); eslemede kaybolan bilgi.
    gender: frozenset[str] = frozenset()


@dataclass(frozen=True)
class ProductFacts:
    title: str
    #: Urunde zaten olan ve bu isin yazmadigi (korunacak) degerler.
    kept_brand: bool
    kept_category_path: str | None
    brand_raw: str | None
    merchant_name: str | None
    source: SourceVerdict | None
    #: Ham kaynak kategori yolu (karar 0154: dinamik aday secimi bolgesi icin; V5 kullanmaz).
    source_raw: str | None = None


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


def _against_source(
    evidence: TitleEvidence, src: SourceVerdict, confidence: int, title: str
) -> Verdict | None:
    """Baslik kaynakla celisiyorsa inceleme karari; celismiyorsa None (kaynak kurallari surer)."""
    assert src.path is not None
    # Kaynak "Men's Clothing" derken baslik yalnizca kadini soyluyorsa (ya da tersi) urun kaynakla
    # celisir; kaynak onayli olsa da (yonetici yolu onayladi, urunu degil) inceleme (karar 0141).
    if src.gender and evidence.gender and not src.gender & evidence.gender:
        return None, "conflict", confidence, "gender_conflict"
    supporting = [p for p in evidence.paths if _related(p, src.path)]
    if supporting and not _stuffed_tail(evidence, supporting, src.path):
        # Baslik kaynak dalini dogruluyor: baska alandan bir kelime kaynagi bozmaz. ("makeup
        # table" mobilyadir, "hair chain" takidir.) Karar 0139 olcumunde "yabanci kanit daha
        # guclu ise celiski" kurali dogru atamalarin cogunu incelemeye dusurdu; geri alindi.
        return None
    if not supporting and evidence.part_number:
        # Destek yok + OEM/parca numarasi (karar 0141): yanlis kovaya konmus yedek parca.
        consumer = not any(is_within(src.path, t) for t in PART_NUMBER_TOPS)
        if consumer or any(is_within(src.path, v) for v in VEHICLE_TYPED):
            return None, "conflict", confidence, "part_number_conflict"
    foreign = [
        p
        for p, c in evidence.paths.items()
        if c >= CONFLICT_MIN_CONFIDENCE and not _related(p, src.path)
    ]
    if foreign:
        # Arac parcasi kaynaginda ("Engines & Engine Parts") baslik yalniz bilesen soyluyorsa
        # (vana, pompa, sensor) ve is makinesi sozcugu yoksa urun oto parcasidir (karar 0139).
        if (
            _top(src.path) == "oto-bahce"
            and all(is_within(p, ENDUSTRIYEL) for p in foreign)
            and any(_related(c, src.path) for c in evidence.cues)  # olumlu arac sinyali
            and not MACHINERY_WORDS & set(words(title))
        ):
            return None
        # Denendi ve KALDIRILDI (karar 0139): zayif cop kovasinda "tek guclu kardes dal baslik
        # karar versin" kurali dis hekimi pensesi, kaya matkabi cekici gibi onlenmis hatalari geri
        # getirdi (koruma testi yakaladi). Genel alet sozcukleri bu kovalarda guvenilir kanit degil.
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


def _stuffed_tail(evidence: TitleEvidence, supporting: list[str], source_path: str) -> bool:
    """Kaynak dalini YALNIZ basligin sonundaki tek kelime destekliyor, basinda ise baska bir alan
    daha uzun (cok kelimeli) bir ifadeyle gucluce konusuyor (karar 0141): baslik urun turunu once
    soyler, sonu anahtar kelime yiginidir ("IC Chip Picker / Electronic Component ... Manicure").
    Kisa baslik, ayni ana dal icindeki kardes dal ve tek kelimelik yabanci kanit yigin sayilmaz."""
    if evidence.length < MIN_TAIL_WORDS:
        return False
    head_end = evidence.length * HEAD_FRACTION
    tail_start = evidence.length * TAIL_FRACTION
    support_pos = min(evidence.first[p][0] for p in supporting)
    support_len = max(evidence.first[p][1] for p in supporting)
    if support_pos < tail_start:
        return False
    return any(
        c >= CONFLICT_MIN_CONFIDENCE
        and not _related(p, source_path)
        and _top(p) != _top(source_path)
        and evidence.first[p][0] < head_end
        and evidence.first[p][1] >= 2
        and evidence.first[p][1] > support_len
        for p, c in evidence.paths.items()
    )


def _mentions(title: str, phrases: tuple[str, ...]) -> bool:
    text = " " + " ".join(words(title)) + " "
    return any(" " + " ".join(words(p)) + " " in text for p in phrases)


def _host_missing(src: SourceVerdict, evidence: TitleEvidence, title: str) -> bool:
    """Aksesuar dali kaynagi, basligin ana urunu anmasini ister (karar 0142).

    "Baby Strollers & Accessories" kovasinda mama sandalyesi minderi: urun bir aksesuar ama
    bebek arabasinin degil. Baslik dali kendi kuraliyla destekliyorsa ya da ana urunu aniyorsa
    sorun yok; onayli esleme (yonetici) bu kontrolden muaftir.
    """
    assert src.path is not None
    hosts = ACCESSORY_HOSTS.get(src.path)
    if not hosts or src.status == "confirmed":
        return False
    if any(_related(p, src.path) for p in evidence.paths):
        return False
    return not _mentions(title, hosts)


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
        against = _against_source(evidence, src, confidence, facts.title)
        if against is not None:
            return against
        if _host_missing(src, evidence, facts.title):
            return None, "low_confidence", confidence, "accessory_host_missing"
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
        # Iki alt dal kaynagin KENDI ust dalinda bulusuyorsa (elmas boyama + nakis -> hobi) da
        # onaydir: v2 bunu kabul ediyordu ve olcumde dogruydu.
        confirmed = refined.path is not None and (
            refined.confidence >= APPLY_MIN_CONFIDENCE
            or (refined.kind == "lca" and refined.path == src.path)
        )
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
