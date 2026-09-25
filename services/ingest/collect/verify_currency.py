"""Shopify merchant'larinin para birimi dogrulamasi — SALT OKUNUR.

    python -m collect.verify_currency
    python -m collect.verify_currency --merchant riva-istanbul
    python -m collect.verify_currency --report rapor.json

Her Shopify merchant'i icin `https://<merchant.domain>/meta.json` adresine
TEK istek atilir ve magazanin taban para birimi (`currency`) okunur. Yalnizca
tam olarak `"TRY"` gecer (docs/decisions/0031).

Sinirlar (0023):

- **Tek istek, yeniden deneme yok.** Zaman asimi, ag hatasi, 2xx disi yanit
  (yonlendirme dahil — izlemek ikinci istek olurdu), bozuk JSON, eksik ya da
  TRY disi para birimi: merchant FAIL olur, rapor devam eder.
- **Oran siniri.** Istekler sirayla, saniyede en fazla `REQUESTS_PER_SECOND`.
- **Sinirli zaman asimi.** `TIMEOUT_SECONDS`.

Bu komut HICBIR SEY YAZMAZ. Veritabani baglantisi `read_only` acilir;
`currency_verified`, `is_active`, `feed_config` ve katalog degismez. Sonucu
veritabanina tasimak ayri, insan onayli bir adimdir (onaylanmis rapora dayanan
bir migration).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

import httpx
import psycopg

from collect.gate import SHOPIFY_CURRENCY
from db.connection import connect

#: 0023: saniyede 1-2 istekten fazla degil. Alt sinirda kaliyoruz.
REQUESTS_PER_SECOND = 1.0
TIMEOUT_SECONDS = 10.0

#: Yalin, kucuk harfli ana bilgisayar adi. Sema, yol, port, kullanici bilgisi
#: yok — `merchant.domain` bunlardan birini tasiyorsa yapilandirma hatasidir
#: ve istek atilmaz.
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_HOSTNAME = re.compile(rf"^(?=.{{1,253}}$){_LABEL}(?:\.{_LABEL})+$")

SELECT_MERCHANTS = """
SELECT slug, domain FROM merchant
 WHERE source_type = 'shopify'
 ORDER BY slug
"""


@dataclass(frozen=True)
class MerchantTarget:
    slug: str
    domain: str | None


@dataclass(frozen=True)
class CurrencyCheck:
    slug: str
    domain: str | None
    #: Magazanin bildirdigi para birimi; okunamadiysa `None`.
    currency: str | None
    passed: bool
    #: Kisa makine kodu: `ok`, `timeout`, `http_404`, `currency_not_try`, ...
    reason: str
    detail: str = ""
    http_status: int | None = None
    #: Bu merchant icin atilan istek sayisi: 0 (gecersiz alan adi) ya da 1.
    requests: int = 0

    @property
    def result(self) -> str:
        return "PASS" if self.passed else "FAIL"


class UnknownMerchant(LookupError):
    pass


def load_targets(
    conn: psycopg.Connection, slugs: Sequence[str] | None = None
) -> list[MerchantTarget]:
    """Shopify merchant'larini okur. Baglanti salt okunur yapilir: bu komutun
    veritabanina yazmasi veritabani duzeyinde imkansizdir."""
    conn.read_only = True
    with conn.cursor() as cur:
        cur.execute(SELECT_MERCHANTS)
        rows = cur.fetchall()
    conn.rollback()
    targets = [MerchantTarget(slug=str(row[0]), domain=row[1]) for row in rows]
    if slugs:
        wanted = set(slugs)
        missing = sorted(wanted - {target.slug for target in targets})
        if missing:
            raise UnknownMerchant(f"Shopify merchant'i bulunamadi: {', '.join(missing)}")
        targets = [target for target in targets if target.slug in wanted]
    return targets


class RateLimiter:
    """Ardisik istekler arasinda en az `1 / requests_per_second` saniye."""

    def __init__(
        self,
        requests_per_second: float = REQUESTS_PER_SECOND,
        *,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not 0 < requests_per_second <= 2:
            raise ValueError("0023: saniyede en fazla 2 istek")
        self.interval = 1.0 / requests_per_second
        self._sleep = sleep
        self._clock = clock
        self._last: float | None = None

    def wait(self) -> None:
        if self._last is not None:
            remaining = self.interval - (self._clock() - self._last)
            if remaining > 0:
                self._sleep(remaining)
        self._last = self._clock()


def check_merchant(
    client: httpx.Client, target: MerchantTarget, limiter: RateLimiter
) -> CurrencyCheck:
    """Tek merchant, tek istek. Hicbir hata disari sizmaz: sonuc her zaman
    bir `CurrencyCheck`'tir."""

    def fail(
        reason: str,
        detail: str = "",
        *,
        currency: str | None = None,
        http_status: int | None = None,
        requests: int = 1,
    ) -> CurrencyCheck:
        return CurrencyCheck(
            slug=target.slug,
            domain=target.domain,
            currency=currency,
            passed=False,
            reason=reason,
            detail=detail,
            http_status=http_status,
            requests=requests,
        )

    domain = target.domain
    if not domain or not _HOSTNAME.match(domain):
        return fail("invalid_domain", f"merchant.domain gecersiz: {domain!r}", requests=0)

    limiter.wait()
    try:
        response = client.get(f"https://{domain}/meta.json")
    except httpx.TimeoutException:
        return fail("timeout", f"{TIMEOUT_SECONDS:g} sn icinde yanit yok")
    except httpx.TransportError as error:
        return fail("network_error", type(error).__name__)
    except Exception as error:  # noqa: BLE001 — bir magaza raporu durdurmaz
        return fail("request_error", type(error).__name__)

    status = response.status_code
    if not 200 <= status < 300:
        location = response.headers.get("Location", "")
        detail = f"yonlendirme izlenmez: {location[:120]}" if location else ""
        return fail(f"http_{status}", detail, http_status=status)

    try:
        payload = response.json()
    except ValueError:
        return fail("invalid_json", "yanit JSON degil", http_status=status)
    if not isinstance(payload, dict):
        return fail("invalid_json", "yanit JSON nesnesi degil", http_status=status)

    currency = payload.get("currency")
    if currency is None or currency == "":
        return fail("missing_currency", "meta.json `currency` tasimiyor", http_status=status)
    if not isinstance(currency, str):
        return fail("invalid_currency", f"`currency` metin degil: {currency!r}", http_status=status)
    if currency != SHOPIFY_CURRENCY:
        return fail(
            "currency_not_try",
            f"{currency} != {SHOPIFY_CURRENCY}",
            currency=currency,
            http_status=status,
        )

    return CurrencyCheck(
        slug=target.slug,
        domain=domain,
        currency=currency,
        passed=True,
        reason="ok",
        http_status=status,
        requests=1,
    )


