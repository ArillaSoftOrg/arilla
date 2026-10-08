"""Offer gorsellerinin ayiklanmasi ve gosterim secimi (karar 0073).

Saf fonksiyonlar: ag yok, veritabani yok, model yok. Ayni girdi her zaman
ayni cikti verir.

Iki kavram AYRIDIR:

- `source_position`: kaynagin (magaza/feed) verdigi sira, ayiklamadan sonra
  0-tabanli. Kaynakta en fazla `MAX_SOURCE_IMAGES` gorsel saklanir.
- `display_rank`: kullaniciya gosterilecek sira. En fazla `MAX_DISPLAY_IMAGES`
  gorsele verilir; digerleri saklanir ama gosterilmez (`None`).

Ilke: URL/metadata'dan GUVENILIR biclimde anlasilamayan bir gorsel atilmaz.
Model/duz-urun ayrimi icin guvenilir metadata yoktur (alt metin bos ya da urun
adi, `variant_ids` cogu urunde bos); bu yuzden magazanin kendi sirasi esas alinir.
Eleme yalniz guclu isaretlere dayanir (bkz. `_EXCLUDED_*`). Elemenin tek bir
gorseli birakmadigi durumda eleme geri alinir: gercek urun gorselini tahminle
silmektense yer tutucuyu gostermek daha az kotudur.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

#: Kaynakta saklanan en fazla gorsel (offer basina).
MAX_SOURCE_IMAGES = 6
#: Kullaniciya gosterilen en fazla gorsel (urun detay galerisi).
#: Okuma tarafindaki karsiligi `packages/core/src/media/gallery-config.ts`;
#: ikisinin esitligini `gallery-config.test.ts` dogrular.
MAX_DISPLAY_IMAGES = 3

MAX_URL_LENGTH = 2048
#: Bu degerin altindaki (en uzun kenar) gorsel kucuk resim/ikon sayilir; yalniz
#: kaynak boyutu AÇIKÇA verdiginde uygulanir.
MIN_USEFUL_EDGE_PX = 100

#: Gorseli degistirmeyen surum/onbellek parametreleri: ayni gorsel sayilir.
_VERSION_PARAMS = frozenset({"v", "ver", "version", "t", "ts", "timestamp", "cb", "cachebuster"})
#: Yalnizca Shopify CDN'inde yeniden boyutlandirma parametreleri.
_SHOPIFY_SIZE_PARAMS = frozenset({"width", "height", "crop", "scale", "w", "h"})
_SHOPIFY_SUFFIX = re.compile(
    r"_(?:pico|icon|thumb|small|compact|medium|large|grande|original|master|\d*x\d*)(?:@\dx)?(?=\.[A-Za-z0-9]+$)"
)

#: Dosya adi belirteci olarak GUCLU yer tutucu/ikon/beden tablosu isaretleri.
_EXCLUDED_TOKENS = frozenset(
    {"placeholder", "noimage", "spacer", "pixel", "favicon", "sprite", "swatch", "swatches"}
)
#: Ardisik belirtec cifti: ("no","image"), ("size","chart") ...
_EXCLUDED_PAIRS = frozenset(
    {
        ("no", "image"),
        ("no", "photo"),
        ("image", "coming"),
        ("size", "chart"),
        ("size", "guide"),
        ("beden", "tablosu"),
        ("olcu", "tablosu"),
        ("beden", "rehberi"),
    }
)


@dataclass(frozen=True)
class SourceImage:
    """Baglayicinin verdigi ham gorsel (henuz ayiklanmamis)."""

    url: str
    #: Kaynaktaki sira (feed'in kendi siralamasi); karsilastirma icin.
    position: int = 0
    width: int | None = None
    height: int | None = None
    #: Kaynak bu gorseli bu offer'in varyantlarina bagladi mi (kanitli iliski).
    variant_specific: bool = False


@dataclass(frozen=True)
class SelectedImage:
    """Yazilacak gorsel: saklanan + (varsa) gosterim sirasi."""

    source_url: str
    url_hash: bytes
    source_position: int
    display_rank: int | None
    width: int | None
    height: int | None
    is_variant_specific: bool


def _is_shopify_cdn(host: str, path: str) -> bool:
    return host.endswith("cdn.shopify.com") or "/cdn/shop/" in path


def clean_url(raw: str | None) -> str | None:
    """Gecerli http(s) URL'sini dondurur; yoksa None. Anlam degistirmez."""
    if not raw:
        return None
    url = raw.strip()
    if url.startswith("//"):
        url = "https:" + url
    if not url or len(url) > MAX_URL_LENGTH or any(ch.isspace() for ch in url):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        return None
    return url


