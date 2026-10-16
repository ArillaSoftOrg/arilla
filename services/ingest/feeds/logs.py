"""Besleme/fiyat komutlarinin log yapilandirmasi (karar 0114).

Besleme indirme adresi kimlik bilgisi tasir (Admitad `code`, `user`). httpx
INFO duzeyinde her istegin TAM adresini yazar; bu yuzden:

- `httpx` ve `httpcore` WARNING duzeyine cekilir;
- kok logger'a filtre: mesajdaki her adresin sorgu dizisi ve kullanici bilgisi
  `?<gizli>` ile degistirilir (savunma derinligi: baska kutuphane de yazsa).
"""

from __future__ import annotations

import logging
import re

_URL = re.compile(
    r"\b(https?://)(?:[^\s/@]+@)?([^\s/?#'\"<>]+)([^\s?#'\"<>]*)(\?[^\s'\"<>]*)?", re.I
)


def mask_urls(text: str) -> str:
    return _URL.sub(
        lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}" + ("?<gizli>" if m.group(4) else ""), text
    )


class MaskUrls(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        masked = mask_urls(message)
        if masked != message:
            record.msg = masked
            record.args = None
        return True


def configure() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
    for handler in logging.getLogger().handlers:
        handler.addFilter(MaskUrls())