def verify(
    targets: Sequence[MerchantTarget], client: httpx.Client, limiter: RateLimiter | None = None
) -> list[CurrencyCheck]:
    """Merchant'lari slug sirasiyla, sirayla dogrular."""
    limiter = limiter or RateLimiter()
    ordered = sorted(targets, key=lambda target: target.slug)
    return [check_merchant(client, target, limiter) for target in ordered]


def build_client() -> httpx.Client:
    # Yonlendirme izlenmez: izlemek ikinci istek demektir. Yeniden deneme
    # yok: httpx'in varsayilan tasimasi (retries=0) kullanilir.
    return httpx.Client(
        timeout=httpx.Timeout(TIMEOUT_SECONDS),
        follow_redirects=False,
        headers={"Accept": "application/json"},
    )


def format_report(results: Sequence[CurrencyCheck]) -> str:
    lines = [f"{'merchant':<28} {'currency':<9} {'result':<7} reason"]
    for check in results:
        reason = f"{check.reason} ({check.detail})" if check.detail else check.reason
        lines.append(f"{check.slug:<28} {check.currency or '-':<9} {check.result:<7} {reason}")
    passed = sum(check.passed for check in results)
    lines.append("")
    lines.append(f"summary: total={len(results)} pass={passed} fail={len(results) - passed}")
    return "\n".join(lines)


def report_json(results: Sequence[CurrencyCheck]) -> dict[str, object]:
    passed = sum(check.passed for check in results)
    return {
        "checked_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "endpoint": "/meta.json",
        "accepted_currency": SHOPIFY_CURRENCY,
        "requests_per_second": REQUESTS_PER_SECOND,
        "timeout_seconds": TIMEOUT_SECONDS,
        "summary": {"total": len(results), "pass": passed, "fail": len(results) - passed},
        "results": [{**asdict(check), "result": check.result} for check in results],
    }


def main(argv: list[str] | None = None, client: httpx.Client | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="collect.verify_currency",
        description="Shopify para birimi dogrulamasi (salt okunur, merchant basina tek istek)",
    )
    parser.add_argument("--merchant", action="append", help="merchant.slug (tekrarlanabilir)")
    parser.add_argument("--report", type=Path, help="JSON rapor yolu")
    args = parser.parse_args(argv)

    try:
        with connect() as conn:
            targets = load_targets(conn, args.merchant)
    except UnknownMerchant as error:
        print(str(error), file=sys.stderr)
        return 2
    if not targets:
        print("Dogrulanacak Shopify merchant'i yok.", file=sys.stderr)
        return 2

    # Veritabani baglantisi ag istekleri basladiginda KAPALIDIR.
    owned = client is None
    http = client or build_client()
    try:
        results = verify(targets, http)
    finally:
        if owned:
            http.close()

    print(format_report(results))
    if args.report:
        args.report.write_text(
            json.dumps(report_json(results), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return 0 if all(check.passed for check in results) else 1


if __name__ == "__main__":
    sys.exit(main())
