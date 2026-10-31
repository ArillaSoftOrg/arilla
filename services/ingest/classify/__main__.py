"""Urun siniflandirmasi (karar 0133).

python -m classify report   [--merchant aliexpress] [--batch 2000] [--max-batches N] [--after-id N]
python -m classify sources  --merchant aliexpress [--apply] [--top 40]
python -m classify products --confirm [--merchant aliexpress] [--batch 2000] [--max-batches N]
                            [--max-seconds S]
                            [--sleep-ms MS] [--rescan | --owned-only [--after-id N]]
                            [--wal-target-mb 1024 ...]
python -m classify parents-report [--merchant aliexpress]  # YALNIZCA OKUR (0161)
python -m classify parents  --confirm [--merchant aliexpress] [--batch 2000] [--max-batches N]
                            [--max-seconds S] [--sleep-ms MS] [--rescan] [--wal-target-mb ...]
python -m classify parents-undo --confirm [--batch 2000] [--max-batches N]
python -m classify status
python -m classify sample  --merchant aliexpress [--n 200] [--seed 1]   # YALNIZCA OKUR, TSV
python -m classify recheck  [--merchant aliexpress] [--limit N]          # YALNIZCA OKUR, TSV
python -m classify evaluate --labels dosya.tsv [--split dev|eval|all] [--json cikti.json]
                            # dosya = `sample` TSV'si (expected_* etiketli); veritabani YOK
python -m classify lexicon  [--apply]
python -m classify compare  [--n 5000] [--mode random|first] [--seed 1] [--scope PATH ...]
                            [--tsv dosya] [--only-changed]   # YALNIZCA OKUR (karar 0154)
python -m classify scope list
python -m classify scope set --path PATH --mode apply|off --by AD --reason METIN --confirm
`--dynamic` (products/report/recheck/sample): etkin kapsamlarda dinamik aday secimi V5'i inceltir
(karar 0154); varsayilan KAPALI. Etkin kapsam yoksa V5 ile ayni.

`report` ve `sources` (`--apply` olmadan) YALNIZCA OKUR: uretimde guvenle olcer, hicbir sey
yazmaz. `products` `--confirm` olmadan calismaz; `catalog_build` oturumu varken baslamaz;
Ctrl+C / SIGTERM mevcut partiyi bitirip durur, ayni komut kaldigi yerden surer.
`lexicon --apply` arama/sohbete kategori filtresini acar: siniflandirma bittikten SONRA.

Yeni kural surumunden sonra (karar 0138) once `recheck` (eski/yeni deger, geri alma kaydi),
sonra `products --confirm --owned-only`: yalnizca bu isin yazdigi degerler yeniden karar alir;
yonetici/besleme degeri ve henuz siniflandirilmamis urunler dokunulmaz.
"""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys

import psycopg

from classify import compare as compare_mod
from classify import lexicon as lexicon_mod
from classify import parent_apply as parent_mod
from classify import run as run_mod
from classify import scope as scope_mod
from classify.taxonomy import APPLY_MIN_CONFIDENCE, RULE_VERSION
from db import job_run, wal_pressure
from db.connection import connect

_stop = False


def _request_stop(_signum: int, _frame: object) -> None:
    global _stop
    _stop = True
    print("\ndurdurma istendi: mevcut parti bitince cikilacak", file=sys.stderr)


def _should_stop() -> bool:
    return _stop


#: WAL geri basinci nedeniyle durdu (karar 0134; `catalog_build` ile ayni kod): cokme degil,
#: arsiv yetisince ayni komut kaldigi yerden surer.
EXIT_WAL_BACKPRESSURE = 3
#: Guvenlik kontrolu (catalog_build calisiyor, zaten calisiyor, kilit zaman asimi) ile durdu.
EXIT_ABORTED = 4

TSV_SEP = "\t"


def _tsv_cell(value: object) -> str:
    return str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")


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


def _parent_progress(c: run_mod.Counts) -> None:
    print(
        f"parti {c.batches}: taranan {c.scanned} kategori+{c.category_set} "
        f"kategorisiz {c.review} hata {c.errors} son_urun {c.last_product_id}",
        flush=True,
    )


