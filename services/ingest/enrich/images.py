"""Gorsel indirme, hash'leme, on isleme ve base64'e cevirme.

**Indirilen bayt hicbir yere yazilmaz.** Kalici olarak yalnizca SHA-256
hash'i (`offer.image_hash`) ve embedding vektoru saklanir. Bu, katalog
gorselleri icin gereksiz depolama olmadigi gibi, `docs/kvkk.md`'nin yuklenen
gorseller icin koydugu "ham dosya saklanmaz" cizgisiyle de ayni yonde.

On isleme (bkz. `docs/decisions/0028-embedding-on-isleme-ve-hiz-siniri.md`):
saglayici gorseli 512 px'lik karolara bolup karo basina token yaziyor. Tam
boy bir Shopify gorseli ~48.000 token tutarken uzun kenari 512 px'e
indirilmis ayni gorsel tek karodur. Kucultme burada, saglayicidan bagimsiz
yapilir; CDN'in `?width=` parametresine guvenilmez.

Kimlik: `sha256` **orijinal** baytlarin hash'idir, on islenmis ciktinin
degil. Hash icerigi tanimlar (ayni gorsel iki offer'da mi?); on isleme
surumu ayrica `PREPROCESS_VERSION` ile izlenir.
"""

from __future__ import annotations

import base64
import hashlib
import io
import logging
import math
import warnings
from dataclasses import dataclass
from datetime import datetime

import httpx
from PIL import Image, ImageOps, UnidentifiedImageError

logger = logging.getLogger(__name__)

#: Urun fotografi bundan buyukse bir seyler yanlis; indirmeyi kesiyoruz.
MAX_BYTES = 8 * 1024 * 1024
TIMEOUT = 30.0

#: Basliktaki tur bunlardan biri (ya da bos / genel ikili) olmali. Asil
#: kontrol basliga degil, baytlarin gercekten cozulmesine dayanir.
ALLOWED_TYPES = ("image/jpeg", "image/jpg", "image/png", "image/webp", "image/avif")
GENERIC_TYPES = ("application/octet-stream", "binary/octet-stream")

#: Pillow yalnizca bu cozuculeri dener. Sozlesme `ALLOWED_TYPES` ile ayni:
#: GIF, BMP, TIFF, SVG vb. reddedilir.
ALLOWED_FORMATS = ("JPEG", "PNG", "WEBP", "AVIF")

#: Hedef: uzun kenar en fazla bu kadar. Saglayicinin karo boyu 512; tam
#: 512 tek karo demek. Kucuk gorsel ASLA buyutulmez.
TARGET_LONG_EDGE = 512

#: Dekompresyon bombasi siniri. 8 MB'lik bir dosya ~25 MP'lik bir JPEG
#: olabilir; 40 MP cok comert. Baslik okunur okunmaz (piksel cozulmeden)
#: denetlenir.
MAX_SOURCE_PIXELS = 40_000_000

JPEG_QUALITY = 90

#: On isleme surumu. Kucultme kurali, cikti bicimi veya kalite degisirse
#: artirilir. Embedding satiri bunu tasimaz (kolon yok, migration istemiyoruz);
#: log ve CLI raporunda gorunur. Neden yeterli oldugu: karar 0028.
PREPROCESS_VERSION = "img512-v1"

#: Bundan ESKI gorsel embedding satirlari bayat sayilir: boru hatti onlari
#: yeniden secer, yerinde gunceller ve yineleme icin kullanmaz. `None` =
#: hicbir satir bayat degil. img512-v1 icin None: tam boy / CDN 512 / on
#: islenmis vektorler arasinda olculen kosinus ve siralama sonucu (karar
#: 0028) karisik bir katalogu kabul edilebilir kiliyor. On isleme ANLAMLI
#: degisirse `PREPROCESS_VERSION` ile birlikte dagitim anina (UTC) set edilir.
IMAGE_VECTORS_VALID_FROM: datetime | None = None

#: Saglayicinin karo boyu ve karo basina token'i — yalnizca TAHMIN icin.
#: Gercek sayi yanittaki `usage.total_tokens`'tan gelir ve hiz sinirlayici
#: tahmini onunla duzeltir.
TILE_EDGE = 512
TOKENS_PER_TILE = 4000


class ImageRejected(Exception):
    """Tek bir gorsel alinamadi. Kosuyu durdurmaz, sayilir."""


@dataclass(frozen=True)
class PreparedImage:
    #: Saglayiciya gonderilecek `data:` URL'i (JPEG ya da seffaflik varsa PNG).
    data_url: str
    width: int
    height: int
    source_width: int
    source_height: int


@dataclass(frozen=True)
class FetchedImage:
    #: ORIJINAL icerigin SHA-256'si — `offer.image_hash` bu.
    sha256: str
    #: Saglayiciya gonderilecek `data:` URL'i (on islenmis).
    data_url: str
    width: int = 0
    height: int = 0
    source_width: int = 0
    source_height: int = 0

    @property
    def estimated_tokens(self) -> int:
        return estimate_tokens(self.width, self.height)


