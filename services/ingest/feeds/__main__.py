"""Besleme komutlari. Kimlik bilgisi ve indirme adresi YAZDIRILMAZ.

python -m feeds discover [--network admitad]
python -m feeds list
python -m feeds bind --feed ID --merchant SLUG [--activate | --pause]
python -m feeds sync --feed ID [--max-records N] [--force] [--file PATH]
python -m feeds sync-due
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import feeds.admitad  # noqa: F401  (agi kaydeder)
from db import job_run
from db.connection import connect
from feeds import discovery
from feeds.network import build, registered
from feeds.profiles import MERCHANT_PROFILES
from feeds.sync import FeedSync, SyncAborted, load_feed

logger = logging.getLogger("feeds")


def _discover(args: argparse.Namespace) -> int:
    names = [args.network] if args.network else registered()
    with job_run.track("feed_discover") as run, connect() as conn:
        for name in names:
            report = discovery.discover(conn, build(name))
            conn.commit()
            run.detail[f"{name}_seen"] = report.seen
            run.detail[f"{name}_new"] = len(report.new)
            run.detail[f"{name}_gone"] = report.gone
            print(f"{name}: {report.seen} besleme, {len(report.new)} yeni, {report.gone} kayboldu")
            for external_id in report.new:
                print(f"  yeni: {external_id}")
    return 0


def _list(_args: argparse.Namespace) -> int:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT f.id, f.network, f.external_id, f.status, coalesce(m.slug, '-'),
                      f.currency, f.name, f.last_success_at, f.last_error_code
                 FROM feed_source f LEFT JOIN merchant m ON m.id = f.merchant_id
                ORDER BY f.network, f.id"""
        )
        for row in cur.fetchall():
            fid, net, ext, status, merchant, cur_, name, ok_at, err = row
            last = ok_at.isoformat(timespec="minutes") if ok_at else "-"
            print(
                f"{fid:>5} {net}:{ext:<16} {status:<10} {merchant:<16} {cur_ or '-':<4} "
                f"son={last} hata={err or '-'} | {name or ''}"
            )
    return 0


def _bind(args: argparse.Namespace) -> int:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, is_active FROM merchant WHERE slug = %s", (args.merchant,))
        row = cur.fetchone()
        if row is None:
            print(f"merchant yok: {args.merchant}", file=sys.stderr)
            return 2
        merchant_id = row[0]
        feed_id = _feed_id(conn, args.feed)
        cur.execute("SELECT id FROM feed_source WHERE id = %s", (feed_id,))
        feed = cur.fetchone()
        if feed is None:
            print(f"besleme yok: {args.feed}", file=sys.stderr)
            return 2
        status = "active" if args.activate else ("paused" if args.pause else None)
        # Karar 0114: uzun suredir guncellenmeyen besleme (or. Alibaba, 2022) etkinlestirilmez.
        if status == "active" and not args.allow_stale:
            cur.execute(
                "SELECT source_updated_at < now() - interval '30 days'"
                " FROM feed_source WHERE id = %s",
                (feed_id,),
            )
            stale = cur.fetchone()
            if stale and stale[0]:
                print(
                    "besleme 30 gundur guncellenmiyor; etkinlestirilmedi (--allow-stale)",
                    file=sys.stderr,
                )
                return 2
        cur.execute(
            """UPDATE feed_source SET merchant_id = %s, status = COALESCE(%s, status),
                      updated_at = now() WHERE id = %s""",
            (merchant_id, status, feed_id),
        )
        conn.commit()
    print(f"besleme {args.feed} -> {args.merchant} ({status or 'durum degismedi'})")
    return 0


def _feed_id(conn, value: str) -> int | None:  # type: ignore[no-untyped-def]
    """'105' ya da 'admitad:6115:14267' -> feed_source.id."""
    if value.isdigit():
        return int(value)
    network, _, external = value.partition(":")
    row = conn.execute(
        "SELECT id FROM feed_source WHERE network = %s AND external_id = %s", (network, external)
    ).fetchone()
    return int(row[0]) if row else None


