"""Affiliate ag dokumu tasimasi (Admitad, Awin, Impact, ...).

Burada YALNIZCA dokum mekanigi vardir: indirme, gzip acma, karakter
kodlamasi, ayrac, akitma. **Hicbir agin alan semasi bu dosyada yoktur ve
olmayacaktir.** Kolon adlari `feed_config.mapping` icinden gelir.

Sebep: elimizde gercek bir dokum yok. Public dokumandan tahmin edilen kolon
adlari, dogrulanmamis bir varsayimi koda gomerdi ve ilk gercek dokum geldiginde
sessizce yanlis eslesirdi. Publisher olarak kabul edilip gercek dosya elimize
gectiginde yapilacak sey bir config satiri yazmaktir.
"""

from __future__ import annotations

import csv
import gzip
import io
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO

import httpx

from collect.connector import Connector, register
from collect.records import RawRecord
from collect.sources.xml_feed import XmlFeedConnector


@dataclass
class NetworkDumpConnector(Connector):
    source: str | Path
    config: dict[str, Any] = field(default_factory=dict)
    client: httpx.Client | None = None

    @property
    def _transport(self) -> dict[str, Any]:
        return self.config.get("transport") or {}

    def _open(self) -> BinaryIO:
        source = str(self.source)
        if source.startswith(("http://", "https://")):
            client = self.client or httpx.Client(timeout=120.0, follow_redirects=True)
            response = client.get(source)
            response.raise_for_status()
            stream: BinaryIO = io.BytesIO(response.content)
        else:
            # Akis fetch() icindeki finally blogunda kapatilir; context manager
            # burada kullanilamaz cunku stream disariya donuyor.
            stream = Path(source).open("rb")  # noqa: SIM115

        if self._transport.get("gzip") or str(source).endswith(".gz"):
            return gzip.GzipFile(fileobj=stream)  # type: ignore[return-value]
        return stream

    def fetch(self) -> Iterator[RawRecord]:
        transport = self._transport
        # Dokum XML de olabilir; o zaman XML tasimasini oldugu gibi kullaniriz.
        if transport.get("format") == "xml":
            yield from XmlFeedConnector(
                source=self.source, config=self.config, client=self.client
            ).fetch()
            return

        encoding = transport.get("encoding", "utf-8")
        delimiter = transport.get("delimiter", ",")
        stream = self._open()
        try:
            text = io.TextIOWrapper(stream, encoding=encoding, newline="")
            reader = csv.DictReader(text, delimiter=delimiter)
            for index, row in enumerate(reader, start=1):
                fields = {
                    key: value.strip()
                    for key, value in row.items()
                    if key is not None and value is not None and value.strip()
                }
                if not fields:
                    continue
                yield RawRecord(fields=fields, source_ref=f"satir {index}")
        finally:
            stream.close()


register(
    "affiliate_network",
    lambda url, config: NetworkDumpConnector(source=url or "", config=config),
)
