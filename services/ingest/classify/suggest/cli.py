"""`python -m classify suggest ...` komutlari (karar 0155). Hicbir komut kategori YAZMAZ.

suggest model build  --out DIR                 # gelistirici araci: indir + ONNX + INT8 + manifest
suggest model verify --model-dir DIR           # kaynak/surum/SHA-256 dogrulamasi
suggest run --out DIR --model-dir DIR (--tsv F --categories-csv C --plan P | veritabani)
            [--merchant aliexpress] [--threads 2] [--embed-batch 64] [--db-batch 500]
            [--max-products N] [--max-seconds S] [--max-rss-mb MB] [--sleep-ms MS]
            [--calib-n 8000] [--restart] [--no-guards]
suggest export --out DIR --dest FILE [--format csv|json] [--top 3]
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import sys
from pathlib import Path

from classify.dynamic import DynamicIndex

logger = logging.getLogger(__name__)
INDEX_FILE = "index.npz"


def add_parser(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "suggest", help="hibrit kategori onerisi: YALNIZCA ONERI, yazmaz (karar 0155)"
    )
    s = p.add_subparsers(dest="suggest_cmd", required=True)
    pm = s.add_parser("model")
    ms = pm.add_subparsers(dest="model_cmd", required=True)
    mb = ms.add_parser("build")
    mb.add_argument("--out", required=True)
    mv = ms.add_parser("verify")
    mv.add_argument("--model-dir", required=True)
    pr = s.add_parser("run")
    pr.add_argument("--out", required=True)
    pr.add_argument("--model-dir", required=True)
    pr.add_argument("--tsv", help="id<TAB>baslik<TAB>kaynak_yolu (veritabani yerine)")
    pr.add_argument("--categories-csv", help="id,path,name,parent_id (--tsv ile)")
    pr.add_argument("--plan", help="Trendyol plan CSV'si (kapsam dallari; --tsv ile)")
    pr.add_argument("--merchant")
    pr.add_argument("--threads", type=int, default=2)
    pr.add_argument("--embed-batch", type=int, default=64)
    pr.add_argument("--db-batch", type=int, default=500)
    pr.add_argument("--max-products", type=int)
    pr.add_argument("--max-seconds", type=float)
    pr.add_argument("--max-rss-mb", type=float)
    pr.add_argument("--sleep-ms", type=int, default=0)
    pr.add_argument("--calib-n", type=int, default=8000)
    pr.add_argument(
        "--calib-tsv", help="z-skor kalibrasyonu icin baslik dosyasi (varsayilan --tsv)"
    )
    pr.add_argument("--after-id", type=int, default=0)
    pr.add_argument("--restart", action="store_true")
    pr.add_argument("--no-guards", action="store_true")
    pe = s.add_parser("export")
    pe.add_argument("--out", required=True)
    pe.add_argument("--dest", required=True)
    pe.add_argument("--format", choices=("csv", "json"), default="csv")
    pe.add_argument("--top", type=int, default=3)


def _scopes_from_plan(plan: str) -> list[str]:
    with open(plan, encoding="utf-8") as f:
        created = {r["manicepte_path"] for r in csv.DictReader(f) if r["action"] == "create"}
    return sorted(p for p in created if "/" not in p or p.rsplit("/", 1)[0] not in created)


def _load_categories_csv(path: str) -> list:
    from classify.suggest.engine import CategoryRow

    with open(path, encoding="utf-8") as f:
        return [CategoryRow(int(r["id"]), r["path"], r["name"]) for r in csv.DictReader(f)]


def _calibration_from_tsv(path: str, n: int) -> list[str]:
    with open(path, encoding="utf-8") as f:
        titles = [ln.split("\t")[1] for ln in f if ln.count("\t") >= 1]
    step = max(1, len(titles) // max(n, 1))
    return titles[::step][:n]


def _calibration_from_db(conn, n: int) -> list[str]:  # noqa: ANN001
    with conn.cursor() as cur:
        cur.execute("SELECT title FROM product WHERE id % 331 = 0 ORDER BY id LIMIT %s", (n,))
        rows = [str(r[0]) for r in cur.fetchall()]
    conn.rollback()
    return rows


def run_command(args: argparse.Namespace) -> int:
    from classify.suggest.batch import Runner, db_batches, tsv_batches
    from classify.suggest.engine import CategoryRow, Suggester, TreeIndex, tree_version
    from classify.suggest.model import PASSAGE_PREFIX, QUERY_PREFIX, OnnxEmbedder

    if args.threads < 1 or args.embed_batch < 1 or args.db_batch < 1:
        raise SystemExit("--threads/--embed-batch/--db-batch >= 1 olmali")
    base = OnnxEmbedder(args.model_dir, threads=args.threads, batch_size=args.embed_batch)
    passage, query = base.with_prefix(PASSAGE_PREFIX), base.with_prefix(QUERY_PREFIX)
    conn = None
    if args.tsv:
        if not (args.categories_csv and args.plan):
            raise SystemExit("--tsv icin --categories-csv ve --plan gerekir")
        rows = _load_categories_csv(args.categories_csv)
        scopes = _scopes_from_plan(args.plan)
        calib = _calibration_from_tsv(args.calib_tsv or args.tsv, args.calib_n)

        def batches(after: int):
            return tsv_batches(args.tsv, after_id=max(after, args.after_id), size=args.db_batch)

    else:
        import psycopg

        from classify.scope import trendyol_scopes

        url = os.environ.get("DATABASE_URL")
        if not url:
            raise SystemExit("DATABASE_URL tanimli degil")
        conn = psycopg.connect(url)
        conn.read_only = True  # bu komut asla yazmaz
        with conn.cursor() as cur:
            cur.execute("SELECT id, path, name FROM category")
            rows = [CategoryRow(int(r[0]), str(r[1]), str(r[2])) for r in cur.fetchall()]
        conn.rollback()
        scopes = trendyol_scopes(conn)
        calib = _calibration_from_db(conn, args.calib_n)

        def batches(after: int):
            return db_batches(
                conn,
                after_id=max(after, args.after_id),
                size=args.db_batch,
                merchant_slug=args.merchant,
            )

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    tver = tree_version(rows)
    index = TreeIndex.load(out / INDEX_FILE, model_version=base.model_version, tree_ver=tver)
    if index is None or index.mean is None:
        logger.info("kategori indeksi kuruluyor (%d kategori)", len(rows))
        index = TreeIndex.build(rows, passage)
        index.calibrate(query.encode(calib))
        index.save(out / INDEX_FILE)
    dyn = DynamicIndex([(r.path, r.name) for r in rows], scopes)
    suggester = Suggester(index, dyn, query, guards=not args.no_guards)
    runner = Runner(
        out, suggester, model_version=base.model_version, tree_version=tver, restart=args.restart
    )
    summary = runner.run(
        batches,
        max_products=args.max_products,
        max_seconds=args.max_seconds,
        max_rss_mb=args.max_rss_mb,
        sleep_ms=args.sleep_ms,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def main(args: argparse.Namespace) -> int:
    from classify.suggest.model import ModelError, build_model, verify_model_dir

    if args.suggest_cmd == "model":
        if args.model_cmd == "build":
            m = build_model(args.out)
            print(f"model hazir: {m.model_version}")
            return 0
        try:
            m = verify_model_dir(args.model_dir)
        except ModelError as exc:
            print(f"DOGRULAMA BASARISIZ: {exc}", file=sys.stderr)
            return 2
        print(f"dogrulandi: {m.model_version} (kaynak {m.source_repo}@{m.source_revision[:12]})")
        return 0
    if args.suggest_cmd == "export":
        from classify.suggest.batch import export

        n = export(args.out, args.dest, args.format, args.top)
        print(f"{n} urun disa aktarildi: {args.dest}")
        return 0
    return run_command(args)
