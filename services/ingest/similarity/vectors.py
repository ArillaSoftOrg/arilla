"""Urun vektoru turetimi.

`architecture.md`: "Embedding offer uzerinden uretilir, benzerlik product
uzerinden hesaplanir." B3 offer duzeyinde vektor uretti; bir urunun vektoru
tekliflerinin ortalamasidir.

Neden ortalama: ayni urunun farkli magazalardaki fotograflari ayni seyi
farkli acidan gosterir. Ortalama, magazaya ozgu gurultuyu (arka plan, isik,
cerceve) soyup urunun kendisine yaklasir.

**Urun vektoru veritabanina YAZILMAZ.** Sema `target_type = 'product'`'a izin
veriyor ama `embedding_ann_idx` HNSW indeksi yalnizca `WHERE target_type =
'offer'` kismi kosuluyla tanimli; urun vektorleri indekssiz kalirdi. Aday
uretimi bu yuzden offer duzeyindeki indeks uzerinden yapiliyor.
"""

from __future__ import annotations

import math
from collections.abc import Sequence


def parse_vector(raw: object) -> list[float]:
    """pgvector degerini listeye cevirir ('[0.1,0.2]' ya da hazir liste)."""
    if isinstance(raw, list):
        return [float(value) for value in raw]
    text = str(raw).strip().lstrip("[").rstrip("]")
    return [float(part) for part in text.split(",") if part]


def to_literal(vector: Sequence[float]) -> str:
    """pgvector metin bicimi."""
    return "[" + ",".join(f"{value:.6f}" for value in vector) + "]"


def normalize(vector: Sequence[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0.0:
        return list(vector)
    return [value / norm for value in vector]


def average(vectors: Sequence[Sequence[float]]) -> list[float] | None:
    """Tekliflerin vektorlerinin ortalamasi, yeniden normalize edilmis.

    Yeniden normalize etmek sart: kosinus mesafesi normalize vektorlerde
    dogru calisir ve ortalama alma normu bozar. `embedding_ann_idx`
    `vector_cosine_ops` kullaniyor.
    """
    usable = [vector for vector in vectors if vector]
    if not usable:
        return None

    width = len(usable[0])
    if any(len(vector) != width for vector in usable):
        # Farkli model surumleri karisti; ortalamak anlamsiz olurdu.
        return None

    total = [0.0] * width
    for vector in usable:
        for index, value in enumerate(vector):
            total[index] += value
    return normalize([value / len(usable) for value in total])


def cosine(left: Sequence[float], right: Sequence[float]) -> float:
    """0-1 arasina sikistirilmis kosinus benzerligi."""
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return max(0.0, min(1.0, dot / (left_norm * right_norm)))
