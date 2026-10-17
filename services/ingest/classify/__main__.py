"""Urun siniflandirmasi (karar 0133).

python -m classify report   [--merchant aliexpress] [--batch 2000] [--max-batches N] [--after-id N]
python -m classify sources  --merchant aliexpress [--apply] [--top 40]
python -m classify products --confirm [--merchant aliexpress] [--batch 2000] [--max-batches N]
                            [--max-seconds S]
                            [--sleep-ms MS] [--rescan] [--max-archive-lag-gb 2]
python -m classify status
python -m classify lexicon  [--apply]

`report` ve `sources` (`--apply` olmadan) YALNIZCA OKUR: uretimde guvenle olcer, hicbir sey
yazmaz. `products` `--confirm` olmadan calismaz; `catalog_build` oturumu varken baslamaz;
Ctrl+C / SIGTERM mevcut partiyi bitirip durur, ayni komut kaldigi yerden surer.
`lexicon --apply` arama/sohbete kategori filtresini acar: siniflandirma bittikten SONRA.
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys

import psycopg

from classify import lexicon as lexicon_mod
from classify import run as run_mod
from classify.taxonomy import APPLY_MIN_CONFIDENCE, RULE_VERSION
from db import job_run
from db.connection import connect

_stop = False


def _request_stop(_signum: int, _frame: object) -> None:
    global _stop
    _stop = True
    print("\ndurdurma istendi: mevcut parti bitince cikilacak", file=sys.stderr)


def _should_stop() -> bool:
    return _stop


def _progress(c: run_mod.Counts) -> None:
    print(
        f"parti {c.batches}: taranan {c.scanned} marka+{c.brand_set} kategori+{c.category_set} "
        f"inceleme {c.review} hata {c.errors} son_urun {c.last_product_id}",
        flush=True,
    )


def _summary(c: run_mod.Counts, *, dry_run: bool) -> None:
    verb = "yazilirdi" if dry_run else "yazildi"
    print(f"\nkural surumu {RULE_VERSION}, esik {APPLY_MIN_CONFIDENCE}")
    print(f"taranan {c.scanned}, zaten tam {c.unchanged}, bitti={c.completed}")
    print(f"marka {verb} {c.brand_set}; kategori {verb} {c.category_set}")
    print(f"inceleme bekleyen {c.review}; hata {c.errors}")
    print("marka kaniti:", dict(c.brand_basis.most_common()))
    print("kategori kaniti:", dict(c.category_basis.most_common()))
    if c.review_sources:
        print("incelemeye en cok urun dusuren kaynak yollari:")
        for path, n in c.review_sources.most_common(20):
            print(f"  {n:>8}  {path}")


def _status(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT rule_version || ' ' || scope, last_product_id, scanned, brand_set,
                      category_set, review, errors, started_at, updated_at, completed_at
                 FROM product_classification_state ORDER BY rule_version, scope"""
        )
        for row in cur.fetchall():
            print(
                f"surum {row[0]}: son_urun {row[1]} taranan {row[2]} marka+{row[3]} "
                f"kategori+{row[4]} inceleme {row[5]} hata {row[6]} baslangic {row[7]} "
                f"son {row[8]} tamamlandi {row[9]}"
            )
        cur.execute(
            """SELECT state, count(*) FROM product_classification
                WHERE state <> 'applied' GROUP BY 1 ORDER BY 1"""
        )
        for state, n in cur.fetchall():
            print(f"acik {state:<8} {n}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="classify", description="Urun siniflandirmasi")
    parser.add_argument("--verbose", "-v", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    p_report = sub.add_parser("report", help="YALNIZCA OKUR: kac urun siniflandirilabilir")
    p_report.add_argument("--batch", type=int, default=run_mod.DEFAULT_BATCH)
    p_report.add_argument("--max-batches", type=int, default=None)
    p_report.add_argument("--after-id", type=int, default=0)
    p_report.add_argument("--merchant", default=None)

    p_src = sub.add_parser("sources", help="kaynak kategori yollari ve eslemeleri")
    p_src.add_argument("--merchant", required=True)
    p_src.add_argument("--apply", action="store_true", help="onerileri category_source_map'e yaz")
    p_src.add_argument("--top", type=int, default=40)

    p_run = sub.add_parser("products", help="urun marka/kategori alanlarini doldurur")
    p_run.add_argument("--confirm", action="store_true")
    p_run.add_argument("--merchant", default=None, help="yalnizca bu kaynagin urunleri")
    p_run.add_argument("--batch", type=int, default=run_mod.DEFAULT_BATCH)
    p_run.add_argument("--max-batches", type=int, default=None)
    p_run.add_argument("--max-seconds", type=float, default=None)
    p_run.add_argument("--sleep-ms", type=int, default=200)
    p_run.add_argument("--rescan", action="store_true")
    p_run.add_argument("--max-archive-lag-gb", type=float, default=2.0)

    sub.add_parser("status")

    p_lex = sub.add_parser("lexicon", help="arama/sohbet kategori sozlugu")
    p_lex.add_argument("--apply", action="store_true")

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO)
    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)

    if args.command == "report":
        with connect() as conn:
            counts = run_mod.classify_products(
                conn,
                batch_size=args.batch,
                max_batches=args.max_batches,
                after_id=args.after_id,
                merchant_slug=args.merchant,
                dry_run=True,
                should_stop=_should_stop,
                on_batch=_progress,
            )
        _summary(counts, dry_run=True)
        return 0

    if args.command == "sources":
        with connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT id FROM merchant WHERE slug = %s", (args.merchant,))
            row = cur.fetchone()
            if row is None:
                print(f"magaza yok: {args.merchant}", file=sys.stderr)
                return 2
            out = run_mod.source_coverage(conn, int(row[0]), write=args.apply)
        total = sum(n for _, n, _, _, _ in out) or 1
        auto = sum(n for _, n, p, c, _ in out if p and c >= APPLY_MIN_CONFIDENCE)
        weak = sum(n for _, n, p, c, _ in out if p and c < APPLY_MIN_CONFIDENCE)
        print(f"kaynak yolu {len(out)}, teklif {total}")
        print(f"otomatik eslenen teklif {auto} (%{100 * auto / total:.1f})")
        print(f"zayif eslenen (baslik dogrulamasi gerekir) {weak} (%{100 * weak / total:.1f})")
        print(f"eslenmeyen {total - auto - weak} (%{100 * (total - auto - weak) / total:.1f})")
        print("eslenmeyen/zayif en buyuk yollar:")
        for raw, n, path, conf, status in [
            o for o in out if not o[2] or o[3] < APPLY_MIN_CONFIDENCE
        ][: args.top]:
            print(f"  {n:>8}  {raw}  -> {path or '-'} ({conf}, {status})")
        return 0

    if args.command == "products":
        if not args.confirm:
            print("yazmak icin --confirm gerekli; olcum icin `report`", file=sys.stderr)
            return 2
        with job_run.track("classify_products") as run, connect() as conn:
            try:
                counts = run_mod.classify_products(
                    conn,
                    batch_size=args.batch,
                    max_batches=args.max_batches,
                    max_seconds=args.max_seconds,
                    sleep_seconds=args.sleep_ms / 1000,
                    rescan=args.rescan,
                    merchant_slug=args.merchant,
                    max_archive_lag=int(args.max_archive_lag_gb * (1 << 30)),
                    should_stop=_should_stop,
                    on_batch=_progress,
                )
            except run_mod.ClassifyAborted as error:
                run.status = "failed"
                run.error_summary = error.code
                print(f"durdu: {error}", file=sys.stderr)
                return 3
            run.detail.update(
                rule_version=RULE_VERSION,
                scanned=counts.scanned,
                brand_set=counts.brand_set,
                category_set=counts.category_set,
                review=counts.review,
                errors=counts.errors,
                last_product_id=counts.last_product_id,
                completed=counts.completed,
            )
            if counts.errors:
                run.status = "partial"
        _summary(counts, dry_run=False)
        return 0

    if args.command == "status":
        with connect() as conn:
            return _status(conn)

    if args.command == "lexicon":
        with connect() as conn:
            report = lexicon_mod.apply(conn, write=args.apply)
        verb = "eklendi" if args.apply else "eklenecek"
        print(f"{verb} {report.inserted}, zaten var {report.existing}")
        for line in report.conflicts or []:
            print(f"catisma (degistirilmedi): {line}")
        for path in report.missing_paths or []:
            print(f"kategori yok (atlandi): {path}")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
