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

from db import job_run
from db.connection import connect
from resolve.calibrate import report
from resolve.pipeline import resolve_offers, resolve_offers_sequential
from resolve.score import auto_accept_threshold, queue_threshold


def _run(conn, args, *, commit_each_chunk: bool = False):  # type: ignore[no-untyped-def]
    if args.sequential:
        return resolve_offers_sequential(
            conn,
            limit=args.limit if args.limit is not None else 500,
            merchant_id=args.merchant_id,
            create_missing=not args.no_create,
        )
    return resolve_offers(
        conn,
        limit=args.limit,
        merchant_id=args.merchant_id,
        create_missing=not args.no_create,
        chunk_size=args.chunk_size,
        commit_each_chunk=commit_each_chunk,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="resolve", description="Eslestirme (B4)")
    parser.add_argument(
        "--limit", type=int, default=None, help="en fazla bu kadar offer (varsayilan: hepsi)"
    )
    parser.add_argument(
        "--chunk-size", type=int, default=None, help="chunk basina offer (varsayilan 200)"
    )
    parser.add_argument(
        "--sequential", action="store_true", help="eski, offer-offer referans surum"
    )
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

    if args.dry_run:
        with connect() as conn:
            counts = _run(conn, args)
            conn.rollback()
            print("(dry-run: hicbir degisiklik yazilmadi)\n")
    else:
        # Dry-run kayit birakmaz: tazelik kaniti gibi gorunmemeli (karar 0055).
        with job_run.track("resolve") as run, connect() as conn:
            counts = _run(conn, args, commit_each_chunk=not args.sequential)
            conn.commit()
            run.detail.update(
                considered=counts.considered,
                auto_accepted=counts.auto_accepted,
                queued=counts.queued,
                products_created=counts.products_created,
                errors=len(counts.errors),
            )
            if counts.errors:
                run.status = "partial"
                run.error_summary = f"{len(counts.errors)} hata; ilki: {counts.errors[0]}"

    print(f"aday offer        {counts.considered}")
    print(f"otomatik kabul    {counts.auto_accepted}")
    print(f"insan kuyrugu     {counts.queued}")
    print(f"yeni urun         {counts.products_created}")
    for error in counts.errors:
        print(f"  ! {error}")

    return 1 if counts.errors else 0


if __name__ == "__main__":
    sys.exit(main())
