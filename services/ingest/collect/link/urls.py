"""URL normalizasyonu ve `external_id` turetimi.

Katman 2'nin idempotentligi buraya dayanir. Ayni urun linki farkli izleme
parametreleriyle yapistirildigunda IKI KAYIT OLUSMAMALI:

    https://magaza.example/urun/canta?utm_source=instagram
    https://www.magaza.example/urun/canta?fbclid=abc
    https://magaza.example/urun/canta#yorumlar

ucu de ayni `external_id`'yi vermelidir. Feed'de merchant'in kendi kimligi
vardi; burada yok, o yuzden kimligi normalize URL'den turetiyoruz ve
`(merchant_id, external_id)` unique kisiti isini gormeye devam ediyor.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

#: Urunu degil, trafigin nereden geldigini anlatan parametreler. Kimligin
#: parcasi degiller; birakilirsa ayni urun defalarca kataloga girer.
TRACKING_PARAMS = frozenset(
    {
        "gclid",
        "fbclid",
        "msclkid",
        "yclid",
        "igshid",
        "mc_cid",
        "mc_eid",
        "ref",
        "referrer",
        "source",
        "trk",
        "spm",
        "sid",
        "affiliate",
        "aff_id",
        "tag",
        "campaign",
    }
)

#: Bu onekle baslayan her parametre izleme sayilir (utm_source, utm_medium...).
TRACKING_PREFIXES = ("utm_", "pk_", "_hs", "adj_")


class InvalidUrl(ValueError):
    """Cozumlenemeyecek URL. Kullaniciya donen bir hata, kosu hatasi degil."""


def _is_tracking(name: str) -> bool:
    lowered = name.lower()
    return lowered in TRACKING_PARAMS or lowered.startswith(TRACKING_PREFIXES)


@dataclass(frozen=True)
class NormalizedUrl:
    """Sadelestirilmis URL ve ondan turetilen kimlik."""

    #: Getirilecek adres — sema + gercek host (`www.` dahil) (+port) + yol +
    #: anlamli parametreler. Fragment yok.
    url: str
    #: `merchant.domain` ile eslesen host. Port ICERMEZ: bir magaza, hangi
    #: portta servis edildiginden bagimsiz olarak ayni magazadir.
    domain: str
    #: `offer.external_id` — merchant icinde tekil.
    external_id: str
    #: `robots.txt`in bulundugu kok: sema + host + port. Standart disi bir
    #: port varsa robots da oradan okunur.
    origin: str


def normalize(raw: str) -> NormalizedUrl:
    parts = urlsplit(raw.strip())

    if parts.scheme not in {"http", "https"}:
        raise InvalidUrl(f"yalnizca http/https desteklenir: {parts.scheme or 'sema yok'!r}")
    if not parts.netloc:
        raise InvalidUrl("adreste alan adi yok")

    # Kimlik bilgisi ve port host'un parcasi degil. `www.` yalnizca KIMLIKTEN
    # duser (`domain`); getirilen adres gercek host'u korur — apeks alan adi
    # cozulmeyen magazalar var (docs/decisions/0035).
    fetch_host = (parts.hostname or "").lower().rstrip(".")
    host = fetch_host.removeprefix("www.")
    if not host or "." not in host:
        raise InvalidUrl(f"gecersiz alan adi: {host!r}")

    # Anlamli parametreler korunur ve siralanir; sira degisikligi kimligi
    # degistirmemeli.
    query = sorted(
        (name, value)
        for name, value in parse_qsl(parts.query, keep_blank_values=False)
        if not _is_tracking(name)
    )

    # Sondaki bolu isareti tek basina farkli bir sayfa anlamina gelmiyor.
    path = parts.path.rstrip("/") or "/"
    encoded = urlencode(query)

    # Port korunur: standart disi bir portta servis edilen sayfa, portsuz
    # adreste YOKTUR. Varsayilan portlar yazilmaz, adresi gereksiz uzatir.
    try:
        port = parts.port
    except ValueError as error:
        raise InvalidUrl(f"gecersiz port: {parts.netloc!r}") from error
    default_port = {"http": 80, "https": 443}[parts.scheme]
    netloc = fetch_host if port in (None, default_port) else f"{fetch_host}:{port}"

    # Fragment her zaman dusurulur: sunucuya zaten gonderilmiyor.
    url = urlunsplit((parts.scheme, netloc, path, encoded, ""))
    external_id = f"{path}?{encoded}" if encoded else path

    return NormalizedUrl(
        url=url,
        domain=host,
        external_id=external_id,
        origin=f"{parts.scheme}://{netloc}",
    )
