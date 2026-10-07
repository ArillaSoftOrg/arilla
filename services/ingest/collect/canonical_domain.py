"""Shopify merchant'lari icin kanonik alan adi kaniti — SALT OKUNUR.

    python -m collect.canonical_domain --merchant riva-istanbul
    python -m collect.canonical_domain --merchant a --merchant b --report rapor.json

`<magaza>.myshopify.com/robots.txt` cogu zaman magazanin ozel alan adina
yonlendirir; toplama yonlendirme izlemedigi icin `refused:robots_unavailable`
verir (docs/decisions/0042). Cozum kapiyi gevsetmek degil, merchant'in
`domain`/`feed_url`'unu GERCEK kanonik host'a tasimaktir. Bu arac o host'u
kanitlar; veritabanina HICBIR SEY yazmaz.

Her merchant icin:

1. `https://<mevcut domain>/robots.txt` — yonlendirme ELLE izlenir, en fazla
   `MAX_HOPS` adim. Her adim: https, kimlik bilgisi yok, standart port, gecerli
   host adi, ayni yol (`/robots.txt`), `safe_http.check_url`. Host dongusu ya da
   baska bir yola gidis ret. Son adim 200 degilse FAIL.
2. Aday host'un cozulen IP'leri kaydedilir ve HEPSI genel olmali; baglanti
   zaten `guarded_client` (GuardedBackend) uzerinden gider, yani ic IP'ye
   baglanti kurulamaz.
3. Shopify kimligi: aday host'un `/meta.json`'u 200 ve `myshopify_domain`
   mevcut domain ile ESIT olmali — baska bir sitenin yonlendirmesi kabul edilmez.
4. Para birimi: `verify_currency.check_merchant` (tam `"TRY"`) aday host'a.
5. Hazirlik: `verify_readiness.check_target` (robots + urun ornegi + fiyat +
   esleme) aday host'a, merchant'in mevcut `feed_config`'i ile.

Hepsi gecerse `READY`; yalnizca o zaman bir migration yazilabilir. Istekler
saniyede en fazla 1, yeniden deneme yok, `ArillaBot` kimligi.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx

from collect import verify_currency, verify_readiness
from collect.link.robots import USER_AGENT
from collect.link.safe_http import BlockedDestination, check_url, guarded_client, is_public_ip
from db.connection import connect

MAX_HOPS = 3
_REDIRECT_STATUSES = frozenset({301, 302, 307, 308})
_ROBOTS_PATH = "/robots.txt"


@dataclass
class Hop:
    url: str
    status: int | None
    location: str | None = None


@dataclass
class CanonicalResult:
    slug: str
    current_domain: str | None
    canonical_host: str | None = None
    chain: list[Hop] = field(default_factory=list)
    resolved_ips: list[str] = field(default_factory=list)
    shopify_identity: str = "UNKNOWN"  # PASS / FAIL
    meta_myshopify_domain: str | None = None
    currency: str = "UNKNOWN"
    readiness: str = "UNKNOWN"
    readiness_reason: str = ""
    #: `UNCHANGED` (zaten dogrudan 200), `READY` (tasinabilir) ya da `FAIL`.
    verdict: str = "FAIL"
    reason: str = ""
    requests: int = 0


def _fail(result: CanonicalResult, reason: str) -> CanonicalResult:
    result.verdict = "FAIL"
    result.reason = reason
    return result


def validated_redirect_host(current_url: str, location: str, current_host: str) -> str:
    """Yonlendirme hedefi gecerliyse yeni host, degilse `ValueError`.

    Yalnizca ayni yola (`/robots.txt`) https ile, standart portta, kimlik
    bilgisiz ve farkli bir gecerli host'a gidis kabul edilir."""
    target = urlsplit(urljoin(current_url, location))
    host = (target.hostname or "").lower()
    if target.scheme != "https":
        raise ValueError(f"https degil: {target.scheme!r}")
    if target.username or target.password:
        raise ValueError("kimlik bilgisi iceriyor")
    if target.port not in (None, 443):
        raise ValueError(f"standart olmayan port: {target.port}")
    if not host or not verify_currency._HOSTNAME.match(host):
        raise ValueError(f"gecersiz host: {host!r}")
    if target.path != _ROBOTS_PATH or target.query:
        raise ValueError(f"baska yola yonlendirme: {target.path}?{target.query}")
    if host == current_host:
        raise ValueError("ayni host'a yonlendirme (dongu)")
    try:
        check_url(f"https://{host}{_ROBOTS_PATH}")
    except BlockedDestination as error:
        raise ValueError(f"adres reddedildi: {error}") from error
    return host


def resolve_public_ips(host: str) -> list[str]:
    infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    return sorted({str(info[4][0]) for info in infos})


