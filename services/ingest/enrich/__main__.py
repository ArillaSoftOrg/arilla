"""Embedding uretimi CLI'si.

    python -m enrich --kind both
    python -m enrich --kind image --limit 50 --merchant-id 12
    python -m enrich --kind both --fake-client   # anahtar yokken

Bu servis hicbir HTTP endpoint sunmaz. Zamanlanmis calisir; istek yolundan
uzaktir. Kullanicinin yukledigi gorselin embedding'i BURADA uretilmez —
o TypeScript istek yolunda, `EmbeddingService` arkasindadir (D4).

Gercek istemci her zaman bir token butcesiyle kosar
(`JINA_TOKENS_PER_MINUTE`, varsayilan 80.000). Bkz. karar 0028.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from db.connection import connect
from enrich.client import EmbeddingClient, FakeEmbeddingClient, JinaEmbeddingClient
from enrich.images import PREPROCESS_VERSION
from enrich.pipeline import EnrichCounts, embed_images, embed_texts
from enrich.ratelimit import TokenBudget, tokens_per_minute_from_env


def _report(label: str, counts: EnrichCounts, seconds: float) -> None:
    print(f"--- {label} ---")
    print(f"  aday offer       {counts.considered}")
    print(f"  embedding satiri {counts.embedded}")
    print(f"  API cagrisi      {counts.api_calls}")
    print(f"  gonderilen gorsel {counts.images_sent}")
    print(f"  yineleme isabeti {counts.deduped}")
    print(f"  atlanan          {counts.skipped}")
    print(f"  basarisiz        {counts.failed}{' (kosu durdu)' if counts.aborted else ''}")
    print(f"  token            {counts.tokens}")
    print(f"  sure             {seconds:.1f} sn")
    for error in counts.errors:
        print(f"  ! {error}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="enrich", description="Embedding uretimi (B3)")
    parser.add_argument("--kind", choices=("image", "text", "both"), default="both")
    parser.add_argument("--limit", type=int, default=1000, help="kind basina ust sinir")
    parser.add_argument("--merchant-id", type=int, default=None, help="tek merchant'a daralt")
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

    budget: TokenBudget | None = None
    if args.fake_client:
        client: EmbeddingClient = FakeEmbeddingClient()
        print("UYARI: sahte istemci kullaniliyor, vektorler anlamsal DEGIL.\n")
    else:
        budget = TokenBudget(tokens_per_minute=tokens_per_minute_from_env())
        client = JinaEmbeddingClient(budget=budget)
        print(f"butce {budget.tokens_per_minute} token/dk, on isleme {PREPROCESS_VERSION}\n")

    failed = False
    with connect() as conn:
        if args.kind in ("image", "both"):
            started = time.monotonic()
            counts = embed_images(conn, client, limit=args.limit, merchant_id=args.merchant_id)
            conn.commit()
            _report("gorsel", counts, time.monotonic() - started)
            failed = failed or bool(counts.failed) or counts.aborted

        if args.kind in ("text", "both"):
            started = time.monotonic()
            counts = embed_texts(conn, client, limit=args.limit, merchant_id=args.merchant_id)
            conn.commit()
            _report("metin", counts, time.monotonic() - started)
            failed = failed or bool(counts.errors)

    if isinstance(client, JinaEmbeddingClient):
        waited = budget.waited if budget is not None else 0.0
        print(
            f"\n429: {client.rate_limited}  yeniden deneme: {client.retries}  "
            f"butce beklemesi: {waited:.1f} sn"
        )

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
