"""Toplama CLI'si.

    python -m collect --merchant <slug>
    python -m collect --merchant <slug> --max-attempts 5 --chunk-size 100
    python -m collect --merchant <slug> --no-resume

Bu servis HICBIR HTTP ENDPOINT SUNMAZ. TypeScript tarafi bu kodu cagirmaz;
tetikleme ya bu CLI ya da (ilerideki) Redis kuyrugu uzerinden olur.

Kosu chunk'li ve checkpoint'lidir (karar 0065). Kesilirse (baglanti kopmasi,
agdan gecici hata) commit edilmis chunk'lar kalir; CLI kalan isi kalici
checkpoint'ten, ayni `observed_at` ile, en fazla `--max-attempts` kez devam
ettirir. Hepsi tukenirse `partial` kalir (asla `success` degil) ve cikis kodu 1.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from collections.abc import Callable

from collect.pipeline import CHUNK_OFFERS, IngestInterrupted, IngestResult, run_ingest
from db import job_run
from db.connection import connect

#: Denemeler arasi bekleme: deneme * bu kadar sn (DNS/ag toparlansin).
RETRY_BACKOFF_SECONDS = 30


def run_with_resume(
    slug: str,
    *,
    max_attempts: int,
    chunk_size: int,
    resume: bool,
    sleep: Callable[[float], None] = time.sleep,
) -> IngestResult:
    """Her deneme YENI bir baglantiyla; kesilen kosu kalici checkpoint'ten
    devam eder. Donen sonuc son denemenindir."""
    last: IngestResult | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            with connect() as conn:
                return run_ingest(conn, slug, chunk_size=chunk_size, resume=resume)
        except IngestInterrupted as interrupted:
            last = interrupted.result
            logging.getLogger(__name__).warning(
                "deneme %d/%d kesildi (%d chunk kalici): %s",
                attempt,
                max_attempts,
                interrupted.result.chunks,
                interrupted.__cause__,
            )
            resume = True  # kesilen kosuyu devral
            if attempt < max_attempts:
                sleep(RETRY_BACKOFF_SECONDS * attempt)
    assert last is not None
    return last


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="collect", description="Merchant feed toplama")
    parser.add_argument("--merchant", required=True, help="merchant.slug")
    parser.add_argument("--chunk-size", type=int, default=CHUNK_OFFERS, help="chunk basina teklif")
    parser.add_argument("--max-attempts", type=int, default=3, help="kesilirse devam denemesi")
    parser.add_argument(
        "--no-resume", action="store_true", help="devam ettirilebilir onceki kosuyu devralma"
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    # Is kosusu kaydi (karar 0055); magaza basina ayrinti `ingest_run`'da.
    with job_run.track("collect") as run:
        result = run_with_resume(
            args.merchant,
            max_attempts=max(1, args.max_attempts),
            chunk_size=args.chunk_size,
            resume=not args.no_resume,
        )
        run.status = result.status
        run.detail.update(
            merchants=1,
            offers_seen=result.offers_seen,
            offers_created=result.counts.offers_created,
            offers_updated=result.counts.offers_updated,
            price_points=result.counts.price_points_written,
            rejected=result.rejected,
            chunks=result.chunks,
        )
        if result.refusal:
            run.error_summary = f"refused:{result.refusal}"

    counts = result.counts
    print(f"merchant           {result.merchant_slug}")
    print(f"ingest_run         {result.ingest_run_id}")
    print(f"status             {result.status}")
    if result.resumed_from:
        print(f"resumed_from       {result.resumed_from}")
    if result.refusal:
        # Kapi reddetti: magazaya istek gitmedi, hicbir sey yazilmadi.
        print(f"refused            {result.refusal}")
    print(f"chunks             {result.chunks}")
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
