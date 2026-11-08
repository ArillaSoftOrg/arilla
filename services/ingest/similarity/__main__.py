"""Benzerlik ve fiyat istatistikleri CLI'si.

    python -m similarity              kenarlar + istatistikler
    python -m similarity --edges      yalnizca kenarlar
    python -m similarity --prices     yalnizca fiyat istatistikleri
    python -m similarity --dry-run    yaz, commit etme
    python -m similarity --prune      bu kosuda uretilmeyen eski kenarlari da sil

Gece toplu isidir. `pnpm seed` bu tablolari ARTIK doldurmuyor (tek dogru
kaynak burasi), o yuzden tohum verisinden sonra bu komut kosulmalidir.

Is sonucu (karar 0174, `db.job_run.OUTCOMES`), kenar kosusunda:
    completed         en az bir turde vektorlu urun vardi; kenar uretildigini ya da
                      diger turun eksiksiz oldugunu GARANTI ETMEZ (detail sayaclari)
    no_input          bagli aktif teklifi olan urun yok (no_eligible_products), cikis 0
    blocked_upstream  urun var ama hicbir turde embedding yok (no_embeddings), cikis 0
Cikis 0 yalnizca bu adim `arilla-catalog-pipeline` zincirinin SON adimi oldugu icin
guvenlidir; zincire bu adimdan sonra bir adim eklenirse yeniden degerlendirilmelidir.
"""

from __future__ import annotations

import argparse
import logging
import sys

import psycopg

from db import job_run
from db.connection import connect
from similarity.edges import MIN_SCORE, TOP_N
from similarity.pipeline import SimilarityCounts, run

#: Kenar uretiminin girdi kumesi (`edges.MODEL_GROUPS` ile ayni alan): bagli aktif teklif.
#: Yalnizca iki turde de vektorlu urun 0 ise sorulur; EXISTS ilk satirda durur,
#: katalog sayimi degildir (`offer_product_idx` kismi indeksi).
HAS_ELIGIBLE_PRODUCTS = """
SELECT EXISTS (SELECT 1 FROM offer WHERE product_id IS NOT NULL AND is_active)
"""


def job_name(do_edges: bool, do_prices: bool) -> str:
    """`job_run.job`: yonetim boru hatti asamalari bu adlari okur (karar 0055)."""
    if do_edges and do_prices:
        return "similarity"
    return "similarity_edges" if do_edges else "similarity_prices"


def edges_outcome(
    counts: SimilarityCounts, has_eligible_products: bool | None
) -> tuple[str, str | None]:
    """Kenar kosusunun sonucu: "hic urun yok" ile "urun var, embedding yok" ayrilir.

    `has_eligible_products` yalnizca iki turde de vektorlu urun 0 iken anlamlidir.
    """
    if counts.visual.products_with_vector or counts.semantic.products_with_vector:
        return "completed", None
    if has_eligible_products:
        return "blocked_upstream", "no_embeddings"
    return "no_input", "no_eligible_products"


def classify(
    conn: psycopg.Connection, counts: SimilarityCounts, *, do_edges: bool
) -> tuple[str, str | None]:
    """Kosu sonucu; ek sorgu yalnizca kenar kosusunda hic vektorlu urun yoksa atilir."""
    if not do_edges:
        return "completed", None
    if counts.visual.products_with_vector or counts.semantic.products_with_vector:
        return "completed", None
    with conn.cursor() as cur:
        cur.execute(HAS_ELIGIBLE_PRODUCTS)
        row = cur.fetchone()
    return edges_outcome(counts, bool(row and row[0]))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="similarity", description="Benzerlik ve fiyat (B5)")
    parser.add_argument("--edges", action="store_true", help="yalnizca kenarlar")
    parser.add_argument("--prices", action="store_true", help="yalnizca fiyat istatistikleri")
    parser.add_argument("--limit", type=int, default=None, help="urun sayisi siniri")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--prune",
        action="store_true",
        help="tam kosu sonunda bu kosuda uretilmeyen eski kenarlari sil (varsayilan: silme)",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    # Hicbiri secilmediyse ikisi de calisir.
    do_edges = args.edges or not args.prices
    do_prices = args.prices or not args.edges

    if args.dry_run:
        with connect() as conn:
            # Tek islem, sonunda geri alinir: ara commit yok.
            counts = run(conn, do_edges=do_edges, do_prices=do_prices, limit=args.limit)
            conn.rollback()
            # Salt okuma; geri alinmis veriye degil, kalici kataloga bakar.
            result = job_run.outcome(*classify(conn, counts, do_edges=do_edges))
            conn.rollback()
            print("(dry-run: hicbir degisiklik yazilmadi)\n")
    else:
        with (
            job_run.track(job_name(do_edges, do_prices), outcomes=True) as tracked,
            connect() as conn,
        ):
            # Parti basina commit: uzun islem, xmin tutma ve genis satir kilidi yok.
            counts = run(
                conn,
                do_edges=do_edges,
                do_prices=do_prices,
                limit=args.limit,
                commit=True,
                prune=args.prune,
            )
            conn.commit()
            if do_edges:
                tracked.detail.update(
                    visual_edges=counts.visual.edges_written,
                    semantic_edges=counts.semantic.edges_written,
                    visual_products=counts.visual.products_with_vector,
                    semantic_products=counts.semantic.products_with_vector,
                    edges_pruned=counts.visual.edges_pruned + counts.semantic.edges_pruned,
                )
            if do_prices:
                tracked.detail.update(
                    price_products=counts.prices.products,
                    price_aggregates=counts.prices.aggregates_updated,
                    price_stats_removed=counts.prices.removed,
                )
            tracked.set_outcome(*classify(conn, counts, do_edges=do_edges))
            conn.rollback()
            result = tracked.final_outcome()

    if do_edges:
        for label, group in (("visual", counts.visual), ("semantic", counts.semantic)):
            print(f"--- {label} (taban {MIN_SCORE[label]}, urun basina en fazla {TOP_N}) ---")
            print(f"  vektorlu urun    {group.products_with_vector}")
            print(f"  yazilan kenar    {group.edges_written}  (cift yonlu)")
            print(f"  taban alti aday  {group.below_floor}")
            print(f"  5'ten az kenarli {len(group.thin_products)}")

    if do_prices:
        print("--- fiyat istatistikleri ---")
        print(f"  urun             {counts.prices.products}")
        print(f"  sahte indirim    {counts.prices.inflated}")
        print(f"  urun ozeti       {counts.prices.aggregates_updated}")
        print(f"  silinen eski     {counts.prices.removed}")

    print(f"sonuc              {result.name}" + (f" ({result.reason})" if result.reason else ""))
    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
