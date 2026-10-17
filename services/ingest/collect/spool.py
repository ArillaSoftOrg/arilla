"""Normalize edilmis tekliflerin disk tamponu (Faz 3).

Toplama kosusu kaynak taramasini (HTTP, tarama gecikmesi, geri cekilme) veritabani
islemi ACIK DEGILKEN yapar; teklifler buraya yazilir, tarama bitince tek islemde
partiler halinde veritabanina aktarilir. Boylece:

- islem kaynak beklerken acik kalmaz (`idle_in_transaction_session_timeout`, kilit),
- kosu hala "ya hepsi ya hic"tir (hata/ret: hicbir yazim kalici degil),
- bellek katalog buyuklugunden bagimsizdir: en fazla bir parti bellekte tutulur.

Dosya islem sonunda kendiliginden silinir (`tempfile.TemporaryFile`). Icerik
magazanin herkese acik urun verisidir; kisisel veri yok.
"""

from __future__ import annotations

import pickle
import tempfile
from collections.abc import Iterator

from collect.records import NormalizedOffer


class OfferSpool:
    """Sirayi koruyan, parti parti okunan teklif tamponu."""

    def __init__(self, batch_size: int) -> None:
        if batch_size < 1:
            raise ValueError("batch_size >= 1 olmali")
        self.batch_size = batch_size
        self._file = tempfile.TemporaryFile()  # noqa: SIM115 — omru nesneye bagli, close() kapatir
        self._pending: list[NormalizedOffer] = []
        self.count = 0

    def add(self, offer: NormalizedOffer) -> None:
        self._pending.append(offer)
        self.count += 1
        if len(self._pending) >= self.batch_size:
            self._flush()

    def _flush(self) -> None:
        if self._pending:
            pickle.dump(self._pending, self._file, protocol=pickle.HIGHEST_PROTOCOL)
            self._pending = []

    def batches(self) -> Iterator[list[NormalizedOffer]]:
        """Yazilan sirayla partiler; tek seferlik okunur."""
        self._flush()
        self._file.seek(0)
        while True:
            try:
                yield pickle.load(self._file)  # noqa: S301 — kendi yazdigimiz gecici dosya
            except EOFError:
                return

    def close(self) -> None:
        self._file.close()

    def __enter__(self) -> OfferSpool:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
