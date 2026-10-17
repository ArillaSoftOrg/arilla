"""Akisla ayristirma. Dosya bellege alinmaz; kayitlar tek tek uretilir.

Bicimler:

- **yml**: Yandex Market Language (Admitad/AliExpress beslemesi bu bicimde;
  `<yml_catalog><shop><categories>...<offers><offer id=..>`). Kategoriler
  tekliflerden once gelir; `categories` sozlugu ayristirma sirasinda dolar.
- **xml**: genel XML; `record_tag` ile secilen ogeler, alt ogelerin metni alan olur.
- **csv**: baslik satirli; ayrac ve kodlama yapilandirmadan.
- **ndjson**: satir basina bir JSON nesnesi.
- **json**: ust duzey dizi `[{...}, ...]`; parca parca cozulur.

Sikistirma ice bakarak bulunur: gzip (1f 8b) ve ZIP (PK 03 04, ilk dosya).

`ParseResult.complete`: dosya sonuna HATASIZ ulasildi mi. Kesik/bozuk dosyada
False kalir; tamlik kapisi bunu kullanir (kismi besleme katalogu pasiflestirmez).
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import re
import zipfile
import zlib
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any
from xml.etree.ElementTree import ParseError, fromstring, iterparse
from xml.sax.saxutils import unescape

FORMATS = frozenset({"yml", "xml", "csv", "ndjson", "json"})


@dataclass
class FeedRecord:
    """Kaynaktan gelen tek kayit; alan adlari KAYNAGA aittir."""

    fields: dict[str, Any]
    #: Kayit sirasi (0 tabanli) ve kaynak konumu; hata ayiklama icin.
    index: int
    ref: str


@dataclass
class ParseResult:
    """Ayristirma sirasinda dolan durum (uretec tukenince kesinlesir)."""

    complete: bool = False
    #: YML: kategori kimligi -> (ad, ust kimlik).
    categories: dict[str, tuple[str, str | None]] = field(default_factory=dict)
    error: str | None = None


class FeedFormatError(Exception):
    """Dosya bicimi beklenenden farkli (yapilandirma ya da kaynak hatasi)."""


class _Owning(io.RawIOBase):
    """Ic akisi okur; kapatilinca ic akisla birlikte sahip oldugu tutamaclari da kapatir.

    `gzip.GzipFile(fileobj=...)` ve `ZipFile.open()` alttaki dosyayi kapatmaz;
    erken birakilan (ornek kipi) ayristirmada tutamac acik kalirdi.
    """

    def __init__(self, inner: IO[bytes], *owned: Any) -> None:
        self._inner = inner
        self._owned = owned

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        data = self._inner.read(len(buffer))
        size = len(data)
        buffer[:size] = data
        return size

    def close(self) -> None:
        if not self.closed:
            for handle in (self._inner, *self._owned):
                handle.close()
        super().close()


def open_decoded(path: Path) -> IO[bytes]:
    """Dosyayi sikistirmasi cozulmus ikili akis olarak acar. Kapatmak her seyi kapatir."""
    raw = path.open("rb")
    magic = raw.read(4)
    raw.seek(0)
    try:
        if magic[:2] == b"\x1f\x8b":
            inner: IO[bytes] = gzip.GzipFile(fileobj=raw)  # type: ignore[assignment]
            return io.BufferedReader(_Owning(inner, raw), 1 << 16)  # type: ignore[return-value]
        if magic == b"PK\x03\x04":
            archive = zipfile.ZipFile(raw)
            names = [info for info in archive.infolist() if not info.is_dir()]
            if not names:
                raise FeedFormatError("ZIP arsivi bos")
            member = archive.open(names[0])
            return io.BufferedReader(_Owning(member, archive, raw), 1 << 16)  # type: ignore[return-value]
    except Exception:
        raw.close()
        raise
    return raw


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


#: Bozuk tek kaydin isareti: normalizasyon bunu `malformed_xml` olarak reddeder.
MALFORMED = "__malformed__"

_OFFER_OPEN = re.compile(rb"<offer[\s>]")
_OFFER_CLOSE = b"</offer>"
_CLOSING = re.compile(rb"</offers\s*>|</yml_catalog\s*>")
_ENCODING = re.compile(rb"""<\?xml[^>]*encoding=["']([A-Za-z0-9._-]+)["']""")
#: Kategori etiketi: oznitelik SIRASINDAN bagimsiz (`parentId` once gelebilir, baska oznitelik
#: olabilir). Agac kaybolursa `category_raw` cozulmemis kimlik olarak kalir (karar 0133).
_CATEGORY = re.compile(rb"<category(\s[^>]*)?>(.*?)</category>", re.S)
_CATEGORY_ID = re.compile(rb"""\sid=["']([^"']+)["']""")
_CATEGORY_PARENT = re.compile(rb"""\sparentId=["']([^"']+)["']""")
_OFFER_ID = re.compile(rb"""<offer[^>]*\sid=["']([^"']{1,200})["']""")
#: Kucuk blok: kesik sikistirilmis akista gzip son okumanin verisini atar; kayip <= 64 KB.
_BLOCK = 1 << 16
#: XML 1.0'da GECERSIZ kontrol karakterleri -> bosluk. Gercek AliExpress beslemesinde
#: bir urun adindaki 0x1E tum dosyayi durduruyordu (karar 0114). UTF-8 cok baytli
#: karakterler bu baytlari icermez; donusum guvenlidir.
_INVALID_XML_BYTES = bytes.maketrans(
    bytes([*range(0x00, 0x09), 0x0B, 0x0C, *range(0x0E, 0x20)]), b" " * 29
)
#: Tek bir kaydin ust siniri: kapanmayan dev bir parca bellegi buyutmesin.
_MAX_RECORD_BYTES = 4 << 20


def _offer_fields(elem: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {f"@{k}": v for k, v in elem.attrib.items()}
    params: dict[str, str] = {}
    for child in elem:
        ctag = _local(child.tag)
        text = (child.text or "").strip()
        if ctag == "param":
            name = child.get("name")
            if name and text:
                params[name] = text
        elif ctag == "picture":
            if text:
                fields.setdefault("picture", []).append(text)
        elif text:
            fields[ctag] = text
    if params:
        fields["param"] = params
    return fields


def _yml(stream: IO[bytes], result: ParseResult) -> Iterator[FeedRecord]:
    """YML'i KAYIT KAYIT ayristirir (karar 0114).

    Gercek AliExpress beslemesinde tek bir bozuk karakter (8,5 milyonuncu satir)
    standart akis ayristiricisini durdurup tum dosyayi "kesik" yapiyordu: tam
    senkronizasyon hic tamamlanamiyordu. Burada her `<offer>` ayri ayristirilir;
    bozuk kayit `MALFORMED` isaretiyle uretilir (hata kaydina duser), dosya devam
    eder. Dosya yalnizca kapanis etiketi goruldugunde `complete` sayilir.
    """
    index = 0
    buffer = b""
    header_done = False
    encoding = "utf-8"
    declaration = b""
    closed = False
    stream_error: BaseException | None = None
    while True:
        try:
            block = stream.read(_BLOCK)
        except (EOFError, zlib.error, OSError) as error:
            # Kesik sikistirilmis akis: tamponda kalan TAM kayitlar yine islenir,
            # dosya sonra "kesik" sayilir.
            block, stream_error = b"", error
        eof = not block
        buffer += block
        if not header_done:
            first = _OFFER_OPEN.search(buffer)
            if first is None and not eof and len(buffer) < 64 << 20:
                continue
            header = buffer[: first.start()] if first else buffer
            found = _ENCODING.search(header[:200])
            if found:
                encoding = found.group(1).decode("ascii")
                declaration = f'<?xml version="1.0" encoding="{encoding}"?>'.encode("ascii")
            for attrs, name in _CATEGORY.findall(header):
                found_id = _CATEGORY_ID.search(b" " + attrs)
                if found_id is None:
                    continue
                cid = found_id.group(1)
                found_parent = _CATEGORY_PARENT.search(b" " + attrs)
                parent = found_parent.group(1) if found_parent else b""
                text = name.decode(encoding, "replace").strip()
                text = unescape(text, {"&quot;": '"', "&apos;": "'", "&#39;": "'"})
                result.categories[cid.decode(encoding, "replace")] = (
                    text,
                    parent.decode(encoding, "replace") or None,
                )
            buffer = buffer[first.start() :] if first else b""
            header_done = True
        pos = 0
        #: Son tam kaydin bittigi yer: kapanis etiketi BURADAN sonra aranir
        #: (`pos` blok siniri icin geri cekilebilir; kapanis araligi kirpilmamali).
        last_end = 0
        while True:
            opening = _OFFER_OPEN.search(buffer, pos)
            if opening is None:
                # Blok siniri "<offer" etiketinin ortasina dusmus olabilir: son
                # birkac bayt bir sonraki bloga tasinir (kayit kaybolmasin).
                pos = max(pos, len(buffer) - 16)
                break
            close = buffer.find(_OFFER_CLOSE, opening.start())
            if close < 0:
                if len(buffer) - opening.start() > _MAX_RECORD_BYTES:
                    raise FeedFormatError("kapanmayan kayit (4 MiB ustu)")
                pos = opening.start()
                break
            end = close + len(_OFFER_CLOSE)
            fragment = buffer[opening.start() : end]
            pos = end
            last_end = end
            try:
                fields = _offer_fields(
                    fromstring(declaration + fragment.translate(_INVALID_XML_BYTES))
                )
            except ParseError as error:
                ext = _OFFER_ID.search(fragment)
                fields = {MALFORMED: f"{type(error).__name__}: {error}"[:200]}
                if ext:
                    fields["@id"] = ext.group(1).decode(encoding, "replace")
            yield FeedRecord(fields, index, f"offer #{index + 1}")
            index += 1
        # Kapanis: son kayittan sonraki TUM aralikta aranir. Gercek dosya girintili ve
        # satir sonlu biter; sabit kuyruk penceresi bunu kaciriyordu (2,19 milyon
        # kayitlik gercek tam kosu "kesik" sayildi).
        if _CLOSING.search(buffer, last_end):
            closed = True
        # Tek kopya: islenmemis kisim tutulur (kayit basina kopya yok).
        buffer = buffer[pos:]
        if eof:
            break
        # Kayitlar arasi bosluk/etiket artiklari birikmesin.
        if _OFFER_OPEN.search(buffer) is None and len(buffer) > 1024:
            buffer = buffer[-1024:]
    if stream_error is not None:
        raise EOFError(f"sikistirilmis akis kesik: {type(stream_error).__name__}")
    if not closed:
        raise EOFError("besleme kapanis etiketi olmadan bitti")


def _xml(stream: IO[bytes], record_tag: str) -> Iterator[FeedRecord]:
    index = 0
    stack: list[Any] = []
    for event, elem in iterparse(stream, events=("start", "end")):
        if event == "start":
            stack.append(elem)
            continue
        stack.pop()
        if _local(elem.tag) != record_tag:
            continue
        fields: dict[str, Any] = {f"@{k}": v for k, v in elem.attrib.items()}
        for child in elem:
            text = (child.text or "").strip()
            if not text:
                continue
            key = _local(child.tag)
            if key in fields:
                existing = fields[key]
                fields[key] = [*existing, text] if isinstance(existing, list) else [existing, text]
            else:
                fields[key] = text
        yield FeedRecord(fields, index, f"{record_tag} #{index + 1}")
        index += 1
        elem.clear()
        if stack:
            stack[-1].remove(elem)


def _csv(stream: IO[bytes], config: dict[str, Any]) -> Iterator[FeedRecord]:
    text = io.TextIOWrapper(stream, encoding=config.get("encoding", "utf-8"), newline="")
    reader = csv.DictReader(text, delimiter=config.get("delimiter", ","))
    for index, row in enumerate(reader):
        fields = {k: v.strip() for k, v in row.items() if k is not None and v and v.strip()}
        yield FeedRecord(fields, index, f"satir {index + 2}")


def _ndjson(stream: IO[bytes]) -> Iterator[FeedRecord]:
    index = 0
    for lineno, line in enumerate(io.TextIOWrapper(stream, encoding="utf-8"), start=1):
        line = line.strip()
        if not line:
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise FeedFormatError(f"satir {lineno}: nesne degil")
        yield FeedRecord(value, index, f"satir {lineno}")
        index += 1


def _json_array(stream: IO[bytes], chunk_size: int = 1 << 16) -> Iterator[FeedRecord]:
    """Ust duzey diziyi parca parca cozer; tampon en fazla bir kayit + bir parca buyur."""
    decoder = json.JSONDecoder()
    text = io.TextIOWrapper(stream, encoding="utf-8")
    buffer = ""
    started = False
    index = 0
    eof = False
    while True:
        if not eof and len(buffer) < chunk_size:
            more = text.read(chunk_size)
            eof = more == ""
            buffer += more
        buffer = buffer.lstrip()
        if not started:
            if not buffer:
                if eof:
                    raise FeedFormatError("bos JSON")
                continue
            if buffer[0] != "[":
                raise FeedFormatError("JSON ust duzeyi dizi degil")
            buffer = buffer[1:]
            started = True
            continue
        if buffer.startswith(","):
            buffer = buffer[1:]
            continue
        if buffer.startswith("]"):
            return
        if not buffer:
            if eof:
                raise FeedFormatError("JSON dizisi kapanmadan bitti")
            continue
        try:
            value, end = decoder.raw_decode(buffer)
        except json.JSONDecodeError:
            if eof:
                raise FeedFormatError("JSON kaydi kesik") from None
            more = text.read(chunk_size)
            eof = more == ""
            buffer += more
            continue
        if not isinstance(value, dict):
            raise FeedFormatError(f"kayit {index + 1}: nesne degil")
        yield FeedRecord(value, index, f"kayit {index + 1}")
        index += 1
        buffer = buffer[end:]


def iter_records(
    path: Path, fmt: str, config: dict[str, Any] | None = None, result: ParseResult | None = None
) -> Iterator[FeedRecord]:
    """Dosyadaki kayitlari akitir. Sona hatasiz ulasilirsa `result.complete = True`."""
    if fmt not in FORMATS:
        raise FeedFormatError(f"desteklenmeyen bicim: {fmt}")
    config = config or {}
    result = result if result is not None else ParseResult()
    stream = open_decoded(path)
    try:
        if fmt == "yml":
            yield from _yml(stream, result)
        elif fmt == "xml":
            tag = config.get("record_tag")
            if not tag:
                raise FeedFormatError("xml bicimi icin record_tag gerekli")
            yield from _xml(stream, tag)
        elif fmt == "csv":
            yield from _csv(stream, config)
        elif fmt == "ndjson":
            yield from _ndjson(stream)
        else:
            yield from _json_array(stream)
        result.complete = True
    except (
        ParseError,
        EOFError,
        zipfile.BadZipFile,
        gzip.BadGzipFile,
        UnicodeDecodeError,
    ) as error:
        # Kesik gzip EOFError, kesik XML ParseError verir: dosya eksik.
        result.complete = False
        # Tur + konum (or. "ParseError: not well-formed (invalid token): line 1, column 9");
        # kaynak icerigi ya da adres icermez.
        result.error = f"{type(error).__name__}: {error}"[:200]
    except json.JSONDecodeError:
        result.complete = False
        result.error = "JSONDecodeError"
    except FeedFormatError as error:
        result.complete = False
        result.error = str(error)[:200]
    finally:
        stream.close()
