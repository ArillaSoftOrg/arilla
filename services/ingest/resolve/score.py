"""Katman skorlari, veto kurallari ve birlestirme.

Saf fonksiyonlar — veritabani gerektirmez. Zorunlu regresyon seti
(`CLAUDE.md`: "eslestirme mantigi icin regresyon test seti zorunludur")
dogrudan bu modulu surer.

Iki tur kural var ve karistirilmamalari onemli:

* **Veto** — bir uyusmazlik esleşmeyi imkansiz kilar. Skoru dusurmez, sifira
  indirir. Renk ve hacim boyledir.
* **Sinyal** — benzerligi arttirir ya da azaltir. Baslik trigram'i, marka
  uyumu, gorsel kosinusu boyledir.

Veto olmadan "Bilekli Bot Siyah" ile "Bilekli Bot Bej" %90'in ustunde benzer
cikar ve otomatik kabul esigini gecer. `architecture.md`: "Yanlis 'ayni urun'
iddiasi kullanici guvenini bir kerede yok eder."
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from resolve.normalize import ProductKey

#: gtin/mpn tam eslesmesi kesindir; katmanli akis burada durur.
EXACT_SCORE = 1.0

#: Marka uyumu metin skorunu bu kadar yukseltir. Uyusmazlik ceza degil VETO
#: (bkz. `veto_reason`): marka kimliktir, farkli marka farkli urundur.
BRAND_AGREEMENT_BONUS = 0.08

#: Metin ve gorsel birbirini destekliyorsa birlesik skor tek basina
#: hicbirinin ulasamayacagi yere cikar — "hybrid" bunun icin var.
HYBRID_TEXT_WEIGHT = 0.6
HYBRID_IMAGE_WEIGHT = 0.4
HYBRID_AGREEMENT_BONUS = 0.06


@dataclass(frozen=True)
class ScoreResult:
    score: float
    method: str
    #: Veto uygulandiysa sebebi — log ve `/yonetim/eslestirme` icin.
    veto: str | None = None

    @property
    def vetoed(self) -> bool:
        return self.veto is not None


def veto_reason(left: ProductKey, right: ProductKey) -> str | None:
    """Esleşmeyi imkansiz kilan uyusmazlik var mi?

    Kural: yalnizca IKI TARAFTA DA bilinen bir ozellik catisirsa veto edilir.
    Bir tarafta eksik bilgi veto sebebi degildir — eksiklik cok yaygin ve
    "bilmiyorum" ile "farkli" ayri seylerdir.

    Tek istisna model kademesi: bir tarafta "Pro" varsa digerinde yoksa, bu
    eksiklik degil FARKTIR — "Kosu Ayakkabisi Pro" ile "Kosu Ayakkabisi" ayri
    urunlerdir.
    """
    if left.color and right.color and left.color != right.color:
        return f"renk: {left.color} != {right.color}"
    if left.volume and right.volume and left.volume != right.volume:
        return f"hacim: {left.volume} != {right.volume}"
    if left.size and right.size and left.size != right.size:
        return f"beden: {left.size} != {right.size}"
    if left.qualifier != right.qualifier:
        return f"model kademesi: {left.qualifier or 'yok'} != {right.qualifier or 'yok'}"
    # Marka kimliktir. Iki taraf da markasini biliyor ve markalar farkliysa
    # baslik birebir ayni olsa bile ayni urun degildir:
    # "Ayda Poplin Gomlek Beyaz" != "Vira Poplin Gomlek Beyaz".
    if left.brand_norm and right.brand_norm and left.brand_norm != right.brand_norm:
        return f"marka: {left.brand_norm} != {right.brand_norm}"
    return None


def exact_score(left: ProductKey, right: ProductKey) -> ScoreResult | None:
    """1. katman: gtin / mpn. Kesin sonuc — bulunursa akis durur."""
    if left.gtin and right.gtin and left.gtin == right.gtin:
        return ScoreResult(score=EXACT_SCORE, method="gtin")
    if left.mpn and right.mpn and left.mpn == right.mpn:
        return ScoreResult(score=EXACT_SCORE, method="mpn")
    return None


def text_similarity(left: ProductKey, right: ProductKey) -> float:
    """2. katman: token kumesi ortusmesi (Jaccard) + marka uyumu.

    **Neden karakter degil token.** Ilk surum `difflib` ile karakter oranina
    bakiyordu ve regresyon seti onu dusurdu: "Kosu Ayakkabisi Pro Siyah" ile
    "Kosu Ayakkabisi Siyah" karakterde %90 benzer cikip otomatik kabul
    esigini geciyordu. Urun basliklari kisa; bir kelimenin tamamen degismesi
    anlamda buyuk, karakterde kucuk bir farktir. Token kumesinde ayni fark
    dogru buyuklukte gorunur.

    Veritabani tarafinda aday uretimi `pg_trgm` ile yapilir (hizli, indeksli);
    nihai skor her zaman burasidir.
    """
    if not left.tokens or not right.tokens:
        return 0.0

    shared = left.tokens & right.tokens
    union = left.tokens | right.tokens
    base = len(shared) / len(union)

    # Marka catismasi artik veto; burada yalnizca uyum odullendirilir.
    if left.brand_norm and right.brand_norm and left.brand_norm == right.brand_norm:
        base += BRAND_AGREEMENT_BONUS

    return max(0.0, min(1.0, base))


def image_similarity(left_vector: list[float], right_vector: list[float]) -> float:
    """3. katman: kosinus benzerligi.

    Vektorler saglayicidan `normalized=True` ile geliyor, yani nokta carpimi
    dogrudan kosinus benzerligidir. Yine de savunmaci davranip normu
    hesapliyoruz — sentetik test vektorleri normalize olmayabilir.
    """
    if not left_vector or not right_vector or len(left_vector) != len(right_vector):
        return 0.0
    dot = sum(a * b for a, b in zip(left_vector, right_vector, strict=True))
    left_norm = sum(a * a for a in left_vector) ** 0.5
    right_norm = sum(b * b for b in right_vector) ** 0.5
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    # Kosinus -1..1; benzerlik olarak 0..1'e sikistiriyoruz.
    return max(0.0, dot / (left_norm * right_norm))


def combine(
    left: ProductKey,
    right: ProductKey,
    *,
    left_vector: list[float] | None = None,
    right_vector: list[float] | None = None,
) -> ScoreResult:
    """Katmanlari sirayla dener, ilk kesin sonucta durur."""
    veto = veto_reason(left, right)

    exact = exact_score(left, right)
    if exact is not None:
        # gtin ayni ama renk farkli: barkod yanlis girilmis ya da magaza
        # varyantlari tek barkodla yayinliyor. Kesin sayilmaz.
        if veto:
            return ScoreResult(score=0.0, method="gtin", veto=veto)
        return exact

    if veto:
        return ScoreResult(score=0.0, method="text", veto=veto)

    text = text_similarity(left, right)

    has_vectors = bool(left_vector) and bool(right_vector)
    if not has_vectors:
        return ScoreResult(score=text, method="text")

    image = image_similarity(left_vector or [], right_vector or [])
    blended = HYBRID_TEXT_WEIGHT * text + HYBRID_IMAGE_WEIGHT * image
    # Iki bagimsiz sinyal ayni yone isaret ediyorsa guven artar.
    if text >= 0.6 and image >= 0.6:
        blended += HYBRID_AGREEMENT_BONUS

    return ScoreResult(score=max(0.0, min(1.0, blended)), method="hybrid")


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def auto_accept_threshold() -> float:
    """Bu skorun ustunde insan onayi beklenmeden baglanir.

    Varsayilan `python -m resolve --calibrate` ile 60 ciftlik regresyon
    setinden olculdu; bkz. docs/decisions/0017.
    """
    return _env_float("MATCH_AUTO_ACCEPT_THRESHOLD", 0.84)


def queue_threshold() -> float:
    """Bu skorun altinda aday sayilmaz; insan kuyruguna bile girmez."""
    return _env_float("MATCH_QUEUE_THRESHOLD", 0.63)
