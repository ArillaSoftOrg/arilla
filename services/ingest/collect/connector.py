"""Connector protokolu ve kaydi.

Uc kaynak bicimi TASIMA katmaninda gercekten farklidir: XML tek GET ile gelir,
REST auth ve sayfalama ister, ag dokumu buyuk bir dosyayi akitir. Ortak nokta
ciktilaridir — hepsi `RawRecord` uretir.

`fetch()` bir iterator dondurur: REST sayfalamasi ve buyuk dokumler bellege
sigmadan islenir.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any, Protocol

from collect.records import RawRecord


class Connector(Protocol):
    """Bir merchant kaynagindan ham kayitlari akitir."""

    def fetch(self) -> Iterator[RawRecord]: ...


#: `merchant.source_type` -> connector fabrikasi
ConnectorFactory = Callable[[str | None, dict[str, Any]], Connector]

_REGISTRY: dict[str, ConnectorFactory] = {}


def register(source_type: str, factory: ConnectorFactory) -> None:
    _REGISTRY[source_type] = factory


def build(source_type: str, feed_url: str | None, feed_config: dict[str, Any]) -> Connector:
    """`merchant` satirindan connector uretir."""
    try:
        factory = _REGISTRY[source_type]
    except KeyError:
        known = ", ".join(sorted(_REGISTRY)) or "(hicbiri kayitli degil)"
        raise ValueError(
            f"'{source_type}' icin connector yok. Kayitli olanlar: {known}. "
            "'user_discovered' toplu bir kaynak degildir — kullanici linki B2'nin isidir."
        ) from None
    return factory(feed_url, feed_config)
