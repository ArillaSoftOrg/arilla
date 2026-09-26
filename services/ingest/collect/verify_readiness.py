"""Shopify aktivasyon hazirligi dogrulamasi — SALT OKUNUR (docs/decisions/0032).

    python -m collect.verify_readiness
    python -m collect.verify_readiness --merchant casadora-baby
    python -m collect.verify_readiness --report rapor.json

Yalnizca para birimi dogrulanmis (`currency = "TRY"`, `currency_verified =
true`) Shopify merchant'lari incelenir. Merchant basina EN FAZLA IKI istek:

1. `GET https://<domain>/robots.txt` — once robots. `/products.json`
   yasaksa, ya da politika guvenle belirlenemiyorsa urun istegi YAPILMAZ.
2. `GET https://<domain>/products.json?limit=5&page=1` — tek sayfa, en fazla
   5 urun. Ikinci sayfa asla istenmez.

Yeniden deneme yok, yonlendirme izlenmez, istekler sirayla ve saniyede en
fazla 1 (robots `Crawl-delay` daha uzunsa o), 10 sn zaman asimi. Kendimizi
tanitan user-agent (`collect/link/robots.USER_AGENT`) kullanilir.

Urun ornegi veritabanina YAZILMAZ: mevcut Shopify connector'u ve
`normalize()` ornek uzerinde bellekte, ag olmadan calistirilir — "bugunku
boru hatti bu veriyi tuketebilir mi" sorusunun cevabi gercek kodla verilir.

Sonuc merchant basina ayri alanlardir (robots, urun ornegi, fiyatlar,
secenek eslemesi) ve bir genel karar:

- READY: tum kanit olumlu. Aktivasyon YINE AYRI, onayli bir adimdir.
- NOT_READY: en az bir kontrol olumsuz (robots yasagi, bozuk ornek, gecersiz
  fiyat, mevcut eslemenin yanlis oldugu gosterildi).
- REVIEW: olumsuz bir sey yok ama kanit yetersiz (esleme UNKNOWN, cok uzun
  Crawl-delay). Insan karari gerekir.

Bu komut HICBIR SEY YAZMAZ: veritabani baglantisi `read_only` acilir ve ag
istekleri baslamadan kapanir.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote
from urllib.robotparser import RobotFileParser

import httpx
import psycopg

from collect.gate import SHOPIFY_CURRENCY
from collect.link.robots import BOT_NAME, BOT_VERSION, USER_AGENT
from collect.mapping import FieldMapping, ValueFormats
from collect.normalize import normalize
from collect.records import RecordRejected
from collect.sources.shopify import ShopifyConnector, _option_by_name, _option_key
from collect.verify_currency import (
    _HOSTNAME,
    REQUESTS_PER_SECOND,
    TIMEOUT_SECONDS,
    RateLimiter,
    UnknownMerchant,
)
from db.connection import connect

#: Urun ornegi boyutu. Istek `limit` ile bunu ister; sunucu fazlasini
#: dondururse fazlasi incelenmez.
SAMPLE_SIZE = 5

#: robots.txt'in izin vermesi gereken yollar: ornek istegi ve toplamanin
#: kendi istek bicimi (`collect/sources/shopify.py`: `?page=N&limit=M`).
ROBOTS_PATHS = (
    "/products.json",
    f"/products.json?limit={SAMPLE_SIZE}&page=1",
    "/products.json?page=1&limit=30",
)

#: Bundan uzun bir Crawl-delay istenirse ornek istegi atilmaz; karar insana
#: birakilir (REVIEW).
MAX_CRAWL_DELAY_SECONDS = 30.0

#: Ad tabanli secenek eslemesi icin repo sozlesmesi: bootstrap manifesti
#: (docs/decisions/0027) `color_option_names` / `size_option_names`'i burada
#: tanimliyor. Ikinci bir liste uydurulmaz.
CONVENTIONS_PATH = Path(__file__).resolve().parents[1] / "bootstrap" / "shopify_merchants.json"

SELECT_MERCHANTS = """
SELECT slug, domain, feed_config FROM merchant
 WHERE source_type = 'shopify'
 ORDER BY slug
