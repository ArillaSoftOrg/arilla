"""Kullanici kaynakli URL'ler icin SSRF korumasi.

Link aramasi (docs/decisions/0031) kullanicinin yapistirdigi adresi sunucudan
getirir. Denetlenmezse bu, sunucunun ic agina acilan bir kapidir:
`http://169.254.169.254/` (bulut metadata), `http://localhost:6379/`, ya da
herkese acik gorunen bir adresin 302 ile `http://10.0.0.5/`e yonlendirmesi.

Iki katman:

1. `check_url` — adresin YAZIMI: yalnizca http/https, kimlik bilgisi yok,
   izinli port, `localhost`/`.internal` gibi ic adlar yok, ozel IP literali yok.
   Her yonlendirme adiminda yeniden calisir.
2. `GuardedBackend` — asil karar. Soket ACILIRKEN host cozulur, cozulen
   adreslerin HEPSI genel (public) olmali; baglanti denetlenen IP'nin kendisine
   yapilir. Denetim ile baglanti arasinda ikinci bir DNS sorgusu olmadigi icin
   DNS rebinding (ilk sorguda genel, ikincide ic adres) araya giremez. TLS
   dogrulamasi hala gercek host adina yapilir (httpcore `server_hostname`).

Istemci ayrica ortam proxy'lerini yok sayar (`trust_env=False`) — aksi halde
baglanti proxy'ye gider ve IP denetimi anlamsizlasir — ve hicbir cerez
saklamaz: bir kullanicinin istegiyle alinan cerez baskasinin istegine gitmez.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from http.cookiejar import CookieJar, DefaultCookiePolicy
from urllib.parse import urlsplit

import httpcore
import httpx

#: Urun sayfalari standart portlarda yayinlanir; ic servisler cogu zaman
#: baska portlardadir (6379, 5432, 9200...). Genel bir IP'de bile bunlara
#: kullanici adina istek atilmaz.
DEFAULT_ALLOWED_PORTS = frozenset({80, 443, 8080, 8443})

#: Ic ag adlari. Genel DNS'te cozulmezler ama sirket/bulut ic DNS'inde cozulur.
BLOCKED_HOSTNAMES = frozenset({"localhost", "metadata", "metadata.google.internal"})
BLOCKED_SUFFIXES = (
    ".localhost",
    ".local",
    ".internal",
    ".intranet",
    ".lan",
    ".home",
    ".corp",
    ".home.arpa",
)

MAX_URL_LENGTH = 2048

#: NAT64 onekleri: gomulu IPv4 adresi ayrica denetlenir.
_NAT64 = (ipaddress.ip_network("64:ff9b::/96"), ipaddress.ip_network("64:ff9b:1::/48"))


class BlockedDestination(Exception):
    """Adres ic aga ya da izin verilmeyen bir hedefe gidiyor. Istek yapilmaz."""


def is_public_ip(value: str) -> bool:
    """Genel internette yonlendirilebilir bir tekil adres mi?

    `is_global` loopback, RFC1918, link-local (metadata 169.254.169.254),
    CGNAT (100.64/10), belgeleme ve ayrilmis bloklari zaten disarida birakir;
    IPv4'u IPv6 icine gomen bicimler (::ffff:127.0.0.1, 6to4, Teredo, NAT64)
    acilip gomulu adres ayrica denetlenir.
    """
    try:
        ip = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False

    if isinstance(ip, ipaddress.IPv6Address):
        embedded: list[ipaddress.IPv4Address] = []
        if ip.ipv4_mapped is not None:
            embedded.append(ip.ipv4_mapped)
        if ip.sixtofour is not None:
            embedded.append(ip.sixtofour)
        if ip.teredo is not None:
            embedded.extend(ip.teredo)
        if any(ip in network for network in _NAT64):
            embedded.append(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
        if embedded:
            return all(is_public_ip(str(inner)) for inner in embedded)

    return ip.is_global and not ip.is_multicast


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


@dataclass(frozen=True)
class DestinationPolicy:
    """Neye izin verildigi. Testler yerel sunucuyu "genel" saymak icin degistirir."""

    allowed_ports: frozenset[int] = DEFAULT_ALLOWED_PORTS
    ip_allowed: Callable[[str], bool] = is_public_ip


DEFAULT_POLICY = DestinationPolicy()


def check_url(url: str, policy: DestinationPolicy = DEFAULT_POLICY) -> None:
    """Adresin yazimini denetler; uygun degilse `BlockedDestination`.

    DNS'e gitmez — asil IP karari `GuardedBackend`'de, soket acilirken verilir.
    """
    if len(url) > MAX_URL_LENGTH:
        raise BlockedDestination("adres cok uzun")
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"}:
        raise BlockedDestination(f"desteklenmeyen sema: {parts.scheme or 'yok'}")
    if parts.username is not None or parts.password is not None:
        raise BlockedDestination("adreste kimlik bilgisi var")

    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise BlockedDestination("adreste alan adi yok")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as error:
        raise BlockedDestination("gecersiz port") from error
    if port not in policy.allowed_ports:
        raise BlockedDestination(f"izin verilmeyen port: {port}")

    if _is_ip_literal(host):
        if not policy.ip_allowed(host):
            raise BlockedDestination("ic ag adresi")
        return
    if host in BLOCKED_HOSTNAMES or host.endswith(BLOCKED_SUFFIXES) or "." not in host:
        raise BlockedDestination("ic ag alan adi")


Resolver = Callable[[str, int], Iterable[str]]


def system_resolver(host: str, port: int) -> list[str]:
    """Isletim sisteminin cozumleyicisi; tekrar eden adresler bir kez."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise httpcore.ConnectError(f"alan adi cozulemedi: {host}") from error
    seen: list[str] = []
    for info in infos:
        address = str(info[4][0])
        if address not in seen:
            seen.append(address)
    return seen


