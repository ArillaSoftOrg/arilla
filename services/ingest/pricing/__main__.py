"""Fiyat dogrulama ve kur komutlari (karar 0113)."""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import timedelta

from db import job_run
from db.connection import connect
from pricing import fx
from pricing.providers import default_providers
from pricing.worker import enqueue_stale, process


def _fx(_args: argparse.Namespace) -> int:
    with job_run.track("fx_rates") as run, connect() as conn:
        try:
            rates = fx.fetch_tcmb()
        except fx.FxUnavailable as error:
            run.status = "failed"
            run.error_summary = str(error)
            print(f"kur alinamadi: {error}", file=sys.stderr)
            return 1
        stored = fx.store(conn, rates)
        conn.commit()
        run.detail["effective_date"] = rates[0].effective_date.isoformat()
        run.detail["rates"] = stored
        usd = next((r for r in rates if r.base == "USD" and r.kind == "forex_selling"), None)
        print(
            f"TCMB {rates[0].effective_date} ({rates[0].bulletin}): {stored} kur"
            + (f", USD satis {usd.rate}" if usd else "")
        )
    return 0


def _enqueue(args: argparse.Namespace) -> int:
    with connect() as conn:
        added = enqueue_stale(
            conn,
            merchant=args.merchant,
            limit=args.limit,
            older_than=timedelta(hours=args.older_than_hours),
        )
        conn.commit()
    print(f"{added} dogrulama istegi eklendi")
    return 0


def _verify(args: argparse.Namespace) -> int:
    with job_run.track("price_verify") as run, connect() as conn:
        report = process(conn, default_providers(), limit=args.limit)
        run.detail.update(report.__dict__)
    print(f"dogrulama: {report.__dict__}")
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(prog="python -m pricing")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("fx").set_defaults(func=_fx)
    p = sub.add_parser("enqueue")
    p.add_argument("--merchant")
    p.add_argument("--limit", type=int, default=200)
    p.add_argument("--older-than-hours", type=float, default=24.0)
    p.set_defaults(func=_enqueue)
    p = sub.add_parser("verify")
    p.add_argument("--limit", type=int, default=50)
    p.set_defaults(func=_verify)
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