def discover(
    client: httpx.Client,
    target: verify_readiness.Target,
    limiter: verify_currency.RateLimiter,
    conventions: verify_readiness.OptionConventions,
) -> CanonicalResult:
    result = CanonicalResult(slug=target.slug, current_domain=target.domain)
    domain = target.domain
    if not domain or not verify_currency._HOSTNAME.match(domain):
        return _fail(result, f"invalid_domain ({domain!r})")

    # 1) robots yonlendirme zinciri, elle ve her adimda dogrulanarak.
    host = domain
    visited = {host}
    for _ in range(MAX_HOPS + 1):
        url = f"https://{host}{_ROBOTS_PATH}"
        limiter.wait()
        result.requests += 1
        try:
            response = client.get(url, follow_redirects=False)
        except (httpx.TransportError, BlockedDestination) as error:
            result.chain.append(Hop(url, None))
            return _fail(result, f"chain_request_error ({type(error).__name__})")
        status = response.status_code
        location = response.headers.get("Location")
        result.chain.append(Hop(url, status, location))
        if status in _REDIRECT_STATUSES and location:
            try:
                host = validated_redirect_host(url, location, host)
            except ValueError as error:
                return _fail(result, f"redirect_rejected ({error})")
            if host in visited:
                return _fail(result, "redirect_loop")
            visited.add(host)
            continue
        if status == 200:
            break
        return _fail(result, f"chain_end_http_{status}")
    else:
        return _fail(result, f"too_many_redirects (>{MAX_HOPS})")

    result.canonical_host = host

    # 2) cozulen IP'ler hep genel mi (baglanti zaten GuardedBackend'den gecti).
    try:
        result.resolved_ips = resolve_public_ips(host)
    except OSError as error:
        return _fail(result, f"dns_error ({type(error).__name__})")
    private = [ip for ip in result.resolved_ips if not is_public_ip(ip)]
    if private:
        return _fail(result, f"non_public_ip ({', '.join(private)})")

    # 3) Shopify kimligi: meta.json'daki myshopify_domain mevcut domain olmali.
    limiter.wait()
    result.requests += 1
    try:
        meta = client.get(f"https://{host}/meta.json", follow_redirects=False)
        payload = meta.json() if meta.status_code == 200 else None
    except (httpx.TransportError, ValueError):
        payload = None
    if not isinstance(payload, dict):
        result.shopify_identity = "FAIL"
        return _fail(result, "meta_json_unavailable")
    shop_domain = payload.get("myshopify_domain")
    result.meta_myshopify_domain = shop_domain if isinstance(shop_domain, str) else None
    if (result.meta_myshopify_domain or "").lower() != domain.lower():
        result.shopify_identity = "FAIL"
        return _fail(result, f"myshopify_domain_mismatch ({result.meta_myshopify_domain!r})")
    result.shopify_identity = "PASS"

    # 4) para birimi: mevcut dogrulama kodu, aday host'a.
    currency = verify_currency.check_merchant(
        client, verify_currency.MerchantTarget(target.slug, host), limiter
    )
    result.requests += currency.requests
    verdict = "PASS" if currency.passed else "FAIL"
    result.currency = f"{verdict} ({currency.currency or currency.reason})"
    if not currency.passed:
        return _fail(result, f"currency: {currency.reason}")

    # 5) hazirlik: mevcut dogrulama kodu, aday host'a.
    moved = verify_readiness.Target(target.slug, host, target.feed_config)
    readiness = verify_readiness.check_target(client, moved, limiter, conventions)
    result.requests += readiness.robots.requests + readiness.product_sample.requests
    result.readiness = readiness.overall
    result.readiness_reason = readiness.overall_reason
    if readiness.overall != "READY":
        return _fail(result, f"readiness: {readiness.overall} ({readiness.overall_reason})")

    result.verdict = "UNCHANGED" if host == domain else "READY"
    result.reason = "tum kontroller olumlu"
    return result


def build_client() -> httpx.Client:
    return guarded_client(
        user_agent=USER_AGENT, timeout=httpx.Timeout(10.0, connect=5.0), follow_redirects=False
    )


def format_report(results: Sequence[CanonicalResult]) -> str:
    lines = [f"{'merchant':<28} {'verdict':<10} {'eski -> kanonik':<70} reason"]
    for r in results:
        arrow = f"{r.current_domain} -> {r.canonical_host or '-'}"
        lines.append(f"{r.slug:<28} {r.verdict:<10} {arrow:<70} {r.reason}")
    return "\n".join(lines)


def report_json(results: Sequence[CanonicalResult]) -> dict[str, Any]:
    return {
        "checked_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "tool": "collect.canonical_domain",
        "user_agent": USER_AGENT,
        "max_hops": MAX_HOPS,
        "results": [asdict(r) for r in results],
    }


def main(argv: list[str] | None = None, client: httpx.Client | None = None) -> int:
    parser = argparse.ArgumentParser(prog="collect.canonical_domain")
    parser.add_argument("--merchant", action="append", required=True, help="merchant.slug")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)

    with connect() as conn:
        targets, _ = verify_readiness.load_targets(conn, args.merchant)
    conventions = verify_readiness.load_conventions()
    limiter = verify_currency.RateLimiter()
    http = client or build_client()
    try:
        results = [discover(http, t, limiter, conventions) for t in targets]
    finally:
        if client is None:
            http.close()

    print(format_report(results))
    if args.report:
        args.report.write_text(
            json.dumps(report_json(results), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    return 0 if all(r.verdict in ("READY", "UNCHANGED") for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
