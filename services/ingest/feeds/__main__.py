"""Besleme komutlari. Kimlik bilgisi ve indirme adresi YAZDIRILMAZ.

python -m feeds discover [--network admitad]
python -m feeds list
python -m feeds bind --feed ID --merchant SLUG [--activate | --pause]
python -m feeds sync --feed ID [--max-records N] [--force] [--file PATH]
python -m feeds sync-due
python -m feeds hb-merge --run ID [--allow-open]
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import feeds.admitad  # noqa: F401  (agi kaydeder)
from db import job_run
from db.connection import connect, env
from feeds import discovery
from feeds.download import staging_dir
from feeds.logs import configure as configure_logging
from feeds.network import build, registered
from feeds.profiles import MERCHANT_PROFILES
from feeds.sync import FeedSync, SyncAborted, load_feed, prefetch_download

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


def _sync_one(conn, feed_id: int, args: argparse.Namespace, prefetched=None) -> int:  # type: ignore[no-untyped-def]
    feed = load_feed(conn, feed_id)
    conn.rollback()
    network = None if args.file else build(feed.network)
    sync = FeedSync(
        conn,
        feed_id,
        network=network,
        source_path=Path(args.file) if args.file else None,
        max_records=args.max_records,
        prefetched=prefetched,
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
    """Etkin beslemeler. Indirmeler PARALEL (en fazla `--parallel-downloads`), isleme SIRAYLA:
    bir besleme islenirken digerleri iner. Her indirme bos diskin payina sinirlidir."""
    failures = 0
    parallel = max(1, min(int(args.parallel_downloads), 4))
    with job_run.track("feed_sync") as run, connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM feed_source WHERE status = 'active' ORDER BY id")
            ids = [int(r[0]) for r in cur.fetchall()]
        conn.commit()
        feeds = [load_feed(conn, feed_id) for feed_id in ids]
        conn.rollback()
        due = [
            f
            for f in feeds
            if args.force
            or f.source_updated_at is None
            or f.last_success_at is None
            or f.source_updated_at > f.last_success_at
        ]
        free = shutil.disk_usage(staging_dir()).free
        min_free = int(env("FEED_MIN_FREE_BYTES") or 15 << 30)
        budget = max(0, (free - min_free) // parallel)
        with ThreadPoolExecutor(max_workers=parallel) as pool:
            futures = {
                f.id: pool.submit(
                    prefetch_download,
                    f,
                    build(f.network),
                    max_records=args.max_records,
                    max_bytes=budget,
                    at=datetime.now(UTC),
                )
                for f in due
            }
            for feed_id in ids:
                try:
                    prefetched = futures[feed_id].result() if feed_id in futures else None
                    failures += _sync_one(conn, feed_id, args, prefetched)
                except Exception as error:  # bir besleme digerlerini durdurmaz
                    conn.rollback()
                    failures += 1
                    print(f"besleme {feed_id}: {getattr(error, 'code', type(error).__name__)}")
        run.detail["feeds"] = len(ids)
        run.detail["downloaded_parallel"] = len(futures)
        run.detail["failures"] = failures
        if failures:
            run.status = "partial"
    return 1 if failures else 0


def _hb_merge(args: argparse.Namespace) -> int:
    """Kapanmis toplama kosusunun ara depo kayitlarini offer modeline birlestirir (karar 0117)."""
    from feeds.intake import merge_run

    with job_run.track("hb_merge") as run, connect() as conn:
        try:
            report = merge_run(conn, args.run, require_closed=not args.allow_open)
        except (RuntimeError, SyncAborted) as error:
            run.status = "failed"
            run.error_summary = str(getattr(error, "code", error))[:60]
            print(f"durdu: {run.error_summary}", file=sys.stderr)
            return 2
        run.detail.update(
            records=report.records,
            held=report.held,
            discovery_marked=report.discovery_marked,
            discovery_kind_mismatch=report.discovery_kind_mismatch,
        )
        print(f"kosu {args.run}: {report.status} kayit={report.records} {report.detail or ''}")
        print(
            f"kesif defteri: fiyat goruldu={report.discovery_marked}"
            f" tur_uyusmayan(baglanmadi)={report.discovery_kind_mismatch}"
            f" fiyat_sicramasi_bekleyen={report.held}"
        )
        # Teklif urune DOGRUDAN baglanmaz: `python -m catalog_build build --merchant hepsiburada`
        # taslak uretir, kapi + acik yayin ister (karar 0130).
        return 0 if report.status in ("success", "duplicate", "nothing_to_merge") else 1


def main(argv: list[str] | None = None) -> int:
    # Besleme adlari Latin disi olabilir (Admitad: Kiril); konsol kodlamasi dusurmesin.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    configure_logging()
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
        if name == "sync-due":
            p.add_argument("--parallel-downloads", type=int, default=2)
        p.add_argument("--force", action="store_true")
        p.set_defaults(func=func)
    p = sub.add_parser("hb-merge")
    p.add_argument("--run", type=int, required=True)
    p.add_argument("--allow-open", action="store_true")
    p.set_defaults(func=_hb_merge)
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