def content_hash(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def to_data_url(payload: bytes, media_type: str) -> str:
    encoded = base64.b64encode(payload).decode("ascii")
    return f"data:{media_type};base64,{encoded}"


def estimate_tokens(width: int, height: int) -> int:
    """Karo basina sabit token varsayimiyla kaba tahmin."""
    if width <= 0 or height <= 0:
        return TOKENS_PER_TILE
    return TOKENS_PER_TILE * math.ceil(width / TILE_EDGE) * math.ceil(height / TILE_EDGE)


def target_size(width: int, height: int, long_edge: int = TARGET_LONG_EDGE) -> tuple[int, int]:
    """En-boy orani korunur, uzun kenar `long_edge`'i asmaz, buyutme yok."""
    longest = max(width, height)
    if longest <= long_edge:
        return width, height
    scale = long_edge / longest
    return max(1, round(width * scale)), max(1, round(height * scale))


def _has_real_alpha(image: Image.Image) -> bool:
    if image.mode in ("RGBA", "LA", "PA"):
        alpha = image.getchannel("A")
        low, _high = alpha.getextrema()
        return low < 255
    return False


def preprocess(payload: bytes) -> PreparedImage:
    """Baytlari gercekten cozer, yonunu duzeltir, kucultur, yeniden kodlar.

    Hata halinde `ImageRejected` — bozuk, desteklenmeyen ya da absurt boyutlu
    gorsel kosuyu durdurmaz.
    """
    try:
        with warnings.catch_warnings():
            # Pillow'un kendi bomba uyarisini hataya cevir; asil sinir asagida.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(payload), formats=ALLOWED_FORMATS)
            source_width, source_height = image.size
            if source_width <= 0 or source_height <= 0:
                raise ImageRejected("gecersiz boyut")
            if source_width * source_height > MAX_SOURCE_PIXELS:
                raise ImageRejected(
                    f"cok fazla piksel: {source_width}x{source_height} (sinir {MAX_SOURCE_PIXELS})"
                )

            # Animasyonlu WebP/PNG/AVIF: ilk kare.
            if getattr(image, "is_animated", False):
                image.seek(0)

            # JPEG'de DCT olcekleme: tam boy cozulmeden once 1/2-1/8'e iner.
            # Hedefin 2 kati istenir ki son kucultme kaliteli olsun; draft
            # hicbir zaman istenenden kucuk vermez. Dondurulmus boyut EXIF
            # dondurmesinden once oldugu icin kutu kare: iki yon de kapsanir.
            if image.format == "JPEG":
                box = TARGET_LONG_EDGE * 2
                image.draft("RGB", (box, box))

            image.load()
            image = ImageOps.exif_transpose(image)
    except ImageRejected:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError) as error:
        raise ImageRejected(f"gorsel cozulemedi: {type(error).__name__}") from error
    except Image.DecompressionBombWarning as error:
        raise ImageRejected("dekompresyon bombasi") from error
    except (OSError, ValueError, SyntaxError, EOFError) as error:
        raise ImageRejected(f"gorsel cozulemedi: {error}") from error

    if image.mode == "P":
        image = image.convert("RGBA" if "transparency" in image.info else "RGB")
    keep_alpha = _has_real_alpha(image)
    image = image.convert("RGBA" if keep_alpha else "RGB")

    width, height = target_size(*image.size)
    if (width, height) != image.size:
        image = image.resize((width, height), Image.Resampling.LANCZOS)

    out = io.BytesIO()
    if keep_alpha:
        image.save(out, format="PNG", optimize=True)
        media_type = "image/png"
    else:
        image.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        media_type = "image/jpeg"

    return PreparedImage(
        data_url=to_data_url(out.getvalue(), media_type),
        width=width,
        height=height,
        source_width=source_width,
        source_height=source_height,
    )


def fetch(url: str, client: httpx.Client) -> FetchedImage:
    if not url.startswith(("http://", "https://")):
        raise ImageRejected(f"desteklenmeyen sema: {url[:40]!r}")

    try:
        # Akis olarak okunur: govde MAX_BYTES'i asar asmaz kesilir, 8 MB'den
        # buyuk bir yanit hicbir zaman bellege tam alinmaz.
        with client.stream("GET", url, follow_redirects=True, timeout=TIMEOUT) as response:
            if response.status_code != 200:
                raise ImageRejected(f"HTTP {response.status_code}")

            header = response.headers.get("content-type") or ""
            media_type = header.split(";")[0].strip().lower()
            if media_type and media_type not in ALLOWED_TYPES + GENERIC_TYPES:
                raise ImageRejected(f"gorsel degil: {media_type}")

            declared = response.headers.get("content-length") or ""
            if declared.isdigit() and int(declared) > MAX_BYTES:
                raise ImageRejected(f"cok buyuk: {declared} bayt")

            buffer = bytearray()
            for chunk in response.iter_bytes():
                buffer.extend(chunk)
                if len(buffer) > MAX_BYTES:
                    raise ImageRejected(f"cok buyuk: {MAX_BYTES} bayti asti")
    except httpx.HTTPError as error:
        raise ImageRejected(f"indirilemedi: {error}") from error

    payload = bytes(buffer)
    if not payload:
        raise ImageRejected("bos govde")

    prepared = preprocess(payload)
    return FetchedImage(
        sha256=content_hash(payload),
        data_url=prepared.data_url,
        width=prepared.width,
        height=prepared.height,
        source_width=prepared.source_width,
        source_height=prepared.source_height,
    )