def normalize_key(url: str) -> str:
    """Esitlik anahtari: ayni gorselin farkli yazimlari ayni anahtari verir.

    Guvenli normalizasyon: sema/host kucuk harf, parca (#...) atilir, varsayilan
    port atilir, surum/onbellek parametreleri atilir, kalan sorgu siralanir.
    Shopify CDN'inde ayrica boyut parametreleri ve `_800x` dosya eki atilir.
    """
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    scheme = "https" if parts.scheme.lower() in ("http", "https") else parts.scheme.lower()
    port = parts.port
    netloc = host if port in (None, 80, 443) else f"{host}:{port}"
    path = parts.path or "/"
    shopify = _is_shopify_cdn(host, path)
    if shopify:
        path = _SHOPIFY_SUFFIX.sub("", path)
    drop = _VERSION_PARAMS | (_SHOPIFY_SIZE_PARAMS if shopify else frozenset())
    query = sorted(
        (k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k.lower() not in drop
    )
    return urlunsplit((scheme, netloc, path, urlencode(query), ""))


def url_hash(url: str) -> bytes:
    """Normalize URL'nin MD5'i (16 bayt) — `offer_image.url_hash`."""
    return hashlib.md5(normalize_key(url).encode("utf-8")).digest()  # noqa: S324 — kimlik, guvenlik degil


def _filename_tokens(url: str) -> list[str]:
    path = urlsplit(url).path
    name = path.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower()
    return [token for token in re.split(r"[^a-z0-9]+", name) if token]


def looks_non_product(image: SourceImage) -> bool:
    """YALNIZCA guclu isaret varsa True. Emin degilse False (gorsel kalir)."""
    tokens = _filename_tokens(image.url)
    if any(token in _EXCLUDED_TOKENS for token in tokens):
        return True
    if any(pair in _EXCLUDED_PAIRS for pair in zip(tokens, tokens[1:], strict=False)):
        return True
    return bool(
        image.width and image.height and max(image.width, image.height) < MIN_USEFUL_EDGE_PX
    )


def select_images(
    candidates: Iterable[SourceImage],
    *,
    max_source: int = MAX_SOURCE_IMAGES,
    max_display: int = MAX_DISPLAY_IMAGES,
) -> list[SelectedImage]:
    """Ham gorsellerden saklanacak (<= max_source) ve gosterilecek (<= max_display) kume.

    Adimlar (deterministik):
    1. gecersiz/bos URL'leri at
    2. normalize URL'ye gore tekrarlari at (ilk gorulen kazanir; `variant_specific`
       isareti birlestirilir)
    3. guclu isaretle urun gorseli olmayanlari at (hepsi atilacaksa tumu kalir)
    4. gosterim sirasi: once varyanta bagli (kanitli renk) gorseller, sonra ortak
       gorseller; her grupta kaynagin kendi sirasi (`position`). Kaynagin "ana
       gorsel" isareti (orn. Shopify `variant.featured_image`) SIRAYI BELIRLEMEZ:
       o genellikle duz urun fotografidir ve satici siralamasindan bagimsizdir.
    5. saklanan: gosterim sirasindaki ilk `max_source`; `source_position` bunlarin
       kaynak siradaki yeri; `display_rank`: ilk `max_display` (0..n-1)
    """
    cleaned: list[tuple[int, str, SourceImage]] = []
    index_by_key: dict[str, int] = {}
    for order, image in enumerate(candidates):
        url = clean_url(image.url)
        if url is None:
            continue
        key = normalize_key(url)
        if key in index_by_key:
            first = cleaned[index_by_key[key]]
            merged = SourceImage(
                url=first[2].url,
                position=first[2].position,
                width=first[2].width or image.width,
                height=first[2].height or image.height,
                variant_specific=first[2].variant_specific or image.variant_specific,
            )
            cleaned[index_by_key[key]] = (first[0], first[1], merged)
            continue
        index_by_key[key] = len(cleaned)
        cleaned.append(
            (
                order,
                url,
                SourceImage(url, image.position, image.width, image.height, image.variant_specific),
            )
        )

    if not cleaned:
        return []

    # Kaynak sirasi: kaynagin verdigi `position`, esitlikte gelis sirasi.
    cleaned.sort(key=lambda item: (item[2].position, item[0]))

    kept = [item for item in cleaned if not looks_non_product(item[2])]
    if not kept:  # guclu isaretler bile tek gorsel birakmadiysa eleme geri alinir
        kept = cleaned

    # Gosterim sirasi (kararli siralama: gruplar icinde kaynak sirasi korunur).
    by_display = sorted(range(len(kept)), key=lambda i: not kept[i][2].variant_specific)
    stored = sorted(by_display[:max_source])  # kaynak sirasina geri don
    rank_of = {kept_index: rank for rank, kept_index in enumerate(by_display[:max_source])}

    return [
        SelectedImage(
            source_url=kept[i][1],
            url_hash=url_hash(kept[i][1]),
            source_position=position,
            display_rank=rank_of[i] if rank_of[i] < max_display else None,
            width=kept[i][2].width,
            height=kept[i][2].height,
            is_variant_specific=kept[i][2].variant_specific,
        )
        for position, i in enumerate(stored)
    ]


def keep_current_first(
    selected: Sequence[SelectedImage],
    current_url: str | None,
    *,
    max_display: int = MAX_DISPLAY_IMAGES,
) -> tuple[SelectedImage, ...]:
    """Mevcut (eski) ana gorseli rank 0 yapar; digerleri eski siralariyla arkasindan gelir.

    Renk-bolunmus urunde bu renge ozgu kanit YOKSA yeni bir ana gorsel secmek yanlis
    renk riskini artirir: mevcut ana gorsel degismez. Mevcut gorsel galeride yoksa
    (baska renge bagli oldugu bilindigi icin elendi ya da kaynak listesinde yok) ve
    guvenli bir yerine de yoksa galeri bos doner: yanlis rengi kalicilastirmayiz.
    """
    if not current_url:
        return ()
    key = normalize_key(current_url)
    current = next((s for s in selected if normalize_key(s.source_url) == key), None)
    if current is None:
        return ()
    rest = sorted(
        (s for s in selected if s is not current),
        key=lambda s: (s.display_rank is None, s.display_rank or 0, s.source_position),
    )
    ordered = [current, *rest]
    ranked = {id(s): (rank if rank < max_display else None) for rank, s in enumerate(ordered)}
    by_position = sorted(ordered, key=lambda s: s.source_position)
    return tuple(replace(s, display_rank=ranked[id(s)]) for s in by_position)


def images_from_entries(entries: Sequence[Mapping[str, str]]) -> list[SourceImage]:
    """`RawRecord.groups["images"]` girdilerini `SourceImage`a cevirir.

    Girdi alanlari (hepsi metin): `src`, `position`, `width`, `height`,
    `variant_specific` ("1"). Bozuk sayilar yok sayilir.
    """

    def to_int(value: str | None, *, minimum: int = 1) -> int | None:
        try:
            number = int(value) if value not in (None, "") else None
        except (TypeError, ValueError):
            return None
        return number if number is not None and number >= minimum else None

    result: list[SourceImage] = []
    for order, entry in enumerate(entries):
        position = to_int(entry.get("position"), minimum=0)
        result.append(
            SourceImage(
                url=entry.get("src") or "",
                position=position if position is not None else order,
                width=to_int(entry.get("width")),
                height=to_int(entry.get("height")),
                variant_specific=entry.get("variant_specific") == "1",
            )
        )
    return result
