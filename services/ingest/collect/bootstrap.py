"""Gecici Shopify bootstrap katalogu (docs/decisions/0027).

    python -m collect.bootstrap --manifest bootstrap/shopify_merchants.json
    python -m collect.bootstrap --manifest ... --report rapor.json

Admitad/gercek feed gelene kadar arama, eslestirme ve gorsel benzerligi gercek
ve cesitli urunlerle denemek icin. Uc kural:

1. **Yalnizca yerel veritabani.** `DATABASE_URL` localhost degilse kosu
   baslamaz; `--allow-remote` bilincli bir istisnadir.
2. **Ayirt edilebilirlik.** Her merchant `feed_config.bootstrap_source =
   "bootstrap_shopify"` tasir; sema degismez. Offer ve product'lar merchant
   uzerinden bulunur, temizlik de oradan yapilir (docs/ops.md).
3. **Sorumlu toplama.** Merchant'lar SIRAYLA islenir (eszamanlilik 1); oran
   siniri, sinirli yeniden deneme ve urun tavani manifestten `feed_config`'e
   yazilir, connector bunlari uygular.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import psycopg

from collect.pipeline import run_ingest
from db.connection import connect, database_url

logger = logging.getLogger(__name__)

BOOTSTRAP_SOURCE = "bootstrap_shopify"

#: Toplam katalog sert tavani (kanonik Shopify urunu). Manifest bunu asarsa
#: kosu baslamaz.
HARD_CAP = 3500

#: Shopify `/products.json` icin ortak eslemesi (0018 ile ayni).
SHOPIFY_MAPPING: dict[str, Any] = {
    "external_id": "external_id",
    "url": "url",
    "title": "title",
    "brand": "vendor",
    "category": "product_type",
    "price": "price",
    "list_price": "compare_at_price",
    "image_url": "image_url",
    "variants": {
        "path": "variants",
        # Connector beden secenegini ADIYLA bulup `size` alanina yazar.
        "size": "size",
        "availability": "available",
        "external_id": "id",
        "price": "price",
        "sku": "sku",
    },
}

UPSERT_MERCHANT = """
INSERT INTO merchant (slug, name, domain, source_type, feed_url, feed_config, is_active)
VALUES (%(slug)s, %(name)s, %(domain)s, 'shopify', %(feed_url)s, %(feed_config)s, TRUE)
ON CONFLICT (domain) DO UPDATE SET
    feed_url    = EXCLUDED.feed_url,
    feed_config = EXCLUDED.feed_config,
    is_active   = TRUE,
    updated_at  = now()
