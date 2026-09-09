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

from db.connection import connect
from similarity.edges import MIN_SCORE, TOP_N
from similarity.pipeline import run


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

    with connect() as conn:
        counts = run(conn, do_edges=do_edges, do_prices=do_prices, limit=args.limit)
        if args.dry_run:
            conn.rollback()
            print("(dry-run: hicbir degisiklik yazilmadi)\n")
        else:
            conn.commit()

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

    return 0


if __name__ == "__main__":
    sys.exit(main())
