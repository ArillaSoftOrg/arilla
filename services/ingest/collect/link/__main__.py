"""Kullanici linki cozumleme CLI'si.

    python -m collect.link <url>        tek bir linki cozumler
    python -m collect.link --refresh    suresi gelen user_link tekliflerini yeniler
    python -m collect.link --worker     web'in Redis kuyrugunu tuketir (D4)

Bu servis hicbir HTTP endpoint sunmaz. Web tarafi (D4) isi Redis kuyruguna
birakir (`packages/core/src/discovery/link-resolution.ts`); `--worker` ayni
cozumleyiciyi kuyruktan tetikler, `--refresh` ve argumansiz cagri elle tetikler.
"""

from __future__ import annotations

import argparse
import logging
import sys

import httpx
import redis

from collect.link.refresh import refresh_user_links
from collect.link.resolver import ResolutionFailed, resolve_url
from collect.link.urls import InvalidUrl
from collect.link.worker import run_worker
from collect.records import RecordRejected
from db.connection import connect, env


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="collect.link", description="Kullanici linki cozumleme (Katman 2)"
    )
    parser.add_argument("url", nargs="?", help="cozumlenecek urun adresi")
    parser.add_argument("--refresh", action="store_true", help="suresi gelen linkleri yenile")
    parser.add_argument("--worker", action="store_true", help="Redis kuyrugunu surekli tuket")
    parser.add_argument("--limit", type=int, default=100, help="--refresh icin ust sinir")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    modes = [args.refresh, args.worker, bool(args.url)]
    if sum(modes) != 1:
        parser.error("tam olarak birini secin: bir url, --refresh ya da --worker")

    with connect() as conn:
        if args.worker:
            redis_url = env("REDIS_URL", "redis://localhost:6379")
            redis_client = redis.Redis.from_url(redis_url, decode_responses=True)
            logging.info("worker basladi, kuyruk: queue:link_resolution")
            run_worker(conn, redis_client)
            return 0

        if args.refresh:
            result = refresh_user_links(conn, limit=args.limit)
            print(f"suresi gelen     {result.considered}")
            print(f"yenilenen        {result.refreshed}")
            print(f"basarisiz        {result.failed}")
            return 0 if result.failed == 0 else 1

        try:
            resolved = resolve_url(conn, args.url)
        except (InvalidUrl, ResolutionFailed, RecordRejected, httpx.HTTPError) as error:
            conn.rollback()
            print(f"cozumlenemedi: {error}", file=sys.stderr)
            return 1
        conn.commit()

    yeni_merchant = " (yeni)" if resolved.merchant_created else ""
    yeni_offer = " (yeni)" if resolved.offer_created else ""
    print(f"merchant         {resolved.merchant_id}{yeni_merchant}")
    print(f"offer            {resolved.offer_id}{yeni_offer}")
    print(f"external_id      {resolved.external_id}")
    print(f"baslik           {resolved.title}")
    print(f"fiyat            {resolved.price} kurus")
    print(f"cikarim katmani  {resolved.source_layer}")
    if resolved.low_confidence:
        print("UYARI            yapilandirilmis veri yoktu, son care katmani kullanildi")
    return 0


if __name__ == "__main__":
    sys.exit(main())
