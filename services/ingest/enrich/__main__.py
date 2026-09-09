"""Embedding uretimi CLI'si.

    python -m enrich --kind both
    python -m enrich --kind image --limit 50
    python -m enrich --kind both --fake-client   # anahtar yokken

Bu servis hicbir HTTP endpoint sunmaz. Zamanlanmis calisir; istek yolundan
uzaktir. Kullanicinin yukledigi gorselin embedding'i BURADA uretilmez —
o TypeScript istek yolunda, `EmbeddingService` arkasindadir (D4).
"""

from __future__ import annotations

import argparse
import logging
import sys

from db.connection import connect
from enrich.client import EmbeddingClient, FakeEmbeddingClient, JinaEmbeddingClient
from enrich.pipeline import EnrichCounts, embed_images, embed_texts


def _report(label: str, counts: EnrichCounts) -> None:
    print(f"--- {label} ---")
    print(f"  aday offer       {counts.considered}")
    print(f"  embedding satiri {counts.embedded}")
    print(f"  API cagrisi      {counts.api_calls}")
    print(f"  yineleme isabeti {counts.deduped}")
    print(f"  atlanan          {counts.skipped}")
    print(f"  token            {counts.tokens}")
    for error in counts.errors:
        print(f"  ! {error}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="enrich", description="Embedding uretimi (B3)")
    parser.add_argument("--kind", choices=("image", "text", "both"), default="both")
    parser.add_argument("--limit", type=int, default=1000, help="kind basina ust sinir")
    parser.add_argument(
        "--fake-client",
        action="store_true",
        help="deterministik sahte istemci; API anahtari gerektirmez",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    client: EmbeddingClient = FakeEmbeddingClient() if args.fake_client else JinaEmbeddingClient()
    if args.fake_client:
        print("UYARI: sahte istemci kullaniliyor, vektorler anlamsal DEGIL.\n")

    failed = False
    with connect() as conn:
        if args.kind in ("image", "both"):
            counts = embed_images(conn, client, limit=args.limit)
            conn.commit()
            _report("gorsel", counts)
            failed = failed or bool(counts.errors)

        if args.kind in ("text", "both"):
            counts = embed_texts(conn, client, limit=args.limit)
            conn.commit()
            _report("metin", counts)
            failed = failed or bool(counts.errors)

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
