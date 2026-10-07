"""Benzerlik ve fiyat istatistikleri CLI'si.

    python -m similarity              kenarlar + istatistikler
    python -m similarity --edges      yalnizca kenarlar
    python -m similarity --prices     yalnizca fiyat istatistikleri
    python -m similarity --dry-run    yaz, commit etme

Gece toplu isidir. `pnpm seed` bu tablolari ARTIK doldurmuyor (tek dogru
kaynak burasi), o yuzden tohum verisinden sonra bu komut kosulmalidir.
"""

from __future__ import annotations

import argparse
import logging
import sys

from db import job_run
from db.connection import connect
from similarity.edges import MIN_SCORE, TOP_N
from similarity.pipeline import run


def job_name(do_edges: bool, do_prices: bool) -> str:
    """`job_run.job`: yonetim boru hatti asamalari bu adlari okur (karar 0055)."""
    if do_edges and do_prices:
        return "similarity"
    return "similarity_edges" if do_edges else "similarity_prices"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="similarity", description="Benzerlik ve fiyat (B5)")
    parser.add_argument("--edges", action="store_true", help="yalnizca kenarlar")
    parser.add_argument("--prices", action="store_true", help="yalnizca fiyat istatistikleri")
    parser.add_argument("--limit", type=int, default=None, help="urun sayisi siniri")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    # Hicbiri secilmediyse ikisi de calisir.
    do_edges = args.edges or not args.prices
    do_prices = args.prices or not args.edges

    if args.dry_run:
        with connect() as conn:
            counts = run(conn, do_edges=do_edges, do_prices=do_prices, limit=args.limit)
            conn.rollback()
            print("(dry-run: hicbir degisiklik yazilmadi)\n")
    else:
        with job_run.track(job_name(do_edges, do_prices)) as tracked, connect() as conn:
            counts = run(conn, do_edges=do_edges, do_prices=do_prices, limit=args.limit)
            conn.commit()
            if do_edges:
                tracked.detail.update(
                    visual_edges=counts.visual.edges_written,
                    semantic_edges=counts.semantic.edges_written,
                    visual_products=counts.visual.products_with_vector,
                    semantic_products=counts.semantic.products_with_vector,
                )
            if do_prices:
                tracked.detail.update(
                    price_products=counts.prices.products,
                    price_aggregates=counts.prices.aggregates_updated,
                )

    if do_edges:
        for label, group in (("visual", counts.visual), ("semantic", counts.semantic)):
            print(f"--- {label} (taban {MIN_SCORE[label]}, urun basina en fazla {TOP_N}) ---")
            print(f"  vektorlu urun    {group.products_with_vector}")
            print(f"  yazilan kenar    {group.edges_written}  (cift yonlu)")
            print(f"  taban alti aday  {group.below_floor}")
            print(f"  5'ten az kenarli {len(group.thin_products)}")

    if do_prices:
        print("--- fiyat istatistikleri ---")
        print(f"  urun             {counts.prices.products}")
        print(f"  sahte indirim    {counts.prices.inflated}")
        print(f"  urun ozeti       {counts.prices.aggregates_updated}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
