"""Kaynak turune gore adapter'lar: JSON sayfalari (API), JSON/NDJSON, CSV, XML.

Hepsi tembeldir (generator), hicbiri ag cagrisi yapmaz: sayfa kaynagi disaridan verilir.
Tek bozuk kayit `Rejection`; kaynagin tamami okunamazsa `SourceUnavailable`.
"""

from __future__ import annotations

import csv
import json
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from collect.sources.xml_feed import DEFAULT_RECORD_PATH, _field_names, _local_name
from platforms.adapters.base import BaseAdapter, Clock, SourceUnavailable
from platforms.adapters.mapping import FieldMapping, get_value
from platforms.contract import CanonicalListing, Checkpoint, OfferKeyScheme, Rejection


@dataclass(frozen=True)
class Page:
    """API'nin bir sayfasi. `next_token` None ise son sayfa."""

    records: Sequence[Any]
    next_token: str | None = None


#: `token -> Page`; ilk cagri `None` ile. Gercek ag istemcisi bunu disaridan saglar.
PageSource = Callable[[str | None], Page]


class JsonPagesAdapter(BaseAdapter):
    """Sayfalanmis JSON API. Imlec: `{"page": token, "skip": n}` ya da `{"done": True}`."""

    def __init__(
        self,
        platform: str,
        mapping: FieldMapping,
        page_source: PageSource,
        *,
        offer_key_scheme: OfferKeyScheme = "listing",
        observed_at: datetime | Clock | None = None,
    ) -> None:
        super().__init__(
            platform,
            mapping,
            kind="api",
            offer_key_scheme=offer_key_scheme,
            observed_at=observed_at,
        )
        self.page_source = page_source

    def _load(self, token: str | None) -> Page:
        try:
            return self.page_source(token)
        except SourceUnavailable:
            raise
        except Exception as exc:
            raise SourceUnavailable("page_fetch_failed", type(exc).__name__) from exc

    def fetch(self, checkpoint: Checkpoint | None = None) -> Iterator[CanonicalListing | Rejection]:
        cursor = dict(checkpoint.cursor) if checkpoint and checkpoint.cursor else {}
        processed = checkpoint.processed if checkpoint else 0
        skip = cursor.get("skip", 0)
        if cursor.get("done"):
            self.checkpoint = Checkpoint({"done": True}, processed)
            return
        if isinstance(skip, bool) or not isinstance(skip, int) or skip < 0:
            raise SourceUnavailable("bad_checkpoint", "skip gecersiz")
        token = cursor.get("page")
        if token is not None and not isinstance(token, str):
            raise SourceUnavailable("bad_checkpoint", "page gecersiz")
        observed_at = self._clock()
        self.checkpoint = Checkpoint(cursor, processed)
        seen_tokens: set[str | None] = set()
        while True:
            if token in seen_tokens:
                raise SourceUnavailable("page_cycle", "ayni sayfa belirteci tekrar geldi")
            seen_tokens.add(token)
            page = self._load(token)
            if not isinstance(page.records, Sequence):
                raise SourceUnavailable("page_schema", "records dizi degil")
            label = token if token is not None else "first"
            total = len(page.records)
            for index in range(skip, total):
                raw = page.records[index]
                ref = f"page:{label}#{index}"
                item = (
                    self._convert(raw, ref, observed_at)
                    if isinstance(raw, Mapping)
                    else Rejection("record_not_object", ref)
                )
                processed += 1
                if index + 1 < total:
                    self.checkpoint = Checkpoint({"page": token, "skip": index + 1}, processed)
                elif page.next_token is None:
                    self.checkpoint = Checkpoint({"done": True}, processed)
                else:
                    self.checkpoint = Checkpoint({"page": page.next_token, "skip": 0}, processed)
                yield item
            if page.next_token is None:
                self.checkpoint = Checkpoint({"done": True}, processed)
                return
            token, skip = page.next_token, 0


def _open_text(path: Path, encoding: str):
    try:
        return path.open("r", encoding=encoding, newline="")
    except OSError as exc:
        raise SourceUnavailable("file_unreadable", type(exc).__name__) from exc


