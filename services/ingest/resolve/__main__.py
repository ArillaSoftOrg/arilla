"""Eslestirme CLI'si.

python -m resolve                      eslesmemis offer'lari eslestir
python -m resolve --merchant b4-demo   yalnizca bir magaza
python -m resolve --dry-run            yaz, ama commit etme
python -m resolve --calibrate          regresyon setinden esik olcumu
"""

from __future__ import annotations

import argparse
import logging
import sys

from db.connection import connect
from resolve.calibrate import report
from resolve.pipeline import resolve_offers
from resolve.score import auto_accept_threshold, queue_threshold


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="resolve", description="Eslestirme (B4)")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--merchant-id", type=int, default=None)
    parser.add_argument(
        "--no-create",
        action="store_true",
        help="eslesmeyen offer icin yeni urun ACMA",
    )
    parser.add_argument("--dry-run", action="store_true", help="degisiklikleri geri al")
    parser.add_argument("--calibrate", action="store_true", help="esik olcumu, veritabani yok")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    if args.calibrate:
        return report()

    print(f"esikler: auto_accept={auto_accept_threshold()}  queue={queue_threshold()}\n")

    with connect() as conn:
        counts = resolve_offers(
            conn,
            limit=args.limit,
            merchant_id=args.merchant_id,
            create_missing=not args.no_create,
        )
        if args.dry_run:
            conn.rollback()
            print("(dry-run: hicbir degisiklik yazilmadi)\n")
        else:
            conn.commit()

    print(f"aday offer        {counts.considered}")
    print(f"otomatik kabul    {counts.auto_accepted}")
    print(f"insan kuyrugu     {counts.queued}")
    print(f"yeni urun         {counts.products_created}")
    for error in counts.errors:
        print(f"  ! {error}")

    return 1 if counts.errors else 0


if __name__ == "__main__":
    sys.exit(main())
