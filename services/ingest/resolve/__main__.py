"""Eslestirme CLI'si.

python -m resolve                      eslesmemis offer'lari eslestir
python -m resolve --merchant b4-demo   yalnizca bir magaza
python -m resolve --dry-run            yaz, ama commit etme
python -m resolve --calibrate          regresyon setinden esik olcumu

Cikis kodu is sonucundan gelir (karar 0174, `db.job_run.OUTCOMES`):
completed/no_input 0, partial 1, skipped_locked 75, teknik hata 1.
"""

from __future__ import annotations

import argparse
import logging
import sys

from db import job_run
from db.connection import connect
from resolve.calibrate import report
from resolve.pipeline import ResolveCounts, resolve_offers
from resolve.score import auto_accept_threshold, queue_threshold


def classify(counts: ResolveCounts) -> tuple[str, str | None]:
    """Kosunun sonucu (karar 0174). Yalnizca tipli sayaclar; hata metni ayristirilmaz.

    Oncelik: kilit (hicbir sey yapilmadi) > oge hatasi > girdi yok > tamam.
    `considered == 0` ariza DEGILDIR: islenecek uygun teklif yoktu.
    """
    if counts.skipped_locked:
        return "skipped_locked", "lock_busy"
    if counts.errors:
        return "partial", "offer_errors"
    if counts.considered == 0:
        return "no_input", "no_eligible_offers"
    return "completed", None


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

    if args.dry_run:
        with connect() as conn:
            counts = resolve_offers(
                conn,
                limit=args.limit,
                merchant_id=args.merchant_id,
                create_missing=not args.no_create,
            )
            conn.rollback()
            print("(dry-run: hicbir degisiklik yazilmadi)\n")
        result = job_run.outcome(*classify(counts))
    else:
        # Dry-run kayit birakmaz: tazelik kaniti gibi gorunmemeli (karar 0055).
        with job_run.track("resolve", outcomes=True) as run, connect() as conn:
            counts = resolve_offers(
                conn,
                limit=args.limit,
                merchant_id=args.merchant_id,
                create_missing=not args.no_create,
            )
            conn.commit()
            run.detail.update(
                considered=counts.considered,
                auto_accepted=counts.auto_accepted,
                queued=counts.queued,
                products_created=counts.products_created,
                aggregates_updated=counts.aggregates_updated,
                link_conflicts=counts.link_conflicts,
                errors=len(counts.errors),
            )
            if counts.errors:
                run.error_summary = f"{len(counts.errors)} hata; ilki: {counts.errors[0]}"
            run.set_outcome(*classify(counts))
            result = run.final_outcome()

    if counts.skipped_locked:
        print("baska bir eslestirme kosusu suruyor; bu kosu hicbir teklife dokunmadi")
    print(f"aday offer        {counts.considered}")
    print(f"otomatik kabul    {counts.auto_accepted}")
    print(f"insan kuyrugu     {counts.queued}")
    print(f"yeni urun         {counts.products_created}")
    print(f"ozet guncellenen  {counts.aggregates_updated}")
    print(f"baglama cakismasi {counts.link_conflicts}")
    for error in counts.errors:
        print(f"  ! {error}")
    print(f"sonuc             {result.name}" + (f" ({result.reason})" if result.reason else ""))

    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