def _ensure_merchant(args: argparse.Namespace) -> int:
    """Dogrulanmis profil icin merchant kaydi; VARSA DOKUNULMAZ (idempotent)."""
    profile = MERCHANT_PROFILES.get(args.profile)
    if profile is None:
        print(f"profil yok: {args.profile}", file=sys.stderr)
        return 2
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """INSERT INTO merchant (slug, name, domain, source_type, affiliate_network,
                                     affiliate_status, deeplink_template, is_active)
               VALUES (%(slug)s, %(name)s, %(domain)s, %(source_type)s, %(affiliate_network)s,
                       %(affiliate_status)s, %(deeplink_template)s, TRUE)
               ON CONFLICT (slug) DO NOTHING
               RETURNING id""",
            profile,
        )
        created = cur.fetchone() is not None
        conn.commit()
    print(
        f"merchant {profile['slug']}: {'olusturuldu' if created else 'zaten var, degistirilmedi'}"
    )
    return 0


def _sync_one(conn, feed_id: int, args: argparse.Namespace) -> int:  # type: ignore[no-untyped-def]
    feed = load_feed(conn, feed_id)
    conn.rollback()
    network = None if args.file else build(feed.network)
    sync = FeedSync(
        conn,
        feed_id,
        network=network,
        source_path=Path(args.file) if args.file else None,
        max_records=args.max_records,
    )
    report = sync.run(force=args.force or bool(args.file))
    print(f"besleme {feed_id}: {report.status} {report.detail()}")
    return 0 if report.status in ("success", "duplicate", "skipped") else 1


def _sync(args: argparse.Namespace) -> int:
    with job_run.track("feed_sync") as run, connect() as conn:
        try:
            feed_id = _feed_id(conn, args.feed)
            conn.rollback()
            if feed_id is None:
                print(f"besleme yok: {args.feed}", file=sys.stderr)
                return 2
            code = _sync_one(conn, feed_id, args)
        except SyncAborted as error:
            run.status = "failed"
            run.error_summary = error.code
            print(f"durdu: {error.code} {error.detail}", file=sys.stderr)
            return 2
        if code:
            run.status = "partial"
        return code


def _sync_due(args: argparse.Namespace) -> int:
    failures = 0
    with job_run.track("feed_sync") as run, connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM feed_source WHERE status = 'active' ORDER BY id")
            ids = [int(r[0]) for r in cur.fetchall()]
        conn.commit()
        for feed_id in ids:
            try:
                failures += _sync_one(conn, feed_id, args)
            except Exception as error:  # bir besleme digerlerini durdurmaz
                conn.rollback()
                failures += 1
                print(f"besleme {feed_id}: {getattr(error, 'code', type(error).__name__)}")
        run.detail["feeds"] = len(ids)
        run.detail["failures"] = failures
        if failures:
            run.status = "partial"
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    # Besleme adlari Latin disi olabilir (Admitad: Kiril); konsol kodlamasi dusurmesin.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(prog="python -m feeds")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("discover")
    p.add_argument("--network")
    p.set_defaults(func=_discover)
    sub.add_parser("list").set_defaults(func=_list)
    p = sub.add_parser("ensure-merchant")
    p.add_argument("--profile", required=True)
    p.set_defaults(func=_ensure_merchant)
    p = sub.add_parser("bind")
    p.add_argument("--feed", required=True, help="kimlik ya da ag:kaynak_kimligi")
    p.add_argument("--merchant", required=True)
    group = p.add_mutually_exclusive_group()
    group.add_argument("--activate", action="store_true")
    group.add_argument("--pause", action="store_true")
    p.add_argument("--allow-stale", action="store_true")
    p.set_defaults(func=_bind)
    for name, func in (("sync", _sync), ("sync-due", _sync_due)):
        p = sub.add_parser(name)
        if name == "sync":
            p.add_argument("--feed", required=True, help="kimlik ya da ag:kaynak_kimligi")
            p.add_argument("--file", help="yerel dosya (dogrulama/test); agdan indirilmez")
        else:
            p.set_defaults(file=None)
        p.add_argument("--max-records", type=int)
        p.add_argument("--force", action="store_true")
        p.set_defaults(func=func)
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
