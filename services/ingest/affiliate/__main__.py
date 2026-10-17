"""Affiliate donusum komutlari (karar 0128).

python -m affiliate conversions              son 90 gunun eylemleri
python -m affiliate conversions --days 30
python -m affiliate conversions --dry-run    yaz, commit etme
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime, timedelta

from affiliate.admitad_actions import AdmitadActions
from affiliate.conversions import store_actions
from db import job_run
from db.connection import connect
from feeds.logs import configure as configure_logging
from feeds.network import NetworkUnavailable

#: Admitad onayi haftalar surebilir; durum degisikligi bu pencerede yakalanir.
DEFAULT_DAYS = 90


def _conversions(args: argparse.Namespace) -> int:
    end = datetime.now(UTC).date()
    start = end - timedelta(days=args.days)
    if args.dry_run:
        with connect() as conn:
            actions = [a for a, _ in AdmitadActions().actions(start, end)]
            counts = store_actions(conn, actions)
            conn.rollback()
        print(f"(dry-run) {counts.detail()}")
        return 0
    with job_run.track("affiliate_conversions") as run, connect() as conn:
        try:
            actions = [a for a, _ in AdmitadActions().actions(start, end)]
        except NetworkUnavailable as error:
            run.status = "failed"
            run.error_summary = str(error)
            print(f"donusumler alinamadi: {error}", file=sys.stderr)
            return 1
        counts = store_actions(conn, actions)
        conn.commit()
        run.detail.update(counts.detail(), days=args.days)
        if counts.skipped.get("unparsed") or counts.skipped.get("fx_missing"):
            run.status = "partial"
    print(counts.detail())
    return 0


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    parser = argparse.ArgumentParser(prog="python -m affiliate")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("conversions")
    p.add_argument("--days", type=int, default=DEFAULT_DAYS)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=_conversions)
    args = parser.parse_args(argv)
    if args.days < 1 or args.days > 365:
        parser.error("--days 1..365")
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
