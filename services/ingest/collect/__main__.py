"""Toplama CLI'si.

    python -m collect --merchant <slug>

Bu servis HICBIR HTTP ENDPOINT SUNMAZ. TypeScript tarafi bu kodu cagirmaz;
tetikleme ya bu CLI ya da (ilerideki) Redis kuyrugu uzerinden olur.
"""

from __future__ import annotations

import argparse
import logging
import sys

from collect.pipeline import run_ingest
from db.connection import connect


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="collect", description="Merchant feed toplama")
    parser.add_argument("--merchant", required=True, help="merchant.slug")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    with connect() as conn:
        result = run_ingest(conn, args.merchant)

    counts = result.counts
    print(f"merchant           {result.merchant_slug}")
    print(f"ingest_run         {result.ingest_run_id}")
    print(f"status             {result.status}")
    print(f"offers_seen        {result.offers_seen}")
    print(f"offers_created     {counts.offers_created}")
    print(f"offers_updated     {counts.offers_updated}")
    print(f"price_points       {counts.price_points_written}")
    print(f"variants           {counts.variants_written}")
    print(f"stock_events       {counts.stock_events_written}")
    print(f"rejected           {result.rejected}")
    print(f"deactivated        {result.deactivated}")

    # partial ve failed sifirdan farkli doner: cron ve izleme bunu kullanir.
    return 0 if result.status == "success" else 1


if __name__ == "__main__":
    sys.exit(main())
