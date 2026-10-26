"""Besleme dosyasinin YAZMADAN ONCE butunluk denetimi (karar 0152).

26 Ekim 2026: AliExpress beslemesi kapanis etiketi olmadan, belgenin ~%34'unde bitti.
Indirme katmani (HTTP, gzip) hata vermedi; eksiklik ancak ayristirma sonunda, 896.842
kayit COK ONCE yazildiktan sonra goruldu. Bu modul dosyayi veritabanina HICBIR SEY
yazmadan tarar ve eksik belgeyi reddeder.

Tarama diske ek yer ve bellege dosya buyuklugu kadar yer gerektirmez: sikistirmasi
cozulmus akis 1 MiB bloklarla okunur; tutulan yalniz kuyruk penceresi ve sayaclardir
(~1,5 MiB). 760 MB'lik gzip dosya tek gecis, CPU-bagimli (olcum PR gövdesinde).

Denetlenen (yalniz YAPISAL tamlik, kayit baska bir sey):

- sikistirilmis akis kesintisiz sona erdi (gzip/zip hatasi yok);
- her `<offer ...>` icin bir `</offer>` var (acik kalan kayit yok);
- son `</offer>`'dan sonra kapanis etiketi (`</offers>` ya da `</yml_catalog>`) var ve
  ondan sonra yalnizca bosluk/kapanis etiketi geliyor;
- en az bir kayit var.

Tek tek kayitlarin bozuklugu (ornegin 0x1E karakteri) BILEREK denetlenmez: karar 0114
bozuk kaydi `ingest_error`'a dusurup dosyayi surdurur; yoksa tek karakter tum katalogu
durdururdu. Kayit duzeyi bozukluk `max_reject_ratio` kapisinda kalir.
"""

from __future__ import annotations

import re
import zlib
from dataclasses import dataclass
from pathlib import Path

from feeds.parsers import FeedFormatError, open_decoded

BLOCK = 1 << 20
#: `<offer`+bosluk/`>` (7) ve `</offer>` (8) icin blok sinirinda ortuste kalan bayt.
_CARRY = 16
#: Kapanis etiketinin arandigi kuyruk (kapanis, girinti ve satir sonlari bunu asmaz).
_TAIL = 1 << 16

_OPEN = re.compile(rb"<offer[\s>]")
_CLOSE = b"</offer>"
_CLOSING = re.compile(rb"</offers\s*>|</yml_catalog\s*>")
#: Son kayittan sonra kapanis disinda yalniz bu gelebilir.
_TRAILER = re.compile(rb"^\s*(?:</[A-Za-z_][\w.-]*\s*>\s*)*$")

#: Bu bicimler icin tarama yapilir; baska bicimler (ndjson, toplayici) etkilenmez.
CHECKED_PARSERS = frozenset({"yml"})


@dataclass(frozen=True)
class IntegrityResult:
    ok: bool
    #: `truncated` | `empty` | `unreadable`; `ok` iken None.
    code: str | None
    detail: str
    #: Kapanan `<offer>` sayisi = dosyadaki TAM kayit sayisi.
    records: int = 0
    bytes_decoded: int = 0

    def summary(self) -> dict[str, object]:
        """`ingest_run`/`job_run` icin duz ozet (yol, adres, sir yok)."""
        return {
            "ok": self.ok,
            "code": self.code,
            "records": self.records,
            "bytes_decoded": self.bytes_decoded,
        }


def verify(path: Path, parser: str) -> IntegrityResult | None:
    """Desteklenen bicimde dosyayi tarar; desteklenmeyen bicimde None (denetim yok)."""
    if parser not in CHECKED_PARSERS:
        return None
    return _scan_yml(path)


def _scan_yml(path: Path) -> IntegrityResult:
    opened = 0
    closed = 0
    decoded = 0
    carry = b""
    tail = b""
    try:
        stream = open_decoded(path)
    except (FeedFormatError, OSError, zlib.error, EOFError) as error:
        return IntegrityResult(False, "unreadable", type(error).__name__)
    try:
        while True:
            try:
                block = stream.read(BLOCK)
            except (EOFError, zlib.error, OSError) as error:
                return IntegrityResult(
                    False,
                    "truncated",
                    f"sikistirilmis akis kesik: {type(error).__name__}",
                    closed,
                    decoded,
                )
            if not block:
                break
            decoded += len(block)
            data = carry + block
            # Yalnizca TAMAMI onceki blokta kalmayan eslesmeler sayilir (sinirda cift sayim yok).
            skip = len(carry)
            opened += sum(1 for m in _OPEN.finditer(data) if m.end() > skip)
            closed += data.count(_CLOSE) - carry.count(_CLOSE)
            carry = data[-_CARRY:]
            tail = (tail + block)[-_TAIL:]
    finally:
        stream.close()

    if closed == 0:
        return IntegrityResult(False, "empty", "dosyada kayit yok", 0, decoded)
    if opened != closed:
        return IntegrityResult(
            False,
            "truncated",
            f"acik kayit: {opened} acilis, {closed} kapanis",
            closed,
            decoded,
        )
    last = tail.rfind(_CLOSE)
    rest = tail[last + len(_CLOSE) :] if last >= 0 else b""
    closing = _CLOSING.search(rest)
    if closing is None or not _TRAILER.match(rest):
        return IntegrityResult(False, "truncated", "kapanis etiketi yok", closed, decoded)
    return IntegrityResult(True, None, "", closed, decoded)
