"""Yapilandirma tabanli kaynak adapter'lari (karar 0164): API, JSON, CSV, XML."""

from __future__ import annotations

import dataclasses
from collections.abc import Callable
from pathlib import Path
from typing import Any

from platforms.adapters.base import BaseAdapter, SourceUnavailable
from platforms.adapters.mapping import FieldMapping, map_record
from platforms.adapters.sources import (
    CsvAdapter,
    JsonFileAdapter,
    JsonPagesAdapter,
    Page,
    PageSource,
    XmlAdapter,
)
from platforms.registry import SourceDefinition

__all__ = [
    "BaseAdapter",
    "CsvAdapter",
    "FieldMapping",
    "JsonFileAdapter",
    "JsonPagesAdapter",
    "Page",
    "PageSource",
    "SourceUnavailable",
    "XmlAdapter",
    "build_adapter",
    "map_record",
]

_SUFFIX_KIND = {
    ".csv": "csv",
    ".xml": "xml",
    ".json": "json",
    ".ndjson": "json",
    ".jsonl": "json",
}


def build_adapter(
    definition: SourceDefinition,
    source: PageSource | str | Path,
    mapping: FieldMapping,
    **options: Any,
) -> BaseAdapter:
    """Kaynak tanimindan adapter uretir.

    - `source` cagrilabilir: `JsonPagesAdapter` (sayfa kaynagi).
    - `source` yol: uzantiya (`.csv/.xml/.json/.ndjson/.jsonl`), yoksa `definition.kind`'a gore.
    - Para birimi eslemede yoksa tanimdan (`definition.currency`) doldurulur; ikisi
      celisirse `ValueError`.
    - `options`: adapter'a gecer (`delimiter`, `record_path`, `records_path`, `observed_at`...).
    """
    if definition.currency is not None:
        if mapping.currency is not None and mapping.currency != definition.currency:
            raise ValueError("esleme para birimi kaynak tanimiyla celisiyor")
        mapping = dataclasses.replace(mapping, currency=definition.currency)
    common = {"offer_key_scheme": definition.offer_key_scheme, **options}

    if callable(source):
        return JsonPagesAdapter(definition.slug, mapping, source, **common)
    path = Path(source)
    kind = _SUFFIX_KIND.get(path.suffix.lower(), definition.kind)
    factories: dict[str, Callable[..., BaseAdapter]] = {
        "csv": CsvAdapter,
        "xml": XmlAdapter,
        "feed": XmlAdapter,
        "json": JsonFileAdapter,
    }
    factory = factories.get(kind)
    if factory is None:
        raise ValueError(f"dosya kaynagi icin desteklenmeyen tur: {kind}")
    return factory(definition.slug, mapping, path, **common)