"""


# --- veri tipleri ------------------------------------------------------------


@dataclass(frozen=True)
class OptionConventions:
    colour: tuple[str, ...]
    size: tuple[str, ...]


def load_conventions(path: Path = CONVENTIONS_PATH) -> OptionConventions:
    defaults = json.loads(path.read_text(encoding="utf-8")).get("defaults") or {}
    colour = tuple(str(name) for name in defaults.get("color_option_names") or ())
    size = tuple(str(name) for name in defaults.get("size_option_names") or ())
    if not colour or not size:
        raise ValueError(f"{path}: color_option_names / size_option_names tanimli degil")
    return OptionConventions(colour=colour, size=size)


@dataclass(frozen=True)
class Target:
    slug: str
    domain: str | None
    feed_config: dict[str, Any] = field(compare=False)


class IneligibleMerchant(LookupError):
    pass


@dataclass
class RobotsCheck:
    status: str  # PASS / FAIL
    reason: str
    requests: int = 0
    http_status: int | None = None
    crawl_delay: float | None = None


@dataclass
class ProductCheck:
    status: str  # PASS / FAIL / SKIPPED
    reason: str
    requests: int = 0
    http_status: int | None = None
    product_count: int = 0
    variant_count: int = 0
    records_normalized: int = 0
    records_rejected: int = 0
    rejection_reasons: list[str] = field(default_factory=list)


@dataclass
class PricesCheck:
    status: str  # PASS / FAIL / SKIPPED
    reason: str
    variants_checked: int = 0
    invalid: int = 0


@dataclass
class ObservedOption:
    name: str
    role: str  # colour / size / title / unknown
    positions: list[int]


@dataclass
class MappingCheck:
    status: str  # PASS / FAIL / UNKNOWN
    reason: str
    observed_options: list[ObservedOption] = field(default_factory=list)
    current: dict[str, Any] = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)
    recommended: dict[str, Any] | None = None


@dataclass
class ReadinessResult:
    slug: str
    domain: str | None
    robots: RobotsCheck
    product_sample: ProductCheck
    prices: PricesCheck
    mapping: MappingCheck
    overall: str  # READY / NOT_READY / REVIEW
    overall_reason: str

    @property
    def requests(self) -> int:
        return self.robots.requests + self.product_sample.requests


# --- aday secimi ---------------------------------------------------------------


def eligibility(feed_config: object) -> str | None:
    """Uygunsa `None`, degilse neden. Kapinin (collect/gate.py) para birimi
    kuraliyla ayni: tam JSON `true` ve tam `"TRY"`."""
    if not isinstance(feed_config, dict):
        return "feed_config_invalid"
    if feed_config.get("currency_verified") is not True:
        return "currency_unverified"
    if feed_config.get("currency") != SHOPIFY_CURRENCY:
        return "currency_not_try"
    return None


def load_targets(
    conn: psycopg.Connection, slugs: Sequence[str] | None = None
) -> tuple[list[Target], list[dict[str, str]]]:
    """Adaylar ve disarida birakilanlar. Baglanti salt okunur yapilir."""
    conn.read_only = True
    with conn.cursor() as cur:
        cur.execute(SELECT_MERCHANTS)
        rows = cur.fetchall()
    conn.rollback()

    by_slug = {str(row[0]): Target(str(row[0]), row[1], row[2] or {}) for row in rows}
    if slugs:
        missing = sorted(set(slugs) - set(by_slug))
        if missing:
            raise UnknownMerchant(f"Shopify merchant'i bulunamadi: {', '.join(missing)}")
        refused = [
            f"{slug} ({reason})"
            for slug in sorted(set(slugs))
            if (reason := eligibility(by_slug[slug].feed_config))
        ]
        if refused:
            raise IneligibleMerchant(
                "para birimi dogrulanmamis, hazirlik incelenmez: " + ", ".join(refused)
            )
        return [by_slug[slug] for slug in sorted(set(slugs))], []

    targets: list[Target] = []
    excluded: list[dict[str, str]] = []
    for slug, target in sorted(by_slug.items()):
        reason = eligibility(target.feed_config)
        if reason:
            excluded.append({"slug": slug, "reason": reason})
        else:
            targets.append(target)
    return targets, excluded


# --- robots.txt ----------------------------------------------------------------


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


def evaluate_robots(text: str) -> tuple[str | None, float | None]:
    """robots.txt metni -> (yasak nedeni ya da None, Crawl-delay).

    Yorum repo ile aynidir (`urllib.robotparser`, `collect/link/robots.py`).
    Standart kutuphane `*`/`$` joker karakterlerini ANLAMAZ ve
    `Disallow: /*.json`'u izin sanar; bizim gruba uygulanan ve hedef yolla
    eslesen joker bir yasak varsa politika guvenle belirlenemez sayilir.
    """
    parser = RobotFileParser()
    parser.parse(text.splitlines())
    for path in ROBOTS_PATHS:
        if not parser.can_fetch(USER_AGENT, path):
            return f"robots_disallowed ({path})", None

    entry = _applicable_entry(parser, USER_AGENT)
    for rule in getattr(entry, "rulelines", []) if entry else []:
        pattern = unquote(rule.path)
        if rule.allowance or not ("*" in pattern or "$" in pattern):
            continue
        for path in ROBOTS_PATHS:
            if _wildcard_matches(pattern, path):
                return f"robots_wildcard_disallow ({pattern} ~ {path})", None

    delay = parser.crawl_delay(USER_AGENT)
    return None, float(delay) if delay is not None else None


def check_robots(client: httpx.Client, target: Target, limiter: RateLimiter) -> RobotsCheck:
    domain = target.domain
    if not domain or not _HOSTNAME.match(domain):
        return RobotsCheck("FAIL", f"invalid_domain ({domain!r})")

    limiter.wait()
    try:
        response = client.get(f"https://{domain}/robots.txt")
    except httpx.TimeoutException:
        return RobotsCheck("FAIL", "timeout", requests=1)
    except httpx.TransportError as error:
        return RobotsCheck("FAIL", f"network_error ({type(error).__name__})", requests=1)
    except Exception as error:  # noqa: BLE001 — bir magaza raporu durdurmaz
        return RobotsCheck("FAIL", f"request_error ({type(error).__name__})", requests=1)

    status = response.status_code
    if status == 404:
        # Repo sozlesmesi (collect/link/robots.py): robots.txt yoksa kural yok.
        return RobotsCheck("PASS", "no_robots_txt (404: kural yok)", requests=1, http_status=404)
    if status != 200:
        location = response.headers.get("Location", "")
        detail = f" -> {location[:120]}" if location else ""
        return RobotsCheck("FAIL", f"http_{status}{detail}", requests=1, http_status=status)

    content_type = response.headers.get("Content-Type", "").lower()
    if content_type and not content_type.startswith("text/plain"):
        return RobotsCheck(
            "FAIL",
            f"robots_unusable (content-type {content_type[:40]})",
            requests=1,
            http_status=status,
        )
    try:
        text = response.text
    except Exception:  # noqa: BLE001 — cozulemeyen govde: politika belirlenemez
        return RobotsCheck(
            "FAIL", "robots_unusable (govde okunamadi)", requests=1, http_status=status
        )

    refusal, delay = evaluate_robots(text)
    if refusal:
        return RobotsCheck("FAIL", refusal, requests=1, http_status=status)
    return RobotsCheck("PASS", "allowed", requests=1, http_status=status, crawl_delay=delay)


# --- urun ornegi -----------------------------------------------------------------


def _structure_problem(products: list[Any]) -> tuple[str | None, int]:
    """Connector'un bekledigi yapi: urun nesnesi, bos olmayan varyant listesi,
    her varyantta `price` ve `available` (esleme `availability: available`)."""
    variants_total = 0
    for product in products:
        if not isinstance(product, dict) or product.get("id") is None:
            return "malformed_product", variants_total
        variants = product.get("variants")
        if not isinstance(variants, list) or not variants:
            return "malformed_variants (varyant yok)", variants_total
        for variant in variants:
            if not isinstance(variant, dict) or "price" not in variant:
                return "malformed_variants (price yok)", variants_total
            if "available" not in variant:
                return "missing_availability", variants_total
            variants_total += 1
    return None, variants_total


def fetch_sample(
    client: httpx.Client, target: Target, limiter: RateLimiter, crawl_delay: float | None
) -> tuple[ProductCheck, list[dict[str, Any]] | None]:
    if crawl_delay is not None and crawl_delay > MAX_CRAWL_DELAY_SECONDS:
        return ProductCheck("SKIPPED", f"crawl_delay_too_long ({crawl_delay:g} sn)"), None

    limiter.wait(at_least=crawl_delay or 0.0)
    try:
        response = client.get(
            f"https://{target.domain}/products.json", params={"limit": SAMPLE_SIZE, "page": 1}
        )
    except httpx.TimeoutException:
        return ProductCheck("FAIL", "timeout", requests=1), None
    except httpx.TransportError as error:
        return ProductCheck("FAIL", f"network_error ({type(error).__name__})", requests=1), None
    except Exception as error:  # noqa: BLE001
        return ProductCheck("FAIL", f"request_error ({type(error).__name__})", requests=1), None

    status = response.status_code
    if status != 200:
        return ProductCheck("FAIL", f"http_{status}", requests=1, http_status=status), None
    try:
        payload = response.json()
    except ValueError:
        return ProductCheck("FAIL", "invalid_json", requests=1, http_status=status), None
    if not isinstance(payload, dict) or not isinstance(payload.get("products"), list):
        return ProductCheck("FAIL", "missing_products", requests=1, http_status=status), None

    products = payload["products"][:SAMPLE_SIZE]
    if not products:
        return ProductCheck("FAIL", "empty_products", requests=1, http_status=status), None

    problem, variant_count = _structure_problem(products)
    check = ProductCheck(
        "FAIL" if problem else "PASS",
        problem or "ok",
        requests=1,
        http_status=status,
        product_count=len(products),
        variant_count=variant_count,
    )
    return check, (None if problem else products)


def consume_offline(products: list[dict[str, Any]], target: Target, check: ProductCheck) -> None:
    """Ornegi GERCEK connector + normalize ile, agsiz ve veritabanisiz isler."""
    payload = {"products": products}

    def serve(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params.get("page", 1))
        return httpx.Response(200, json=payload if page == 1 else {"products": []})

    try:
        mapping = FieldMapping.from_config(target.feed_config)
        connector = ShopifyConnector(
            base_url=f"https://{target.domain}/products.json",
            config=target.feed_config,
            client=httpx.Client(transport=httpx.MockTransport(serve)),
        )
        records = list(connector.fetch())
    except ValueError as error:
        check.status, check.reason = "FAIL", f"config_invalid ({str(error)[:120]})"
        return

    reasons: set[str] = set()
    for record in records:
        try:
            normalize(record, mapping)
        except RecordRejected as error:
            check.records_rejected += 1
            # Yalnizca neden kodu; urun kimligi/basligi rapora girmez.
            reasons.add(str(error).split(":", 1)[0])
        else:
            check.records_normalized += 1
    check.rejection_reasons = sorted(reasons)
    if check.records_normalized == 0:
        check.status, check.reason = "FAIL", "not_consumable (hicbir kayit normalize edilemedi)"


def check_prices(products: list[dict[str, Any]], feed_config: dict[str, Any]) -> PricesCheck:
    formats = ValueFormats.from_config(feed_config)
    checked = invalid = 0
    for product in products:
        for variant in product.get("variants") or []:
            checked += 1
            try:
                price = formats.parse_price(variant.get("price"))
            except RecordRejected:
                price = None
            if price is None or price <= 0:
                invalid += 1
    if invalid:
        return PricesCheck(
            "FAIL", f"{invalid}/{checked} varyant fiyati gecersiz ya da <= 0", checked, invalid
        )
    return PricesCheck("PASS", "ok", checked, 0)


# --- secenek eslemesi --------------------------------------------------------


def _option_at(product: dict[str, Any], field_name: str | None) -> dict[str, Any] | None:
    """`option2` -> urunun 2. secenegi (`_option_by_name` ile ayni numaralama)."""
    if not field_name or not field_name.startswith("option"):
        return None
    try:
        index = int(field_name.removeprefix("option"))
    except ValueError:
        return None
    options = [o for o in product.get("options") or [] if isinstance(o, dict)]
    return options[index - 1] if 1 <= index <= len(options) else None


def _multi_valued(option: dict[str, Any] | None) -> bool:
    return option is not None and len(option.get("values") or []) > 1


def analyse_mapping(
    products: list[dict[str, Any]], feed_config: dict[str, Any], conventions: OptionConventions
) -> MappingCheck:
    transport = feed_config.get("transport") or {}
    shopify = transport.get("shopify") or {}
    colour_names = shopify.get("color_option_names")
    size_names = shopify.get("size_option_names")
    positional_colour = shopify.get("color_option")
    size_field = ((feed_config.get("mapping") or {}).get("variants") or {}).get("size")
    current = {
        "color_option": positional_colour,
        "color_option_names": colour_names,
        "size_option_names": size_names,
        "variants_size": size_field,
    }

    colour_keys = {_option_key(name) for name in conventions.colour}
    size_keys = {_option_key(name) for name in conventions.size}

    def role(name: str) -> str:
        key = _option_key(name)
        if key in colour_keys:
            return "colour"
        if key in size_keys:
            return "size"
        return "title" if key == "title" else "unknown"

    observed: dict[str, ObservedOption] = {}
    issues: list[str] = []
    has_colour_or_size = False

    for index, product in enumerate(products, start=1):
        for position, option in enumerate(product.get("options") or [], start=1):
            if not isinstance(option, dict):
                continue
            name = str(option.get("name") or "").strip()
            entry = observed.setdefault(_option_key(name), ObservedOption(name, role(name), []))
            if position not in entry.positions:
                entry.positions.append(position)
            if entry.role in {"colour", "size"}:
                has_colour_or_size = True

        actual_colour = _option_by_name(product, list(conventions.colour))
        actual_size = _option_by_name(product, list(conventions.size))
        # Connector'un BUGUNKU yapilandirmayla sectigi alanlar (shopify.fetch).
        used_colour = _option_by_name(product, colour_names) if colour_names else positional_colour
        used_size = _option_by_name(product, size_names) if size_field == "size" else size_field

        used_colour_option = _option_at(product, used_colour)
        if used_colour != actual_colour:
            if (
                used_colour_option is not None
                and role(str(used_colour_option.get("name"))) == "size"
            ):
                issues.append(
                    f"urun {index}: renk bolmesi beden secenegini kullaniyor "
                    f"('{used_colour_option.get('name')}' = {used_colour}); "
                    "bedenler ayri offer olur"
                )
            elif actual_colour and _multi_valued(_option_at(product, actual_colour)):
                issues.append(
                    f"urun {index}: renk secenegi {actual_colour}, esleme {used_colour} ile "
                    "boluyor; renkler tek offer'da birlesir"
                )

        used_size_option = _option_at(product, used_size)
        if used_size != actual_size:
            if used_size_option is not None and role(str(used_size_option.get("name"))) == "colour":
                issues.append(
                    f"urun {index}: beden alani renk secenegini okuyor "
                    f"('{used_size_option.get('name')}' = {used_size})"
                )
            elif actual_size and _multi_valued(_option_at(product, actual_size)):
                issues.append(
                    f"urun {index}: beden secenegi {actual_size}, esleme {used_size} okuyor"
                )

    observed_list = sorted(observed.values(), key=lambda o: (min(o.positions), o.name))
    unknown = [o.name for o in observed_list if o.role == "unknown"]
    recommended = (
        None
        if unknown
        else {
            "transport.shopify.color_option_names": list(conventions.colour),
            "transport.shopify.size_option_names": list(conventions.size),
            "mapping.variants.size": "size",
        }
    )

    if issues:
        status, reason = "FAIL", "mevcut konumsal esleme ornekle celisiyor"
    elif unknown:
        status, reason = "UNKNOWN", f"tanınmayan secenek adlari: {', '.join(unknown)}"
    elif not has_colour_or_size:
        status, reason = "UNKNOWN", "ornekte renk/beden secenegi yok; esleme dogrulanamadi"
    else:
        status, reason = "PASS", "mevcut esleme ornekle uyumlu"
    return MappingCheck(status, reason, observed_list, current, issues, recommended)


# --- karar ve kosu -------------------------------------------------------------


def overall(result: ReadinessResult) -> tuple[str, str]:
    if result.robots.status != "PASS":
        return "NOT_READY", f"robots: {result.robots.reason}"
    if result.product_sample.status == "SKIPPED":
        return "REVIEW", f"product_sample: {result.product_sample.reason}"
    if result.product_sample.status != "PASS":
        return "NOT_READY", f"product_sample: {result.product_sample.reason}"
    if result.prices.status != "PASS":
        return "NOT_READY", f"prices: {result.prices.reason}"
    if result.mapping.status == "FAIL":
        return "NOT_READY", "mapping: mevcut esleme yanlis; once ad tabanli esleme (recommended)"
    if result.mapping.status != "PASS":
        return "REVIEW", f"mapping: {result.mapping.reason}"
    return "READY", "tum kontroller olumlu"


def check_target(
    client: httpx.Client, target: Target, limiter: RateLimiter, conventions: OptionConventions
) -> ReadinessResult:
    robots = check_robots(client, target, limiter)
    product = ProductCheck("SKIPPED", "robots FAIL: urun istegi yapilmadi")
    prices = PricesCheck("SKIPPED", "ornek yok")
    mapping = MappingCheck("UNKNOWN", "ornek yok")

    if robots.status == "PASS":
        product, products = fetch_sample(client, target, limiter, robots.crawl_delay)
        if products is not None:
            consume_offline(products, target, product)
            prices = check_prices(products, target.feed_config)
            mapping = analyse_mapping(products, target.feed_config, conventions)

    result = ReadinessResult(target.slug, target.domain, robots, product, prices, mapping, "", "")
    result.overall, result.overall_reason = overall(result)
    return result


def verify(
    targets: Sequence[Target],
    client: httpx.Client,
    limiter: RateLimiter | None = None,
    conventions: OptionConventions | None = None,
) -> list[ReadinessResult]:
    limiter = limiter or RateLimiter()
    conventions = conventions or load_conventions()
    ordered = sorted(targets, key=lambda target: target.slug)
    return [check_target(client, target, limiter, conventions) for target in ordered]


def build_client() -> httpx.Client:
    # Yonlendirme izlenmez, yeniden deneme yok (httpx varsayilani retries=0).
    return httpx.Client(
        timeout=httpx.Timeout(TIMEOUT_SECONDS),
        follow_redirects=False,
        headers={"User-Agent": USER_AGENT},
    )


def format_report(results: Sequence[ReadinessResult]) -> str:
    header = f"{'merchant':<26} {'robots':<7} {'sample':<8} {'prices':<8} {'mapping':<8} overall"
    lines = [header]
    for r in results:
        lines.append(
            f"{r.slug:<26} {r.robots.status:<7} {r.product_sample.status:<8} "
            f"{r.prices.status:<8} {r.mapping.status:<8} {r.overall:<9} {r.overall_reason}"
        )
    counts = {v: sum(r.overall == v for r in results) for v in ("READY", "NOT_READY", "REVIEW")}
    lines.append("")
    lines.append(
        f"summary: total={len(results)} ready={counts['READY']} "
        f"not_ready={counts['NOT_READY']} review={counts['REVIEW']} "
        f"requests={sum(r.requests for r in results)}"
    )
    return "\n".join(lines)


def report_json(
    results: Sequence[ReadinessResult], excluded: Sequence[dict[str, str]] = ()
) -> dict[str, Any]:
    return {
        "checked_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "endpoints": ["/robots.txt", f"/products.json?limit={SAMPLE_SIZE}&page=1"],
        # Yalnizca urun belirteci; APP_URL gibi ortam degerleri rapora girmez.
        "user_agent_token": f"{BOT_NAME}/{BOT_VERSION}",
        "requests_per_second": REQUESTS_PER_SECOND,
        "timeout_seconds": TIMEOUT_SECONDS,
        "sample_size": SAMPLE_SIZE,
        "summary": {
            "total": len(results),
            "ready": sum(r.overall == "READY" for r in results),
            "not_ready": sum(r.overall == "NOT_READY" for r in results),
            "review": sum(r.overall == "REVIEW" for r in results),
            "requests": sum(r.requests for r in results),
        },
        "excluded": list(excluded),
        "results": [{**asdict(r), "requests": r.requests} for r in results],
    }


def main(argv: list[str] | None = None, client: httpx.Client | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="collect.verify_readiness",
        description="Shopify aktivasyon hazirligi (salt okunur, merchant basina en fazla 2 istek)",
    )
    parser.add_argument("--merchant", action="append", help="merchant.slug (tekrarlanabilir)")
    parser.add_argument("--report", type=Path, help="JSON rapor yolu")
    args = parser.parse_args(argv)

    conventions = load_conventions()
    try:
        with connect() as conn:
            targets, excluded = load_targets(conn, args.merchant)
    except (UnknownMerchant, IneligibleMerchant) as error:
        print(str(error), file=sys.stderr)
        return 2
    if not targets:
        print("Hazirligi incelenecek Shopify merchant'i yok.", file=sys.stderr)
        return 2

    # Veritabani baglantisi ag istekleri basladiginda KAPALIDIR.
    owned = client is None
    http = client or build_client()
    try:
        results = verify(targets, http, conventions=conventions)
    finally:
        if owned:
            http.close()

    print(format_report(results))
    if excluded:
        print("excluded: " + ", ".join(f"{e['slug']} ({e['reason']})" for e in excluded))
    if args.report:
        args.report.write_text(
            json.dumps(report_json(results, excluded), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return 0 if all(r.overall == "READY" for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