def _parents_report(rows: list[parent_mod.ReportRow], top: int) -> None:
    total = sum(r.products for r in rows)
    by_reason: dict[str, int] = {}
    by_state: dict[tuple[str, str], int] = {}
    by_target: dict[str, int] = {}
    for r in rows:
        by_reason[r.reason] = by_reason.get(r.reason, 0) + r.products
        by_state[(r.state, r.reason)] = by_state.get((r.state, r.reason), 0) + r.products
        if r.target:
            by_target[r.target] = by_target.get(r.target, 0) + r.products
    written = by_reason.get("parent", 0)
    share = 100 * written / (total or 1)
    print(f"kategorisiz urun {total}; ust kategori YAZILIRDI {written} (%{share:.1f})")
    print("neden:", dict(sorted(by_reason.items(), key=lambda kv: -kv[1])))
    print("yayin durumu x neden:")
    for (state, reason), n in sorted(by_state.items(), key=lambda kv: -kv[1]):
        print(f"  {n:>9}  {state:<10} {reason}")
    print("hedef kategori (en cok urun):")
    for target, n in sorted(by_target.items(), key=lambda kv: -kv[1])[:top]:
        print(f"  {n:>9}  {target}")
    print("kategorisiz kalacak kaynak yollari (en cok urun):")
    left = [r for r in rows if r.target is None][:top]
    for r in left:
        print(f"  {r.products:>9}  {r.reason:<9} {r.state:<10} {r.source or '-'}")


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

    p_report.add_argument("--dynamic", action="store_true", help="dinamik aday secimi (karar 0154)")

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
    p_run.add_argument(
        "--dynamic",
        action="store_true",
        help="etkin kapsamlarda dinamik aday secimi V5'i inceltir (karar 0154; kural surumu +1)",
    )
    p_run.add_argument(
        "--owned-only",
        action="store_true",
        help="yalnizca bu isin yazdigi degerleri tasiyan urunler (kontrol noktasi yok)",
    )
    p_run.add_argument(
        "--after-id",
        type=int,
        default=None,
        help="bu urun kimliginden sonra (--owned-only surdurme)",
    )
    wal = p_run.add_argument_group("WAL geri basinci (karar 0134; catalog_build ile ayni)")
    wal.add_argument(
        "--wal-target-mb", type=int, default=1024, help="bu gecikmenin ustunde yavasla"
    )
    wal.add_argument("--wal-pause-mb", type=int, default=1536, help="bu gecikmede parti baslatma")
    wal.add_argument("--wal-resume-mb", type=int, default=512, help="duraklamadan bu gecikmede cik")
    wal.add_argument("--wal-max-sleep-s", type=float, default=30.0, help="parti arasi en uzun uyku")
    wal.add_argument("--wal-max-pause-s", type=float, default=3600.0, help="en uzun duraklama")
    wal.add_argument(
        "--wal-failing-grace-s", type=float, default=900.0, help="arsiv hatasi toleransi"
    )

    sub.add_parser("status")

    p_sample = sub.add_parser("sample", help="YALNIZCA OKUR: rastgele urun + karar (etiketleme)")
    p_sample.add_argument("--merchant", default=None)
    p_sample.add_argument("--n", type=int, default=200)
    p_sample.add_argument("--seed", type=int, default=None)
    p_sample.add_argument(
        "--per-source",
        type=int,
        default=None,
        help="tabakali: genis bir rastgele havuzdan kaynak kategori basina en fazla K urun",
    )
    p_sample.add_argument("--split", choices=("dev", "eval", "all"), default="all")
    p_sample.add_argument("--dynamic", action="store_true")

    p_re = sub.add_parser(
        "recheck", help="YALNIZCA OKUR: sahip olunan urunler yeni kurallarla (eski/yeni, TSV)"
    )
    p_re.add_argument("--merchant", default=None)
    p_re.add_argument("--limit", type=int, default=None)
    p_re.add_argument("--dynamic", action="store_true")

    p_cmp = sub.add_parser(
        "compare", help="YALNIZCA OKUR: V5 ve dinamik karar yan yana (karar 0154)"
    )
    p_cmp.add_argument("--n", type=int, default=5000)
    p_cmp.add_argument("--mode", choices=("random", "first"), default="random")
    p_cmp.add_argument("--seed", type=int, default=1)
    p_cmp.add_argument("--after-id", type=int, default=0)
    p_cmp.add_argument("--merchant", default=None)
    p_cmp.add_argument(
        "--scope",
        action="append",
        default=None,
        help="kategori yolu (tekrarlanabilir); yoksa tum Trendyol dallari",
    )
    p_cmp.add_argument("--tsv", default=None, help="degisen/tum satirlari TSV'ye yaz")
    p_cmp.add_argument("--only-changed", action="store_true")
    p_cmp.add_argument("--json", default=None)

    p_scope = sub.add_parser("scope", help="dinamik kapsam yonetimi (karar 0154)")
    scope_sub = p_scope.add_subparsers(dest="scope_command", required=True)
    scope_sub.add_parser("list")
    p_set = scope_sub.add_parser("set")
    p_set.add_argument("--path", required=True)
    p_set.add_argument("--mode", choices=("apply", "off"), required=True)
    p_set.add_argument("--by", required=True)
    p_set.add_argument("--reason", required=True)
    p_set.add_argument("--confirm", action="store_true")

    p_ev = sub.add_parser("evaluate", help="etiketli TSV uzerinde precision/kapsama (DB yok)")
    p_ev.add_argument("--labels", required=True)
    p_ev.add_argument("--split", choices=("dev", "eval", "all"), default="all")
    p_ev.add_argument("--json", default=None)

    p_pr = sub.add_parser("parents-report", help="YALNIZCA OKUR: ust kategori yazim kapsami")
    p_pr.add_argument("--merchant", default="aliexpress")
    p_pr.add_argument("--top", type=int, default=25)

    for name, text in (
        ("parents", "kategorisiz urunlere kaynak ust kategorisini yazar (karar 0161)"),
        ("parents-undo", "parents'in yazdigi kategorileri geri alir (karar 0161)"),
    ):
        p_par = sub.add_parser(name, help=text)
        p_par.add_argument("--confirm", action="store_true")
        p_par.add_argument("--batch", type=int, default=parent_mod.DEFAULT_BATCH)
        p_par.add_argument("--max-batches", type=int, default=None)
        p_par.add_argument("--sleep-ms", type=int, default=200)
        if name == "parents":
            p_par.add_argument("--merchant", default="aliexpress")
            p_par.add_argument("--max-seconds", type=float, default=None)
            p_par.add_argument("--rescan", action="store_true")
            p_par.add_argument("--after-id", type=int, default=None)
        par_wal = p_par.add_argument_group("WAL geri basinci (karar 0134; catalog_build ile ayni)")
        par_wal.add_argument("--wal-target-mb", type=int, default=1024)
        par_wal.add_argument("--wal-pause-mb", type=int, default=1536)
        par_wal.add_argument("--wal-resume-mb", type=int, default=512)
        par_wal.add_argument("--wal-max-sleep-s", type=float, default=30.0)
        par_wal.add_argument("--wal-max-pause-s", type=float, default=3600.0)
        par_wal.add_argument("--wal-failing-grace-s", type=float, default=900.0)

    p_lex = sub.add_parser("lexicon", help="arama/sohbet kategori sozlugu")
    p_lex.add_argument("--apply", action="store_true")

    from classify.suggest import cli as suggest_cli  # agir bagimliliklar komut icinde yuklenir

    suggest_cli.add_parser(sub)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO)
    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)

    if args.command == "suggest":
        return suggest_cli.main(args)

    if args.command == "report":
        with connect() as conn:
            counts = run_mod.classify_products(
                conn,
                batch_size=args.batch,
                max_batches=args.max_batches,
                after_id=args.after_id,
                merchant_slug=args.merchant,
                dry_run=True,
                dynamic=args.dynamic,
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
            gov = wal_pressure.WalGovernor.for_connection(
                conn,
                wal_pressure.policy_from_mb(
                    target_mb=args.wal_target_mb,
                    pause_mb=args.wal_pause_mb,
                    resume_mb=args.wal_resume_mb,
                    max_sleep_s=args.wal_max_sleep_s,
                    max_pause_s=args.wal_max_pause_s,
                    failing_grace_s=args.wal_failing_grace_s,
                ),
                should_stop=_should_stop,
            )
            try:
                counts = run_mod.classify_products(
                    conn,
                    batch_size=args.batch,
                    max_batches=args.max_batches,
                    max_seconds=args.max_seconds,
                    sleep_seconds=args.sleep_ms / 1000,
                    rescan=args.rescan,
                    merchant_slug=args.merchant,
                    owned_only=args.owned_only,
                    dynamic=args.dynamic,
                    after_id=args.after_id,
                    throttle=gov.before_batch,
                    should_stop=_should_stop,
                    on_batch=_progress,
                )
            except run_mod.ClassifyAborted as error:
                run.status = "failed"
                run.error_summary = error.code
                print(f"durdu: {error}", file=sys.stderr)
                return EXIT_ABORTED
            run.detail.update(
                rule_version=run_mod.active_rule_version(conn, args.dynamic),
                dynamic=args.dynamic,
                owned_only=args.owned_only,
                scanned=counts.scanned,
                brand_set=counts.brand_set,
                category_set=counts.category_set,
                review=counts.review,
                errors=counts.errors,
                last_product_id=counts.last_product_id,
                completed=counts.completed,
            )
            run.detail.update(gov.stats.as_detail())
            if counts.errors:
                run.status = "partial"
            if gov.stopped_reason is not None:
                run.status = "partial"
                run.error_summary = f"WAL geri basinci: {gov.stopped_reason}"
        _summary(counts, dry_run=False)
        if gov.stopped_reason is not None:
            print(f"WAL geri basinci nedeniyle durdu: {gov.stopped_reason}", file=sys.stderr)
            return EXIT_WAL_BACKPRESSURE
        return 0

    if args.command == "parents-report":
        with connect() as conn:
            try:
                rows = parent_mod.report(conn, merchant_slug=args.merchant)
            except run_mod.ClassifyAborted as error:
                print(f"durdu: {error}", file=sys.stderr)
                return EXIT_ABORTED
        _parents_report(rows, args.top)
        return 0

    if args.command in ("parents", "parents-undo"):
        if not args.confirm:
            print("yazmak icin --confirm gerekli; olcum icin `parents-report`", file=sys.stderr)
            return 2
        undo = args.command == "parents-undo"
        job = "classify_parent_undo" if undo else "classify_parent"
        with job_run.track(job) as run, connect() as conn:
            gov = wal_pressure.WalGovernor.for_connection(
                conn,
                wal_pressure.policy_from_mb(
                    target_mb=args.wal_target_mb,
                    pause_mb=args.wal_pause_mb,
                    resume_mb=args.wal_resume_mb,
                    max_sleep_s=args.wal_max_sleep_s,
                    max_pause_s=args.wal_max_pause_s,
                    failing_grace_s=args.wal_failing_grace_s,
                ),
                should_stop=_should_stop,
            )
            try:
                if undo:
                    counts = parent_mod.undo_parents(
                        conn,
                        batch_size=args.batch,
                        max_batches=args.max_batches,
                        sleep_seconds=args.sleep_ms / 1000,
                        throttle=gov.before_batch,
                        should_stop=_should_stop,
                    )
                else:
                    counts = parent_mod.apply_parents(
                        conn,
                        merchant_slug=args.merchant,
                        batch_size=args.batch,
                        max_batches=args.max_batches,
                        max_seconds=args.max_seconds,
                        sleep_seconds=args.sleep_ms / 1000,
                        rescan=args.rescan,
                        after_id=args.after_id,
                        throttle=gov.before_batch,
                        should_stop=_should_stop,
                        on_batch=_parent_progress,
                    )
            except run_mod.ClassifyAborted as error:
                run.status = "failed"
                run.error_summary = error.code
                print(f"durdu: {error}", file=sys.stderr)
                return EXIT_ABORTED
            run.detail.update(
                rule_version=run_mod.PARENT_RULE_VERSION,
                scanned=counts.scanned,
                category_set=counts.category_set,
                review=counts.review,
                errors=counts.errors,
                last_product_id=counts.last_product_id,
                completed=counts.completed,
            )
            run.detail.update(gov.stats.as_detail())
            if counts.errors:
                run.status = "partial"
            if gov.stopped_reason is not None:
                run.status = "partial"
                run.error_summary = f"WAL geri basinci: {gov.stopped_reason}"
        verb = "geri alindi" if undo else "yazildi"
        print(
            f"\nkural surumu {run_mod.PARENT_RULE_VERSION}: taranan {counts.scanned}, "
            f"kategori {verb} {counts.category_set}, kategorisiz kalan {counts.review}, "
            f"hata {counts.errors}, bitti={counts.completed}, son_urun {counts.last_product_id}"
        )
        print("kaynak durumu:", dict(counts.category_basis.most_common()))
        if gov.stopped_reason is not None:
            print(f"WAL geri basinci nedeniyle durdu: {gov.stopped_reason}", file=sys.stderr)
            return EXIT_WAL_BACKPRESSURE
        return 0

    if args.command == "recheck":
        with connect() as conn:
            checks = run_mod.recheck_owned(
                conn, merchant_slug=args.merchant, limit=args.limit, dynamic=args.dynamic
            )
        # old_*_id: geri alma kaydi (karar 0138); action: keep | change | clear.
        cols = (
            "product_id", "title", "source_category", "old_category", "new_category", "action",
            "state", "category_basis", "confidence", "detail", "old_category_id",
            "new_category_id", "old_brand_id", "new_brand_id", "brand", "compatible",
        )  # fmt: skip
        print(TSV_SEP.join(cols))
        for c in checks:
            d = c.decision
            cells = (
                c.row.product_id, c.row.title, c.row.category_raw or "", c.old_category or "",
                c.new_category or "", c.action, d.state, d.category_basis, d.confidence,
                d.detail or "", c.row.category_id or "", c.new_category_id or "",
                c.row.brand_id or "", c.new_brand_id or "", d.brand_name or "",
                ",".join(d.compatible),
            )  # fmt: skip
            print(TSV_SEP.join(_tsv_cell(x) for x in cells))
        actions = {a: sum(1 for c in checks if c.action == a) for a in ("keep", "change", "clear")}
        print(f"sahip olunan {len(checks)}: {actions}", file=sys.stderr)
        return 0

    if args.command == "compare":
        from pathlib import Path

        with connect() as conn:
            result = compare_mod.compare(
                conn,
                n=args.n,
                mode=args.mode,
                seed=args.seed,
                after_id=args.after_id,
                merchant_slug=args.merchant,
                scopes=args.scope,
            )
        summary = result.summary()
        print(json.dumps({"scopes": len(result.scopes), **summary}, ensure_ascii=False, indent=2))
        if args.tsv:
            Path(args.tsv).write_text(
                compare_mod.tsv(result, only_changed=args.only_changed), encoding="utf-8"
            )
        if args.json:
            Path(args.json).write_text(
                json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
        return 0

    if args.command == "scope":
        with connect() as conn:
            if args.scope_command == "list":
                rows = scope_mod.list_scopes(conn)
                if not rows:
                    print("etkin kapsam yok (siniflandirici V5 davranisinda)")
                for r in rows:
                    print(
                        f"{r.mode:<5} {r.path} ({r.nodes} dugum) {r.decided_by} "
                        f"{r.updated_at:%Y-%m-%d %H:%M} | {r.note or ''}"
                    )
                return 0
            if not args.confirm:
                print("yazilmadi: degistirmek icin --confirm ekleyin", file=sys.stderr)
                return 0
            try:
                row = scope_mod.set_scope(
                    conn, args.path, args.mode, by=args.by, reason=args.reason
                )
            except scope_mod.ScopeError as error:
                print(f"degistirilmedi: {error}", file=sys.stderr)
                return 2
            print(f"{row.mode} {row.path} ({row.nodes} dugum), kayit: {row.decided_by}")
        return 0

    if args.command == "evaluate":
        from pathlib import Path

        from classify import evaluate as ev

        rows = ev.read_labels(Path(args.labels))
        if args.split != "all":
            rows = [r for r in rows if ev.split_of(r.product_id) == args.split]
        by_source = ev.score_by_label_source(rows)
        text = json.dumps(
            {k: v.__dict__ for k, v in by_source.items()},
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        print(text)
        if args.json:
            Path(args.json).write_text(f"{text}\n", encoding="utf-8")
        if "human" not in by_source:
            print(
                "UYARI: insan etiketi yok; rakamlar model/belirtilmemis etiketlidir ve dogruluk "
                "kaniti SAYILMAZ",
                file=sys.stderr,
            )
        if all(m.n_category_labeled == 0 for m in by_source.values()):
            print("UYARI: etiketli kategori yok; precision hesaplanamaz", file=sys.stderr)
        return 0

    if args.command == "sample":
        from classify import evaluate as ev

        pool = max(1, min(args.n, 5_000))
        with connect() as conn:
            pairs = run_mod.sample_decisions(
                conn,
                n=pool if args.per_source is None else 5_000,
                merchant_slug=args.merchant,
                seed=args.seed,
                dynamic=args.dynamic,
            )
        if args.per_source is not None:
            chosen = ev.stratified_sample(
                pairs, lambda p: p[0].category_raw or "", args.per_source, args.seed or 0
            )
            pairs = chosen[:pool]
        if args.split != "all":
            pairs = [p for p in pairs if ev.split_of(str(p[0].product_id)) == args.split]
        # expected_*: etiketleyen kisi doldurur; dogruluk = eslesen / etiketlenen.
        cols = (
            "product_id", "title", "source_category", "category", "category_basis",
            "confidence", "brand", "brand_basis", "compatible", "expected_category",
            "expected_brand",
        )  # fmt: skip
        print(TSV_SEP.join(cols))
        for row, d in pairs:
            cells = (
                row.product_id, row.title, row.category_raw or "", d.category_path or "",
                d.category_basis, d.confidence, d.brand_name or "", d.brand_basis,
                ",".join(d.compatible), "", "",
            )  # fmt: skip
            print(TSV_SEP.join(_tsv_cell(c) for c in cells))
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
