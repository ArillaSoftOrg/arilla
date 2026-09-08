"""XML feed tasimasi.

Tek GET, tam dokum, sayfalama yok. `iterparse` ile akitilir: buyuk bir feed
bellege alinmadan islenir. lxml BAGIMLILIGI YOK — stdlib yeterli.

Namespace'li etiketler (`g:id` gibi) hem on ek hem sade adla eslestirilir,
cunku feed'ler ikisini de kullaniyor.
"""

from __future__ import annotations

import io
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO
from xml.etree import ElementTree

import httpx

from collect.connector import Connector, register
from collect.records import RawRecord

#: `<channel><item>` gibi bir yol; kaydin kendisi hangi dugum.
DEFAULT_RECORD_PATH = "channel/item"


def _local_name(tag: str) -> str:
    """'{http://base.google.com/ns/1.0}id' -> 'id'."""
    return tag.rpartition("}")[2] if "}" in tag else tag


def _field_names(tag: str) -> tuple[str, ...]:
    """Bir etiket icin kabul edilen alan adlari.

    Hem 'g:id' hem 'id' yazan feed'ler var; ikisini de tanimak her merchant
    icin ayri esleme yazma zorunlulugunu kaldirir.
    """
    local = _local_name(tag)
    return (local, f"g:{local}") if "}" in tag else (local,)


def _flatten(element: ElementTree.Element) -> dict[str, str]:
    """Bir dugumun dogrudan cocuklarini duz alan sozlugune cevirir."""
    fields: dict[str, str] = {}
    for child in element:
        text = (child.text or "").strip()
        if not text:
            continue
        for name in _field_names(child.tag):
            fields.setdefault(name, text)
    return fields


@dataclass
class XmlFeedConnector(Connector):
    source: str | Path
    config: dict[str, Any] = field(default_factory=dict)
    client: httpx.Client | None = None

    @property
    def _transport(self) -> dict[str, Any]:
        return self.config.get("transport") or {}

    @property
    def record_tag(self) -> str:
        path = self._transport.get("record_path", DEFAULT_RECORD_PATH)
        return str(path).rstrip("/").rpartition("/")[2]

    @property
    def group_tags(self) -> set[str]:
        """Varyant gibi tekrarli yapilarin kapsayici etiketleri."""
        variants = ((self.config.get("mapping") or {}).get("variants") or {}).get("path")
        return {str(variants)} if variants else set()

    def _open(self) -> BinaryIO:
        source = str(self.source)
        if source.startswith(("http://", "https://")):
            client = self.client or httpx.Client(timeout=60.0, follow_redirects=True)
            response = client.get(source)
            response.raise_for_status()
            return io.BytesIO(response.content)
        return Path(source).open("rb")

    def fetch(self) -> Iterator[RawRecord]:
        target = self.record_tag
        groups_wanted = self.group_tags
        index = 0
        stream = self._open()
        try:
            for _event, element in ElementTree.iterparse(stream, events=("end",)):
                if _local_name(element.tag) != target:
                    continue
                index += 1

                fields = _flatten(element)
                groups: dict[str, tuple[dict[str, str], ...]] = {}
                for child in element:
                    local = _local_name(child.tag)
                    if local in groups_wanted or f"g:{local}" in groups_wanted:
                        entries = tuple(_flatten(entry) for entry in child)
                        for name in _field_names(child.tag):
                            groups.setdefault(name, entries)

                yield RawRecord(
                    fields=fields,
                    source_ref=f"{target}[{index}]",
                    groups=groups,
                )
                # Islenen dugumu birak: akisin bellek kullanimi sabit kalir.
                element.clear()
        finally:
            stream.close()


register("xml_feed", lambda url, config: XmlFeedConnector(source=url or "", config=config))
