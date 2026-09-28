"""Toplu toplama icin KATI robots.txt politikasi (docs/decisions/0032, 0042).

Iki kullanicisi var ve ikisi de bu tek yorumu kullanir:

- `collect/verify_readiness.py`: aktivasyon oncesi kanit.
- `collect/sources/shopify.py`: gercek toplama, ilk `/products.json`
  isteginden ONCE, kosu basina bir kez.

`collect/link/robots.RobotsCache` kullanici linki icindir ve bilincli olarak
gevsektir: ag hatasinda ve 5xx'te izin verir, yonlendirmeyi izler. Toplu
toplama icin bu kabul edilemez; burada politika guvenle belirlenemiyorsa
cevap HAYIR'dir:

- 200 `text/plain` (ya da Content-Type yok): kurallar yorumlanir.
- 404: robots.txt yok = kural yok (repo sozlesmesi, `link/robots.py`).
- 3xx (izlenmez), 401/403, 5xx ve diger her durum: yasak.
- Zaman asimi, ag hatasi, okunamayan govde: yasak.
- Standart kutuphane `*`/`$` jokerlerini anlamaz; bizim gruba uygulanan ve
  hedef yolla eslesen joker bir `Disallow` "belirlenemez" sayilir: yasak.

Tek istek: yeniden deneme yok, yonlendirme izlenmez.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote
from urllib.robotparser import RobotFileParser

import httpx

from collect.link.robots import USER_AGENT

#: Bundan uzun bir `Crawl-delay` istenirse toplu istek atilmaz. Hazirlik
#: dogrulamasi ornegi atlar (REVIEW), gercek toplama reddedilir. Tek deger,
#: iki tarafta ayni.
MAX_CRAWL_DELAY_SECONDS = 30.0

#: robots.txt istegi icin zaman asimi (hazirlik dogrulamasiyla ayni, 0032).
ROBOTS_TIMEOUT_SECONDS = 10.0

#: `RobotsVerdict.code`: politika bir yasak soyluyor.
DISALLOWED = "robots_disallowed"
#: `RobotsVerdict.code`: politika guvenle belirlenemedi (HTTP, ag, bicim).
UNAVAILABLE = "robots_unavailable"


@dataclass(frozen=True)
class RobotsVerdict:
    allowed: bool
    #: Insan okur neden; hazirlik raporundaki metinle birebir ayni.
    reason: str
    #: Izin yoksa `DISALLOWED` ya da `UNAVAILABLE`; izin varsa None.
    code: str | None = None
    http_status: int | None = None
    crawl_delay: float | None = None


def _applicable_entry(parser: RobotFileParser, useragent: str) -> Any:
    """`RobotFileParser.can_fetch` ile ayni grup secimi."""
    for entry in parser.entries:
        if entry.applies_to(useragent):
            return entry
    return parser.default_entry


def _wildcard_matches(pattern: str, path: str) -> bool:
    """RFC 9309 eslemesi: `*` herhangi bir dizi, sondaki `$` ucu sabitler."""
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    regex = "".join(".*" if ch == "*" else re.escape(ch) for ch in body)
    return re.match(regex + ("$" if anchored else ""), path) is not None


def evaluate_robots(
    text: str, paths: Sequence[str], user_agent: str = USER_AGENT
) -> tuple[str | None, float | None]:
    """robots.txt metni -> (yasak nedeni ya da None, Crawl-delay).

    `paths` bizim ISTEYECEGIMIZ yol+sorgu bicimleridir; hepsine izin olmali.
    """
    parser = RobotFileParser()
    parser.parse(text.splitlines())
    for path in paths:
        if not parser.can_fetch(user_agent, path):
            return f"{DISALLOWED} ({path})", None

    entry = _applicable_entry(parser, user_agent)
    for rule in getattr(entry, "rulelines", []) if entry else []:
        pattern = unquote(rule.path)
        if rule.allowance or not ("*" in pattern or "$" in pattern):
            continue
        for path in paths:
            if _wildcard_matches(pattern, path):
                return f"robots_wildcard_disallow ({pattern} ~ {path})", None

    delay = parser.crawl_delay(user_agent)
    return None, float(delay) if delay is not None else None


def _refused(reason: str, code: str, status: int | None = None) -> RobotsVerdict:
    return RobotsVerdict(False, reason, code, http_status=status)


def fetch_robots(
    client: httpx.Client,
    origin: str,
    paths: Sequence[str],
    *,
    timeout: float | None = None,
) -> RobotsVerdict:
    """`<origin>/robots.txt` icin TEK istek ve kati karar.

    User-agent istek basliginda acikca `USER_AGENT` olarak gonderilir; kurallar
    da ayni adla yorumlanir — istemci hangi varsayilanla kurulmus olursa olsun.
    `timeout` verilmezse istemcinin kendi zaman asimi gecerlidir.
    """
    options: dict[str, Any] = {"follow_redirects": False, "headers": {"User-Agent": USER_AGENT}}
    if timeout is not None:
        options["timeout"] = timeout
    try:
        response = client.get(f"{origin}/robots.txt", **options)
    except httpx.TimeoutException:
        return _refused("timeout", UNAVAILABLE)
    except httpx.TransportError as error:
        return _refused(f"network_error ({type(error).__name__})", UNAVAILABLE)
    except Exception as error:  # noqa: BLE001 — belirlenemeyen = yasak
        return _refused(f"request_error ({type(error).__name__})", UNAVAILABLE)

    status = response.status_code
    if status == 404:
        return RobotsVerdict(True, "no_robots_txt (404: kural yok)", http_status=404)
    if status != 200:
        location = response.headers.get("Location", "")
        detail = f" -> {location[:120]}" if location else ""
        return _refused(f"http_{status}{detail}", UNAVAILABLE, status)

    content_type = response.headers.get("Content-Type", "").lower()
    if content_type and not content_type.startswith("text/plain"):
        return _refused(f"robots_unusable (content-type {content_type[:40]})", UNAVAILABLE, status)
    try:
        text = response.text
    except Exception:  # noqa: BLE001 — cozulemeyen govde: politika belirlenemez
        return _refused("robots_unusable (govde okunamadi)", UNAVAILABLE, status)

    refusal, delay = evaluate_robots(text, paths)
    if refusal:
        return _refused(refusal, DISALLOWED, status)
    return RobotsVerdict(True, "allowed", http_status=status, crawl_delay=delay)
