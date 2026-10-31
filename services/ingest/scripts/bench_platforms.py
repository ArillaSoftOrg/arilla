"""Surec ici (in-process) tasima/akis kiyaslamasi. Veritabani YOK, ag YOK, yalniz stdlib.

    python scripts/bench_platforms.py [--n 200000]

Olcer: sentetik ilanlarla saf Python hizi (ilan/sn). Bu sayilar veritabani, indeks, WAL ya da
ag maliyetini ICERMEZ; bir platformun uretim hizini ASLA tek basina belirlemez. Amac: Python
tarafinin darbogaz olup olmadigini ve regresyonu gormek (bkz. docs/platform-scale.md).
"""

from __future__ import annotations

import argparse
import sys
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from catalog_build import policy as catalog_policy  # noqa: E402
from platforms.constraints import SourceConstraints, UpdateLimits  # noqa: E402
from platforms.contract import CanonicalListing, Checkpoint  # noqa: E402
from platforms.flow import (  # noqa: E402
    BatchResult,
    ChangeFilter,
    FilteringSink,
    listing_fingerprint,
    run_source,
)

OBSERVED = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


def make_listing(i: int, price_shift: int = 0) -> CanonicalListing:
    return CanonicalListing(
        platform="hepsiburada",
        listing_id=f"HB{i:09d}",
        title=f"Marka Model {i} Kablosuz Kulaklik Siyah 64 GB",
        url=f"https://www.hepsiburada.com/urun-adi-p-HB{i:09d}",
        currency="TRY",
        observed_at=OBSERVED,
        price=10_000 + (i % 5_000) * 100 + price_shift,
        list_price=20_000,
        in_stock=True,
        seller_id=f"S{i % 3000}",
        brand="Marka",
        category_path=("Elektronik", "Kulaklik"),
        image_urls=(f"https://img.example.test/{i}.jpg",),
    )


def rate(name: str, n: int, seconds: float, extra: str = "") -> None:
    print(f"{name:<58} {n / seconds:>12,.0f} ilan/sn   ({seconds:6.2f} sn){extra}")


def timed(fn: Callable[[], object]) -> tuple[object, float]:
    start = time.perf_counter()
    out = fn()
    return out, time.perf_counter() - start


class NullSink:
    def write_batch(self, listings: list[CanonicalListing]) -> BatchResult:
        return BatchResult(written=len(listings))


class NullStore:
    def load(self, key: str) -> Checkpoint | None:
        return None

    def save(self, key: str, checkpoint: Checkpoint) -> None:
        pass


class SyntheticAdapter:
    platform = "hepsiburada"
    kind = "json"

    def __init__(self, listings: list[CanonicalListing]) -> None:
        self._listings = listings

    def fetch(self, checkpoint: Checkpoint | None = None):
        yield from self._listings


def bench_flow(listings: list[CanonicalListing], batch_size: int, sink=None) -> float:
    constraints = SourceConstraints(
        update=UpdateLimits(
            requests_per_minute=10**9,  # hiz siniri kapali: yalniz kosucu maliyeti
            max_concurrency=1,
            batch_size=batch_size,
        )
    )
    _, secs = timed(
        lambda: run_source(
            SyntheticAdapter(listings),
            sink or NullSink(),
            constraints,
            store=NullStore(),
            clock=time.monotonic,
            sleep=lambda s: None,
            burst=10**6,
        )
    )
    return secs


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n", type=int, default=200_000)
    n = parser.parse_args().n

    print(f"Python {sys.version.split()[0]}, n={n:,} (surec ici; veritabani/ag YOK)\n")

    _, secs = timed(lambda: [make_listing(i) for i in range(n)])
    rate("CanonicalListing olusturma + dogrulama", n, secs)
    listings = [make_listing(i) for i in range(n)]

    pol = catalog_policy.POLICIES["hepsiburada"]
    offers = [
        catalog_policy.SourceOffer(
            offer_id=i,
            external_id=item.listing_id,
            url=item.url,
            title_raw=item.title,
            image_url=item.image_urls[0],
            current_price=item.price,
            currency="TRY",
            is_active=True,
        )
        for i, item in enumerate(listings)
    ]
    verdicts, secs = timed(lambda: [catalog_policy.evaluate(o, pol) for o in offers])
    accepted = sum(1 for v in verdicts if v.draft is not None)  # type: ignore[attr-defined]
    rate(
        "catalog_build.policy.evaluate (kayit defteri politikasi)", n, secs, f"  kabul={accepted:,}"
    )

    _, secs = timed(lambda: [listing_fingerprint(x) for x in listings])
    rate("listing_fingerprint (sha256)", n, secs)

    cf = ChangeFilter()
    changed, secs = timed(lambda: cf.split(listings))
    rate("ChangeFilter.split (ilk kosu: hepsi degisti)", n, secs)
    cf.commit(changed[0])  # type: ignore[index]
    _, secs = timed(lambda: cf.split(listings))
    rate("ChangeFilter.split (ikinci kosu: hepsi ayni)", n, secs)

    print()
    for batch in (500, 1000, 5000):
        rate(f"flow.run_source, bos sink, batch={batch}", n, bench_flow(listings, batch))
    cf2 = ChangeFilter()
    first = bench_flow(listings, 1000, FilteringSink(NullSink(), cf2))
    second = bench_flow(listings, 1000, FilteringSink(NullSink(), cf2))
    rate("flow.run_source + FilteringSink batch=1000, ilk kosu", n, first)
    rate("flow.run_source + FilteringSink batch=1000, tekrar", n, second)
    print("\nUYARI: bu sayilar saf Python hizidir; DB yazma/WAL/indeks maliyeti YOKTUR.")


if __name__ == "__main__":
    main()