RETURNING id, slug
"""


@dataclass(frozen=True)
class BootstrapMerchant:
    slug: str
    name: str
    domain: str
    category_hint: str
    max_products: int
    #: Shopify `vendor` bazi magazalarda markayi degil magazanin kendisini
    #: tasir ("Sasha Kozmetik"). O zaman marka eslenmez: yanlis marka,
    #: eslestirmede marka vetosuyla dogru adaylari keser (0029).
    map_brand: bool = True

    @property
    def feed_url(self) -> str:
        return f"https://{self.domain}/products.json"

    def feed_config(
        self, defaults: dict[str, Any], provenance: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        shopify: dict[str, Any] = {
            "max_products": self.max_products,
            "color_option_names": list(defaults.get("color_option_names", [])),
            "size_option_names": list(defaults.get("size_option_names", [])),
        }
        return {
            "bootstrap_source": BOOTSTRAP_SOURCE,
            "category_hint": self.category_hint,
            **currency_config(provenance),
            "transport": {
                "pagination": {"size": int(defaults.get("page_size", 250))},
                "rate_limit": {
                    "requests_per_second": float(defaults.get("requests_per_second", 0.5))
                },
                "retry": {
                    "max_retries": int(defaults.get("max_retries", 2)),
                    "backoff_seconds": float(defaults.get("backoff_seconds", 5)),
                    "max_backoff_seconds": float(defaults.get("max_backoff_seconds", 60)),
                },
                "shopify": shopify,
            },
            "mapping": (
                SHOPIFY_MAPPING
                if self.map_brand
                else {key: value for key, value in SHOPIFY_MAPPING.items() if key != "brand"}
            ),
            "value_formats": {"decimal_separator": ".", "thousands_separator": ","},
        }


@dataclass
class SourceReport:
    slug: str
    domain: str
    started_at: str
    status: str = "not_started"
    records_discovered: int = 0
    offers_created: int = 0
    offers_updated: int = 0
    rejected: int = 0
    variants_written: int = 0
    duration_seconds: float = 0.0
    errors: list[str] = field(default_factory=list)


#: Para birimi kanitinin kabul edildigi guven duzeyleri. "medium": taban para
#: birimi TRY ama magaza Shopify Markets ile baska ulkelere baska para birimi
#: gosterebilir; kok yoldan, cerezsiz istekte TRY dogrulandi.
ACCEPTED_CURRENCY_CONFIDENCE = frozenset({"high", "medium"})


def currency_config(provenance: dict[str, Any] | None) -> dict[str, Any]:
    """`feed_config` para birimi alanlari (docs/decisions/0029).

    Kanit yoksa ya da "UNKNOWN" ise `currency_verified = false`: normalize
    kayitlari reddeder, TRY uydurulmaz.
    """
    if not provenance:
        return {"currency_verified": False}
    currency = str(provenance.get("currency") or "UNKNOWN").upper()
    confidence = str(provenance.get("confidence") or "none")
    verified = currency != "UNKNOWN" and confidence in ACCEPTED_CURRENCY_CONFIDENCE
    return {
        "currency": currency if verified else None,
        "currency_verified": verified,
        "currency_evidence": {
            "confidence": confidence,
            "sources": sorted({str(e.get("source")) for e in provenance.get("evidence") or []}),
            "verified_at": max(
                (str(e.get("fetched_at")) for e in provenance.get("evidence") or []),
                default=None,
            ),
            "multi_currency_signals": provenance.get("multi_currency_signals"),
        },
    }


def load_provenance(path: Path) -> dict[str, dict[str, Any]]:
    """`currency_provenance.json` -> slug -> kayit. Dosya yoksa bos."""
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {entry["slug"]: entry for entry in raw.get("merchants", [])}


def load_manifest(path: Path) -> tuple[dict[str, Any], list[BootstrapMerchant]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    merchants = [BootstrapMerchant(**entry) for entry in raw["merchants"]]
    total = sum(m.max_products for m in merchants)
    if total > HARD_CAP:
        raise ValueError(f"manifest toplam tavani {total} > sert tavan {HARD_CAP}")
    slugs = [m.slug for m in merchants]
    if len(set(slugs)) != len(slugs):
        raise ValueError("manifestte tekrarli slug var")
    return raw.get("defaults", {}), merchants


def is_local_database(url: str) -> bool:
    host = urlparse(url).hostname or ""
    return host in {"localhost", "127.0.0.1", "::1"}


def register_merchant(
    conn: psycopg.Connection,
    merchant: BootstrapMerchant,
    defaults: dict[str, Any],
    provenance: dict[str, Any] | None = None,
) -> str:
    """Merchant'i kaydeder ya da feed ayarini gunceller; kayitli slug'i dondurur.

    Alan adi 0018 ile zaten kayitliysa o satir yeniden kullanilir (slug
    degismez) — ayni magaza iki merchant olmamali.
    """
    with conn.cursor() as cur:
        cur.execute(
            UPSERT_MERCHANT,
            {
                "slug": merchant.slug,
                "name": merchant.name,
                "domain": merchant.domain,
                "feed_url": merchant.feed_url,
                "feed_config": json.dumps(
                    merchant.feed_config(defaults, provenance), ensure_ascii=False
                ),
            },
        )
        row = cur.fetchone()
    conn.commit()
    assert row is not None
    return str(row[1])


def run(
    conn: psycopg.Connection,
    defaults: dict[str, Any],
    merchants: list[BootstrapMerchant],
    provenance: dict[str, dict[str, Any]] | None = None,
    register_only: bool = False,
) -> list[SourceReport]:
    reports: list[SourceReport] = []
    for merchant in merchants:
        report = SourceReport(
            slug=merchant.slug,
            domain=merchant.domain,
            started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )
        logger.info("kaynak basladi %s (%s)", merchant.slug, merchant.domain)
        started = time.monotonic()
        try:
            slug = register_merchant(
                conn, merchant, defaults, (provenance or {}).get(merchant.slug)
            )
            if register_only:
                report.status = "registered"
                reports.append(report)
                continue
            result = run_ingest(conn, slug)
        except Exception as error:  # noqa: BLE001 — bir magaza digerlerini durdurmaz
            report.status = "failed"
            report.errors.append(str(error)[:300])
        else:
            report.status = result.status
            if result.refusal:
                report.errors.append(f"refused:{result.refusal}")
            report.records_discovered = result.offers_seen
            report.offers_created = result.counts.offers_created
            report.offers_updated = result.counts.offers_updated
            report.rejected = result.rejected
            report.variants_written = result.counts.variants_written
        report.duration_seconds = round(time.monotonic() - started, 1)
        logger.info(
            "kaynak bitti %s status=%s kesfedilen=%d yeni=%d guncellenen=%d atlanan=%d sure=%.1fs",
            report.slug,
            report.status,
            report.records_discovered,
            report.offers_created,
            report.offers_updated,
            report.rejected,
            report.duration_seconds,
        )
        reports.append(report)
    return reports


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="collect.bootstrap")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--only", nargs="*", help="yalnizca bu slug'lar")
    parser.add_argument("--report", type=Path, help="kaynak basina JSON rapor yolu")
    parser.add_argument(
        "--allow-remote",
        action="store_true",
        help="localhost disi DATABASE_URL'e izin ver (production'a ASLA)",
    )
    parser.add_argument(
        "--currency-provenance",
        type=Path,
        help="para birimi kaniti (varsayilan: manifestin yanindaki currency_provenance.json)",
    )
    parser.add_argument(
        "--register-only",
        action="store_true",
        help="yalnizca merchant satirlarini/feed_config'i guncelle, magazaya istek atma",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    if not is_local_database(database_url()) and not args.allow_remote:
        # Degeri yazdirma: parola icerir.
        print("DATABASE_URL yerel degil; bootstrap yalnizca yerel veritabanina yazar.")
        return 2

    defaults, merchants = load_manifest(args.manifest)
    if args.only:
        merchants = [m for m in merchants if m.slug in set(args.only)]

    provenance = load_provenance(
        args.currency_provenance or args.manifest.parent / "currency_provenance.json"
    )

    with connect() as conn:
        reports = run(conn, defaults, merchants, provenance, args.register_only)

    if args.report:
        args.report.write_text(
            json.dumps([asdict(r) for r in reports], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    ok = {"registered"} if args.register_only else {"success"}
    return 0 if all(r.status in ok for r in reports) else 1


if __name__ == "__main__":
    sys.exit(main())
