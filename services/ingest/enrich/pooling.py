"""Token vektorlerinden tek metin vektorune inis (havuzlama), karar 0186.

Kayit defterindeki `pooling` alaninin GERCEK cikarimdaki karsiligi budur; yerel ONNX gommesi
(`classify.suggest.model.OnnxEmbedder`) bu fonksiyonu cagirir. Uzak sunucuda (TEI) havuzlama
sunucudadir; orada dogrulama altin vektor kanaryasiyla yapilir (`enrich.canary`).

- `cls`: ilk token (BERT/XLM-R ailesi, ornek BGE-M3). Sol dolgu (left padding) ile anlamsizdir;
  ilk konumu dolgu olan satir varsa hata verilir.
- `mean`: dolgu haric token ortalamasi (ornek e5).
- `last_token`: dolgu haric SON token (ornek Qwen3-Embedding). Sag ve sol dolgu ikisi de dogru
  ele alinir: her satirda maskesi 1 olan en sagdaki konum secilir.

Yanlis yontem boyut ve norm kapisindan gecer (yine 1024 boyutlu birim vektor cikar) ama vektor
uzayi yanlistir; bu yuzden yontem kayit defterinden okunur ve kanaryayla dogrulanir.
Normalizasyon burada YAPILMAZ (`normalize_l2` ayri).
"""

from __future__ import annotations

from typing import Any

import numpy as np

POOLING_METHODS = ("cls", "mean", "last_token")


class PoolingError(ValueError):
    """Gecersiz yontem ya da girdi (bos satir, sol dolguda CLS, boyut uyusmazligi)."""


def _check(hidden: Any, mask: Any) -> tuple[np.ndarray, np.ndarray]:
    hidden = np.asarray(hidden)
    mask = np.asarray(mask)
    if hidden.ndim != 3 or mask.ndim != 2 or hidden.shape[:2] != mask.shape:
        raise PoolingError(
            f"boyut uyusmazligi: hidden {hidden.shape}, mask {mask.shape} (beklenen [B,L,D], [B,L])"
        )
    if not np.isin(mask, (0, 1)).all():
        raise PoolingError("attention mask yalniz 0/1 olmali")
    if (mask.sum(axis=1) == 0).any():
        raise PoolingError("tamamen dolgu olan satir var (bos girdi)")
    return hidden, mask


def pool(hidden: Any, mask: Any, method: str) -> np.ndarray:
    """[B, L, D] token vektorleri + [B, L] maske -> [B, D] (normalize EDILMEMIS)."""
    hidden, mask = _check(hidden, mask)
    if method == "cls":
        if (mask[:, 0] == 0).any():
            raise PoolingError("cls havuzlamasi sol dolguyla kullanilamaz (ilk token dolgu)")
        return hidden[:, 0, :].astype(np.float32)
    if method == "mean":
        weights = mask[:, :, None].astype(np.float32)
        return ((hidden * weights).sum(axis=1) / weights.sum(axis=1)).astype(np.float32)
    if method == "last_token":
        length = mask.shape[1]
        # Ters cevrilmis maskede ilk 1 -> orijinalde en sagdaki 1 (sag ya da sol dolgu fark etmez).
        last = length - 1 - np.argmax(mask[:, ::-1], axis=1)
        return hidden[np.arange(hidden.shape[0]), last, :].astype(np.float32)
    raise PoolingError(f"bilinmeyen havuzlama {method!r}; desteklenen: {POOLING_METHODS}")


def normalize_l2(vectors: Any) -> np.ndarray:
    vectors = np.asarray(vectors, dtype=np.float32)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.maximum(norms, 1e-12)
