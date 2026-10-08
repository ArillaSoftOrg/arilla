"""Trend eslestirme CLI'si.

    python -m curate                       # kuru kosu: rapor, yazim yok
    python -m curate --apply               # trend_product'i yeniden yazar
    python -m curate --slug kuru-ciltlere-son --show 24

Uretim guvenligi: `--apply` yalnizca YEREL veritabaninda calisir. Uzak bir
veritabanina yazmak icin ayrica `--allow-remote` gerekir; bu bayrak yalnizca
bilincli, onayli bir yayin adimi icindir. Adres/parola ASLA yazdirilmaz.
"""

from __future__ import annotations

import argparse
import json
import sys

import psycopg

from curate.trends import TrendResult, is_local_url, run
from db.connection import database_url


def _print_report(results: list[TrendResult], show: int) -> None:
    print(f"{'trend':<40} {'aday':>5} {'secilen':>8}  durum")
    for r in results:
        note = f"  ({r.note})" if r.note else ""
        print(f"{r.slug:<40} {r.candidates:>5} {r.count:>8}  {r.status}{note}")
        if show:
            for s in r.selected[:show]:
                c = s.candidate
                print(
                    f"      {s.score:4.1f}  {c.merchant:<18} {(c.brand or '-')[:18]:<18} "
                    f"{c.title[:70]}"
                )
    by_status: dict[str, int] = {}
    for r in results:
        by_status[r.status] = by_status.get(r.status, 0) + 1
    print("\nOzet:", ", ".join(f"{k}={v}" for k, v in sorted(by_status.items())))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="curate", description="Trend-urun eslestirme")
    parser.add_argument(
        "--apply", action="store_true", help="trend_product'i yaz (varsayilan: kuru kosu)"
    )
    parser.add_argument(
        "--allow-remote", action="store_true", help="uzak veritabanina yazima izin ver"
    )
    parser.add_argument("--slug", action="append", help="yalniz bu trend(ler)")
    parser.add_argument("--show", type=int, default=0, help="her trend icin ilk N urunu listele")
    parser.add_argument("--json", dest="json_path", help="raporu JSON olarak yaz")
    parser.add_argument("--env", default="DATABASE_URL", help="baglanti degiskeni adi")
    args = parser.parse_args(argv)

    url = database_url(args.env)
    if args.apply and not is_local_url(url) and not args.allow_remote:
        print(
            "HATA: --apply uzak bir veritabanini gosteriyor; yazim reddedildi "
            "(bilincli yayin icin --allow-remote).",
            file=sys.stderr,
        )
        return 2

    with psycopg.connect(url) as conn:
        results = run(conn, apply=args.apply, slugs=args.slug)

    _print_report(results, args.show)
    print("YAZILDI." if args.apply else "KURU KOSU: veritabanina yazilmadi.")
    if args.json_path:
        report = [
            {
                "slug": r.slug,
                "candidates": r.candidates,
                "selected": r.count,
                "status": r.status,
                "min_price": r.min_price,
                "note": r.note,
                "products": [s.candidate.product_id for s in r.selected],
            }
            for r in results
        ]
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
