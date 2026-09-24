"""`robots.txt` denetimi.

Katman 2'nin ilk kurali: **robots.txt dinlenir.** Bu bir tercih degil, bir
sinir. `docs/decisions/0004` toplu kazimayi tamamen disarida birakiyor;
kullanici tetikli tek URL cozumlemesinin mesru kalmasi, sitenin acikca
belirttigi kurala uymasina bagli. Atlatma yolu YOKTUR ve eklenmeyecektir.

Kendimizi tanitan bir user-agent kullaniyoruz: bir merchant bizi bilincli
olarak engellemek ya da izin vermek istediginde adimizi gorebilmeli.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

import httpx

from db.connection import env

logger = logging.getLogger(__name__)

#: robots.txt gruplarinda eslesen urun belirteci. Merchant bizi bu adla
#: engelleyebilir veya izin verebilir.
BOT_NAME = "ArillaBot"
BOT_VERSION = "1.0"

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}


def build_user_agent(app_url: str | None) -> str:
    """Kim oldugumuzu soyleyen user-agent.

    Alan adi koda gomulmez: `APP_URL` (web tarafiyla ayni normalizasyon -
    bosluk, tirnak ve sondaki slash kirpilir) tanimliysa site adresi
    olarak eklenir; tanimsizsa URL'siz `ArillaBot/1.0` kullanilir.
    Uydurma bir alan adi yazmaktansa hic yazmamak dogrudur.
    """
    base = f"{BOT_NAME}/{BOT_VERSION}"
    value = (app_url or "").strip().strip("\"'").rstrip("/")
    parts = urlsplit(value)
    # Kullanici adi VEYA parola iceren adres UA'ya (merchant'a giden istege)
    # asla yazilmaz: `https://:parola@host` bos kullanici adiyla gecerdi.
    if (
        parts.scheme not in {"https", "http"}
        or not parts.hostname
        or parts.username
        or parts.password
    ):
        return base
    # Yerel gelistirme adresi merchant icin anlamsiz; yazilmaz.
    if parts.hostname in _LOCAL_HOSTS or parts.hostname.endswith(".localhost"):
        return base
    # netloc yerine yalnizca host + port: kimlik bilgisi hicbir yoldan sizmaz.
    host = f"{parts.hostname}:{parts.port}" if parts.port else parts.hostname
    return f"{base} (+{parts.scheme}://{host})"


#: Surec basina bir kez hesaplanir; `.env` `db.connection.env` ile okunur.
USER_AGENT = build_user_agent(env("APP_URL"))

#: robots.txt onbellek suresi. Ayni host'a arka arkaya sorulmaz.
CACHE_TTL_SECONDS = 3600


class RobotsDisallowed(Exception):
    """Site bu adresin alinmasini yasakliyor. Cozumleme reddedilir."""


@dataclass
class _Entry:
    parser: RobotFileParser
    fetched_at: float
    crawl_delay: float | None


@dataclass
class RobotsCache:
    """Host basina `robots.txt` onbellegi."""

    client: httpx.Client | None = None
    ttl: float = CACHE_TTL_SECONDS
    _entries: dict[str, _Entry] = field(default_factory=dict)

    def _client(self) -> httpx.Client:
        return self.client or httpx.Client(
            timeout=10.0, follow_redirects=True, headers={"User-Agent": USER_AGENT}
        )

    def _load(self, origin: str) -> _Entry:
        cached = self._entries.get(origin)
        if cached and (time.monotonic() - cached.fetched_at) < self.ttl:
            return cached

        parser = RobotFileParser()
        url = f"{origin}/robots.txt"
        try:
            response = self._client().get(url)
            if response.status_code == 200:
                parser.parse(response.text.splitlines())
            else:
                # robots.txt yoksa (404) kural yok demektir; sunucu hatasinda
                # da engellemiyoruz — ama 401/403 sitenin kapali oldugunu
                # soyler, o zaman izin vermiyoruz.
                if response.status_code in {401, 403}:
                    parser.disallow_all = True
                else:
                    parser.allow_all = True
        except httpx.HTTPError as error:
            logger.warning("robots.txt alinamadi %s: %s", url, error)
            parser.allow_all = True

        entry = _Entry(
            parser=parser,
            fetched_at=time.monotonic(),
            crawl_delay=_crawl_delay(parser),
        )
        self._entries[origin] = entry
        return entry

    def check(self, origin: str, url: str) -> None:
        """Izin yoksa `RobotsDisallowed` firlatir."""
        entry = self._load(origin)
        if not entry.parser.can_fetch(USER_AGENT, url):
            raise RobotsDisallowed(f"robots.txt bu adresi yasakliyor: {url}")

    def crawl_delay(self, origin: str) -> float | None:
        """Sitenin istedigi bekleme suresi; yenileme toplu isinde uygulanir."""
        return self._load(origin).crawl_delay


def _crawl_delay(parser: RobotFileParser) -> float | None:
    try:
        value = parser.crawl_delay(USER_AGENT)
    except (AttributeError, ValueError):
        return None
    return float(value) if value is not None else None
