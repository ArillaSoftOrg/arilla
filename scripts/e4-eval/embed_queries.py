"""Sorgu vektorleri + sorgu gomme gecikmesi (E4 degerlendirmesi). Uretim TEI'sine (internal ag)
TEK sorgu = TEK istek gonderir; urun yolu ile ayni model/revizyon/havuzlama, amac `query`.

    python embed_queries.py queries.tsv out.json [--repeat 3]

Yazdigi tek sey cikti dosyasidir; veritabanina baglanmaz.
"""

from __future__ import annotations

import csv
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(os.environ.get("INGEST_DIR", ".")).resolve()))

from enrich.canary import require_canary
from enrich.providers import RemoteHttpTextProvider
from enrich.registry import registry

MODEL = "bge-m3-5617a9f6"


def main() -> int:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    repeat = (
        int(sys.argv[sys.argv.index("--repeat") + 1]) if "--repeat" in sys.argv else 3
    )
    spec = registry().get(MODEL)
    url = os.environ[spec.endpoint["url_env"]]  # type: ignore[index]

    def factory(purpose: str) -> RemoteHttpTextProvider:
        return RemoteHttpTextProvider(
            spec=spec, base_url=url, purpose=purpose, batch_size=32
        )

    canary = require_canary(spec, factory)
    provider = RemoteHttpTextProvider(
        spec=spec, base_url=url, purpose="query", batch_size=1
    )
    rows = list(csv.DictReader(src.open(encoding="utf-8"), delimiter="\t"))
    vectors: dict[str, list[float]] = {}
    latencies: list[float] = []
    for round_ in range(repeat):
        for row in rows:
            started = time.perf_counter()
            batch = provider.embed_texts([row["query"]])
            latencies.append((time.perf_counter() - started) * 1000)
            if round_ == 0:
                vectors[row["id"]] = [round(v, 7) for v in batch.vectors[0]]
    latencies.sort()

    def pct(q: float) -> float:
        return round(latencies[min(len(latencies) - 1, int(q * len(latencies)))], 1)

    out = {
        "model": spec.id,
        "revision": spec.source.get("revision"),
        "pooling": spec.pooling,
        "purpose": "query",
        "canary_min_cosine": min(c[2] for c in canary.cosines),
        "latency_ms": {
            "n": len(latencies),
            "p50": pct(0.5),
            "p95": pct(0.95),
            "max": latencies[-1],
        },
        "vectors": vectors,
    }
    dst.write_text(json.dumps(out), encoding="utf-8")
    print(json.dumps({k: v for k, v in out.items() if k != "vectors"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
