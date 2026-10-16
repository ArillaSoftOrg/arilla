"""Affiliate agi baglayici arayuzu ve kaydi. Yeni ag = yeni `FeedNetwork`.

Bir ag iki sey yapar:

1. `discover()`: yetkili (bagli/onayli) programlarin beslemelerini listeler.
2. `download_url(external_id)`: o beslemenin GUNCEL indirme adresini verir.
   Adres kimlik bilgisi tasiyabilir (Admitad `code`); veritabanina YAZILMAZ,
   her senkronizasyonda yeniden cozulur ve yalnizca bellekte tutulur.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol
from urllib.parse import parse_qsl, urlencode, urlsplit


@dataclass(frozen=True)
class DiscoveredFeed:
    network: str
    #: Ag icinde benzersiz besleme kimligi, or. "<program_id>:<feed_id>".
    external_id: str
    program_external_id: str | None
    program_name: str | None
    name: str | None
    format: str | None
    compression: str | None
    #: Kimlik parametreleri silinmis gosterim adresi.
    source_url_redacted: str | None
    currency: str | None
    market: str | None
    source_updated_at: datetime | None
    #: Ilk kayitta `feed_source.config`'e yazilan varsayilanlar (or. {"parser": "yml"}).
    #: Sonraki kesifler yonetici ayarini EZMEZ.
    default_config: dict[str, Any] = field(default_factory=dict)


class FeedNetwork(Protocol):
    name: str

    def discover(self) -> list[DiscoveredFeed]: ...

    def download_url(self, external_id: str) -> str: ...


class NetworkUnavailable(Exception):
    """Ag yapilandirilmamis (kimlik bilgisi yok) ya da gecici olarak erisilemez."""


_REGISTRY: dict[str, Callable[[], FeedNetwork]] = {}


def register(name: str, factory: Callable[[], FeedNetwork]) -> None:
    _REGISTRY[name] = factory


def build(name: str) -> FeedNetwork:
    try:
        return _REGISTRY[name]()
    except KeyError:
        known = ", ".join(sorted(_REGISTRY)) or "(yok)"
        raise ValueError(f"'{name}' agi kayitli degil. Kayitli: {known}") from None


def registered() -> list[str]:
    return sorted(_REGISTRY)


#: Gosterimde asla tutulmayacak sorgu parametreleri (kimlik/oturum).
SECRET_PARAMS = frozenset(
    {"code", "user", "token", "key", "secret", "password", "pass", "sig", "signature", "auth"}
)


def redact_url(url: str, keep: frozenset[str] | None = None) -> str:
    """Yalnizca sema+host+yol ve izinli parametreler kalir; sir parametreleri atilir."""
    parts = urlsplit(url)
    params = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if k.lower() not in SECRET_PARAMS and (keep is None or k in keep)
    ]
    query = f"?{urlencode(params)}" if params else ""
    return f"{parts.scheme}://{parts.hostname or ''}{parts.path}{query}"[:2048]