@dataclass
class GuardedBackend(httpcore.SyncBackend):
    """Baglanti aninda IP denetimi yapan ve denetlenen IP'ye baglanan arka uc."""

    resolver: Resolver = system_resolver
    policy: DestinationPolicy = field(default_factory=DestinationPolicy)

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.NetworkStream:
        if port not in self.policy.allowed_ports:
            raise BlockedDestination(f"izin verilmeyen port: {port}")
        addresses = list(self.resolver(host, port))
        if not addresses:
            raise httpcore.ConnectError(f"alan adi cozulemedi: {host}")
        # Tek bir ic adres bile yeterli sebep: karisik kayitlarla (bir genel,
        # bir ic A kaydi) ic aga sizma denemesi boylece kapanir.
        if not all(self.policy.ip_allowed(address) for address in addresses):
            raise BlockedDestination(f"ic ag adresine cozuluyor: {host}")

        last_error: Exception | None = None
        for address in addresses:
            try:
                return super().connect_tcp(
                    address,
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as error:
                last_error = error
        assert last_error is not None
        raise last_error


class GuardedTransport(httpx.HTTPTransport):
    """`httpx.HTTPTransport`, ama baglanti havuzu `GuardedBackend` kullanir.

    httpx 0.28 `network_backend` parametresini disari acmiyor; havuz ayni
    ayarlarla yeniden kurulur. Davranis `tests/test_link_safe_http.py`'de
    gercek soketle dogrulanir — httpx icerigi degisirse test kirilir.
    """

    def __init__(self, backend: GuardedBackend | None = None, *, max_connections: int = 4) -> None:
        super().__init__(trust_env=False, retries=0)
        self._pool = httpcore.ConnectionPool(
            ssl_context=httpx.create_ssl_context(trust_env=False),
            max_connections=max_connections,
            max_keepalive_connections=max_connections,
            keepalive_expiry=5.0,
            retries=0,
            network_backend=backend or GuardedBackend(),
        )


def _no_cookie_jar() -> CookieJar:
    return CookieJar(policy=DefaultCookiePolicy(allowed_domains=[]))


def guarded_client(
    *,
    user_agent: str,
    timeout: httpx.Timeout | None = None,
    follow_redirects: bool = False,
    max_redirects: int = 5,
    backend: GuardedBackend | None = None,
) -> httpx.Client:
    """Kullanici kaynakli adresler icin tek dogru istemci.

    Sayfa getirme yonlendirmeleri ELLE izler (`follow_redirects=False`) ki her
    adimda `check_url` ve robots yeniden calissin; gorsel/robots indirmesi
    httpx'e birakabilir — IP denetimi her adimda arka uctan gecer.
    """
    return httpx.Client(
        transport=GuardedTransport(backend),
        timeout=timeout or httpx.Timeout(10.0, connect=5.0),
        follow_redirects=follow_redirects,
        max_redirects=max_redirects,
        trust_env=False,
        cookies=_no_cookie_jar(),
        headers={"User-Agent": user_agent},
    )