class JsonFileAdapter(BaseAdapter):
    """JSON dizi (ya da `records_path` altindaki dizi) veya NDJSON. Imlec: kayit sirasi."""

    def __init__(
        self,
        platform: str,
        mapping: FieldMapping,
        path: str | Path,
        *,
        records_path: str | None = None,
        encoding: str = "utf-8-sig",
        offer_key_scheme: OfferKeyScheme = "listing",
        observed_at: datetime | Clock | None = None,
    ) -> None:
        super().__init__(
            platform,
            mapping,
            kind="json",
            offer_key_scheme=offer_key_scheme,
            observed_at=observed_at,
        )
        self.path = Path(path)
        self.records_path = records_path
        self.encoding = encoding

    def _records(self) -> Iterator[tuple[str, Any]]:
        try:
            with _open_text(self.path, self.encoding) as handle:
                first = ""
                while not first:
                    chunk = handle.readline()
                    if not chunk:
                        raise SourceUnavailable("json_empty", self.path.name)
                    first = chunk.strip()
                handle.seek(0)
                if first.startswith("[") or self.records_path is not None:
                    yield from self._document(handle)
                else:
                    yield from self._ndjson(handle)
        except UnicodeDecodeError as exc:
            raise SourceUnavailable("file_unreadable", "encoding") from exc

    def _document(self, handle: Any) -> Iterator[tuple[str, Any]]:
        handle.seek(0)
        try:
            data = json.load(handle)
        except json.JSONDecodeError as exc:
            raise SourceUnavailable("json_invalid", f"satir {exc.lineno}") from exc
        if self.records_path:
            data = get_value(data, self.records_path) if isinstance(data, Mapping) else None
        if not isinstance(data, list):
            raise SourceUnavailable("json_schema", "kayit dizisi bulunamadi")
        for index, raw in enumerate(data):
            yield f"{self.path.name}[{index}]", raw

    def _ndjson(self, handle: Any) -> Iterator[tuple[str, Any]]:
        handle.seek(0)
        for line_no, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            ref = f"{self.path.name}:{line_no}"
            try:
                yield ref, json.loads(line)
            except json.JSONDecodeError:
                yield ref, Rejection("invalid_json_line", ref)

    def fetch(self, checkpoint: Checkpoint | None = None) -> Iterator[CanonicalListing | Rejection]:
        return self._emit_offsets(self._records(), checkpoint)


class CsvAdapter(BaseAdapter):
    """CSV. Zorunlu sutunlar (kimlik/baslik/adres) yoksa kaynak erisilemez sayilir."""

    def __init__(
        self,
        platform: str,
        mapping: FieldMapping,
        path: str | Path,
        *,
        delimiter: str = ";",
        encoding: str = "utf-8-sig",
        offer_key_scheme: OfferKeyScheme = "listing",
        observed_at: datetime | Clock | None = None,
    ) -> None:
        super().__init__(
            platform,
            mapping,
            kind="csv",
            offer_key_scheme=offer_key_scheme,
            observed_at=observed_at,
        )
        self.path = Path(path)
        self.delimiter = delimiter
        self.encoding = encoding

    def _records(self) -> Iterator[tuple[str, Any]]:
        try:
            with _open_text(self.path, self.encoding) as handle:
                reader = csv.DictReader(handle, delimiter=self.delimiter)
                header = reader.fieldnames
                if not header:
                    raise SourceUnavailable("csv_empty", self.path.name)
                missing = [p for p in self.mapping.required_paths() if p not in header]
                if missing:
                    raise SourceUnavailable("csv_missing_columns", ",".join(missing))
                for index, row in enumerate(reader, start=1):
                    row.pop(None, None)  # fazla sutunlar (restkey)
                    yield f"{self.path.name}:row{index}", row
        except UnicodeDecodeError as exc:
            raise SourceUnavailable("file_unreadable", "encoding") from exc
        except csv.Error as exc:
            raise SourceUnavailable("csv_invalid", str(exc)[:80]) from exc

    def fetch(self, checkpoint: Checkpoint | None = None) -> Iterator[CanonicalListing | Rejection]:
        return self._emit_offsets(self._records(), checkpoint)


def _flatten(element: ElementTree.Element) -> dict[str, Any]:
    """Cocuklari alan sozlugune cevirir: tekrarlayan etiket -> liste, ic ice -> sozluk.

    `g:id` ve `id` ikisi de taninir (bkz. collect/sources/xml_feed.py).
    """
    fields: dict[str, Any] = {}
    for child in element:
        value: Any = _flatten(child) if len(child) else (child.text or "").strip()
        if value in ("", {}):
            continue
        for name in _field_names(child.tag):
            current = fields.get(name)
            if current is None:
                fields[name] = value
            elif isinstance(current, list):
                current.append(value)
            else:
                fields[name] = [current, value]
    return fields


class XmlAdapter(BaseAdapter):
    """XML besleme (`iterparse`). Imlec: kayit sirasi."""

    def __init__(
        self,
        platform: str,
        mapping: FieldMapping,
        path: str | Path,
        *,
        record_path: str = DEFAULT_RECORD_PATH,
        offer_key_scheme: OfferKeyScheme = "listing",
        observed_at: datetime | Clock | None = None,
    ) -> None:
        super().__init__(
            platform,
            mapping,
            kind="xml",
            offer_key_scheme=offer_key_scheme,
            observed_at=observed_at,
        )
        self.path = Path(path)
        self.record_tag = record_path.rstrip("/").rpartition("/")[2]

    def _records(self) -> Iterator[tuple[str, Any]]:
        try:
            stream = self.path.open("rb")
        except OSError as exc:
            raise SourceUnavailable("file_unreadable", type(exc).__name__) from exc
        count = 0
        try:
            for _event, element in ElementTree.iterparse(stream, events=("end",)):
                if _local_name(element.tag) != self.record_tag:
                    continue
                count += 1
                yield f"{self.record_tag}[{count}]", _flatten(element)
                element.clear()
        except ElementTree.ParseError as exc:
            raise SourceUnavailable("xml_invalid", str(exc)[:80]) from exc
        finally:
            stream.close()
        if count == 0:
            raise SourceUnavailable("xml_no_records", self.record_tag)

    def fetch(self, checkpoint: Checkpoint | None = None) -> Iterator[CanonicalListing | Rejection]:
        return self._emit_offsets(self._records(), checkpoint)
