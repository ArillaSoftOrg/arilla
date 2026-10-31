"""Adapter ortak govdesi: eslemeyi uygular, anahtar semasini dogrular, kontrol noktasi tutar.

Kontrol noktasi: `adapter.checkpoint`, SON verilen ogeden SONRAKI konumu gosterir. Kosu bir
ogeyi tukettikten sonra `adapter.checkpoint`'i saklar; `fetch(checkpoint)` oradan devam eder.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator, Mapping
from datetime import UTC, datetime
from typing import Any

from platforms.adapters.mapping import FieldMapping, map_record
from platforms.contract import (
    CanonicalListing,
    Checkpoint,
    OfferKeyScheme,
    Rejection,
    SourceKind,
    offer_key,
)

Clock = Callable[[], datetime]


class SourceUnavailable(Exception):
    """Kaynagin TAMAMI okunamiyor (dosya, sema, kimlik, ag). Kosu o kaynakta durur."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


def resolve_clock(observed_at: datetime | Clock | None) -> Clock:
    if observed_at is None:
        return lambda: datetime.now(UTC)
    if isinstance(observed_at, datetime):
        if observed_at.tzinfo is None:
            raise ValueError("observed_at saat dilimli olmali")
        fixed = observed_at
        return lambda: fixed
    return observed_at


class BaseAdapter:
    platform: str
    kind: SourceKind

    def __init__(
        self,
        platform: str,
        mapping: FieldMapping,
        *,
        kind: SourceKind,
        offer_key_scheme: OfferKeyScheme = "listing",
        observed_at: datetime | Clock | None = None,
    ) -> None:
        self.platform = platform
        self.kind = kind
        self.mapping = mapping
        self.offer_key_scheme = offer_key_scheme
        self._clock = resolve_clock(observed_at)
        #: Son verilen ogeden sonraki konum (bkz. modul aciklamasi).
        self.checkpoint = Checkpoint()

    def _convert(
        self, raw: Mapping[str, Any], source_ref: str, observed_at: datetime
    ) -> CanonicalListing | Rejection:
        result = map_record(raw, self.mapping, self.platform, observed_at, source_ref)
        if isinstance(result, Rejection):
            return result
        try:
            offer_key(self.offer_key_scheme, result.listing_id, result.seller_id)
        except ValueError:
            code = "missing_seller_id" if result.seller_id is None else "bad_seller_id"
            return Rejection(code, source_ref, self.offer_key_scheme)
        return result

    def _emit_offsets(
        self,
        records: Iterable[tuple[str, Any]],
        checkpoint: Checkpoint | None,
    ) -> Iterator[CanonicalListing | Rejection]:
        """Sirali kaynak: ilk `offset` kayit atlanir; her ogeden sonra kontrol noktasi ilerler."""
        start = offset_of(checkpoint)
        observed_at = self._clock()
        self.checkpoint = Checkpoint({"offset": start}, start)
        for index, (ref, raw) in enumerate(records):
            if index < start:
                continue
            item: CanonicalListing | Rejection
            if isinstance(raw, Rejection):
                item = raw
            elif not isinstance(raw, Mapping):
                item = Rejection("record_not_object", ref)
            else:
                item = self._convert(raw, ref, observed_at)
            self.checkpoint = Checkpoint({"offset": index + 1}, index + 1)
            yield item


def offset_of(checkpoint: Checkpoint | None) -> int:
    if checkpoint is None or not checkpoint.cursor:
        return 0
    value = checkpoint.cursor.get("offset")
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SourceUnavailable("bad_checkpoint", "offset gecersiz")
    return value
