"""Kaynak ilanindan katalog (karar 0121).

python -m catalog_build build   --merchant aliexpress [--batch 5000] [--max-batches N]
                                [--max-seconds S] [--sleep-ms MS] [--rescan]
python -m catalog_build audit   --merchant aliexpress [--batch 5000]
python -m catalog_build build-discovery --merchant hepsiburada --limit N [--batch 5000]
                                [--max-seconds S] [--sleep-ms MS] [--rescan] [--dry-run]
python -m catalog_build status  --merchant aliexpress
python -m catalog_build gate    [--after-id N] [--batch 5000] [--max-batches N]
                                [--stale-days 7] [--allow-foreign]
python -m catalog_build publish --limit N --confirm [--merchant aliexpress] [--allow-foreign]
                                [--batch 500]
python -m catalog_build unpublish --product-id N [--product-id M ...] --confirm

`build`, `gate` ve `publish` WAL geri basinciyla calisir (karar 0134): parti oncesi
arsivlenmemis WAL olculur; `--wal-target-mb` ustunde parti arasi uyku, `--wal-pause-mb`
ustunde `--wal-resume-mb` altina inene kadar bekleme, arsiv hatasinda bekleme. Sinir
asilirsa is 3 koduyla cikar (tamamlanan partiler kalir; ayni komut kaldigi yerden surer).
`archive_mode=off` (yerel) iken etkisizdir.

`build-discovery` (karar 0130) fiyatsiz kesif defterinden yalnizca TASLAK urun acar; offer
ve fiyat uretmez, her kosu acik `--limit` ister. `--dry-run` yalnizca okur.

`build` offer'lara DOKUNMAZ ve hicbir seyi yayinlamaz. Ctrl+C / SIGTERM mevcut partiyi
bitirip durur; ayni komut kaldigi yerden surer. Yalnizca elle calistirilir (zamanlama yok).
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys

import psycopg

from catalog_build import build as build_mod
from catalog_build import discovery as discovery_mod
from catalog_build import gate as gate_mod
from catalog_build import publish as publish_mod
from db import job_run, wal_pressure
from db.connection import connect

_stop = False


def _request_stop(_signum: int, _frame: object) -> None:
    global _stop
    _stop = True
    print("\ndurdurma istendi: mevcut parti bitince cikilacak", file=sys.stderr)


def _should_stop() -> bool:
    return _stop


#: Is WAL siniri yuzunden durdu (karar 0134): sarmalayici bunu cokme saymaz, bekleyip surer.
EXIT_WAL_BACKPRESSURE = 3


def _add_wal_args(p: argparse.ArgumentParser) -> None:
    g = p.add_argument_group("WAL geri basinci (karar 0134)")
    g.add_argument("--wal-target-mb", type=int, default=1024, help="bu gecikmenin ustunde yavasla")
    g.add_argument("--wal-pause-mb", type=int, default=1536, help="bu gecikmede parti baslatma")
    g.add_argument("--wal-resume-mb", type=int, default=512, help="duraklamadan bu gecikmede cik")
    g.add_argument("--wal-max-sleep-s", type=float, default=30.0, help="parti arasi en uzun uyku")
    g.add_argument("--wal-max-pause-s", type=float, default=3600.0, help="en uzun duraklama")
    g.add_argument(
        "--wal-failing-grace-s", type=float, default=900.0, help="arsiv hatasi toleransi"
    )


def _wal_policy(args: argparse.Namespace) -> wal_pressure.WalPolicy:
    return wal_pressure.policy_from_mb(
        target_mb=args.wal_target_mb,
        pause_mb=args.wal_pause_mb,
        resume_mb=args.wal_resume_mb,
        max_sleep_s=args.wal_max_sleep_s,
        max_pause_s=args.wal_max_pause_s,
        failing_grace_s=args.wal_failing_grace_s,
    )


def _governor(conn: psycopg.Connection, args: argparse.Namespace) -> wal_pressure.WalGovernor:
    return wal_pressure.WalGovernor.for_connection(
        conn, _wal_policy(args), should_stop=_should_stop
    )


def _finish_wal(run: job_run.JobRun, gov: wal_pressure.WalGovernor) -> int:
    run.detail.update(gov.stats.as_detail())
    if gov.stopped_reason is None:
        return 0
    run.status = "partial"
    run.error_summary = f"WAL geri basinci: {gov.stopped_reason}"
    print(f"WAL geri basinci nedeniyle durdu: {gov.stopped_reason}", file=sys.stderr)
    return EXIT_WAL_BACKPRESSURE


def _status(conn: psycopg.Connection, merchant: str) -> int:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT s.last_offer_id, s.scanned, s.created, s.existing, s.skipped,
                      s.started_at, s.updated_at, s.completed_at
                 FROM catalog_build_state s JOIN merchant m ON m.id = s.merchant_id
                WHERE m.slug = %s""",
            (merchant,),
        )
        row = cur.fetchone()
        cur.execute(
            """SELECT publication_state, count(*) FROM product
                WHERE source_merchant_id = (SELECT id FROM merchant WHERE slug = %s)
                GROUP BY 1 ORDER BY 1""",
            (merchant,),
        )
        states = cur.fetchall()
    if row is None:
        print("kontrol noktasi yok (build hic calismadi)")
    else:
        print(f"son offer id      {row[0]}")
        print(f"taranan           {row[1]}")
        print(f"olusturulan       {row[2]}")
        print(f"zaten var         {row[3]}")
        print(f"atlanan           {row[4]}")
        print(f"tamamlandi        {row[7]}")
    for state, n in states:
        print(f"urun {state:<10} {n}")
    with conn.cursor() as cur:
        cur.execute(
            """SELECT s.last_external_id, s.scanned, s.created, s.existing, s.skipped,
                      s.completed_at
                 FROM catalog_discovery_build_state s WHERE s.source = %s""",
            (merchant,),
        )
        disc = cur.fetchone()
    if disc is not None:
        print(
            f"kesif defteri: son kimlik {disc[0]!r} taranan {disc[1]} olusan {disc[2]}"
            f" var {disc[3]} atlanan {disc[4]} tamamlandi {disc[5]}"
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="catalog_build", description="Kaynak ilani katalogu")
    parser.add_argument("--verbose", "-v", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    p_build = sub.add_parser("build")
    p_build.add_argument("--merchant", required=True)
    p_build.add_argument("--batch", type=int, default=build_mod.DEFAULT_BATCH)
    p_build.add_argument("--max-batches", type=int, default=None)
    p_build.add_argument("--max-seconds", type=float, default=None)
    p_build.add_argument("--sleep-ms", type=int, default=0)
    p_build.add_argument("--rescan", action="store_true")
    _add_wal_args(p_build)

    p_audit = sub.add_parser("audit", help="YALNIZCA OKUR: kac teklif urun olmaya uygun")
    p_audit.add_argument("--merchant", required=True)
    p_audit.add_argument("--batch", type=int, default=build_mod.DEFAULT_BATCH)
    p_audit.add_argument("--max-batches", type=int, default=None)

    p_disc = sub.add_parser(
        "build-discovery", help="fiyatsiz kesif defterinden TASLAK urun (offer/fiyat yok)"
    )
    p_disc.add_argument("--merchant", required=True)
    p_disc.add_argument("--limit", type=int, required=True)
    p_disc.add_argument("--batch", type=int, default=discovery_mod.DEFAULT_BATCH)
    p_disc.add_argument("--max-seconds", type=float, default=None)
    p_disc.add_argument("--sleep-ms", type=int, default=0)
    p_disc.add_argument("--rescan", action="store_true")
    p_disc.add_argument("--dry-run", action="store_true")

    p_status = sub.add_parser("status")
    p_status.add_argument("--merchant", required=True)

    p_gate = sub.add_parser("gate")
    p_gate.add_argument("--after-id", type=int, default=0)
    p_gate.add_argument("--batch", type=int, default=gate_mod.DEFAULT_BATCH)
    p_gate.add_argument("--max-batches", type=int, default=None)
    p_gate.add_argument("--stale-days", type=int, default=gate_mod.DEFAULT_STALE_DAYS)
    p_gate.add_argument("--allow-foreign", action="store_true")
    _add_wal_args(p_gate)

    p_pub = sub.add_parser("publish")
    p_pub.add_argument("--limit", type=int, required=True)
    p_pub.add_argument("--merchant", default=None)
    p_pub.add_argument("--allow-foreign", action="store_true")
    p_pub.add_argument("--confirm", action="store_true")
    p_pub.add_argument("--batch", type=int, default=publish_mod.DEFAULT_BATCH)
    _add_wal_args(p_pub)

    p_unpub = sub.add_parser("unpublish")
    p_unpub.add_argument("--product-id", type=int, action="append", required=True)
    p_unpub.add_argument("--confirm", action="store_true")

    args = parser.parse_args(argv)
    if hasattr(args, "wal_target_mb"):
        try:
            _wal_policy(args)
        except ValueError as error:  # yazmadan once, acik hata (kod 2)
            parser.error(str(error))
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s"
    )
    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)

    if args.command == "status":
        with connect() as conn:
            return _status(conn, args.merchant)

    if args.command == "audit":
        with connect() as conn:
            counts = build_mod.build_source_products(
                conn,
                merchant_slug=args.merchant,
                batch_size=args.batch,
                max_batches=args.max_batches,
                should_stop=_should_stop,
                dry_run=True,
            )
        print(f"taranan={counts.scanned} urun_olmaya_uygun={counts.created}")
        for reason in sorted(counts.skipped):
            print(f"  atlanirdi {reason:<24} {counts.skipped[reason]}")
        print(f"bitti={counts.completed} (hicbir sey yazilmadi)")
        return 0

    if args.command == "build-discovery":
        with job_run.track("catalog_build_discovery") as run, connect() as conn:
            dcounts = discovery_mod.build_discovery_products(
                conn,
                merchant_slug=args.merchant,
                limit=args.limit,
                batch_size=args.batch,
                max_seconds=args.max_seconds,
                rescan=args.rescan,
                sleep_seconds=args.sleep_ms / 1000,
                should_stop=_should_stop,
                dry_run=args.dry_run,
                on_batch=lambda c: print(
                    f"parti {c.batches}: taranan {c.scanned} olusan {c.created} "
                    f"var {c.existing} atlanan {sum(c.skipped.values())} "
                    f"son_kimlik {c.last_external_id}"
                ),
            )
            run.detail.update(
                scanned=dcounts.scanned,
                created=dcounts.created,
                existing=dcounts.existing,
                skipped=sum(dcounts.skipped.values()),
                completed=dcounts.completed,
                dry_run=args.dry_run,
            )
        suffix = " (hicbir sey yazilmadi)" if args.dry_run else ""
        print(
            f"bitti={dcounts.completed} olusan={dcounts.created} var={dcounts.existing} "
            f"atlanan={dcounts.skipped}{suffix}"
        )
        return 0

    if args.command == "build":
        with job_run.track("catalog_build") as run, connect() as conn:
            gov = _governor(conn, args)
            counts = build_mod.build_source_products(
                conn,
                merchant_slug=args.merchant,
                batch_size=args.batch,
                max_batches=args.max_batches,
                max_seconds=args.max_seconds,
                rescan=args.rescan,
                sleep_seconds=args.sleep_ms / 1000,
                should_stop=_should_stop,
                on_batch=lambda c: print(
                    f"parti {c.batches}: taranan {c.scanned} olusan {c.created} "
                    f"var {c.existing} atlanan {sum(c.skipped.values())} "
                    f"son_offer {c.last_offer_id}"
                ),
                throttle=gov.before_batch,
            )
            run.detail.update(
                scanned=counts.scanned,
                created=counts.created,
                existing=counts.existing,
                attached=counts.attached,
                skipped=sum(counts.skipped.values()),
                batches=counts.batches,
                completed=counts.completed,
            )
            code = _finish_wal(run, gov)
        print(
            f"\nbitti={counts.completed} olusan={counts.created} "
            f"kesif_taslagina_baglanan={counts.attached} atlanan={counts.skipped}"
        )
        return code

    if args.command == "gate":
        with job_run.track("catalog_gate") as run, connect() as conn:
            gov = _governor(conn, args)
            counts = gate_mod.run_gate(
                conn,
                after_id=args.after_id,
                batch_size=args.batch,
                max_batches=args.max_batches,
                stale_days=args.stale_days,
                allow_foreign=args.allow_foreign,
                should_stop=_should_stop,
                on_batch=lambda c: print(
                    f"parti {c.batches}: taranan {c.scanned} hazir {c.ready} "
                    f"son_urun {c.last_product_id}"
                ),
                throttle=gov.before_batch,
            )
            run.detail.update(
                scanned=counts.scanned, ready=counts.ready, held=sum(counts.held.values())
            )
            code = _finish_wal(run, gov)
        print(
            f"\nbitti={counts.completed} hazir={counts.ready} beklemede={counts.held} "
            f"yurt_disi_karar_bekliyor={counts.foreign_blocked}"
        )
        return code

    if args.command == "publish":
        if not args.confirm:
            print("yayin icin --confirm gerekli; hicbir sey yazilmadi", file=sys.stderr)
            return 2
        with job_run.track("catalog_publish") as run, connect() as conn:
            merchant_id = build_mod.merchant_id_for(conn, args.merchant) if args.merchant else None
            gov = _governor(conn, args)
            counts = publish_mod.publish_ready(
                conn,
                limit=args.limit,
                merchant_id=merchant_id,
                batch_size=max(1, min(args.batch, publish_mod.DEFAULT_BATCH)),
                allow_foreign=args.allow_foreign,
                should_stop=_should_stop,
                throttle=gov.before_batch,
            )
            run.detail.update(
                selected=counts.selected, published=counts.published, held=sum(counts.held.values())
            )
            code = _finish_wal(run, gov)
        print(
            f"yayinlanan={counts.published} beklemeye={counts.held} hazir_kalan={counts.left_ready}"
        )
        return code

    if args.command == "unpublish":
        if not args.confirm:
            print("geri alma icin --confirm gerekli; hicbir sey yazilmadi", file=sys.stderr)
            return 2
        with connect() as conn:
            n = publish_mod.unpublish(conn, args.product_id)
        print(f"geri alinan={n}")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
