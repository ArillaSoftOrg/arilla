"""CPU embedding pilotu: kaynak tuketimini OLCER, hicbir sey YAZMAZ (karar 0180, 0186).

    python -m enrich.pilot --model e5-small-int8-0bcc8ca76950 --model-dir DIR --texts-file F
    python -m enrich.pilot --model e5-small-int8-0bcc8ca76950 --model-dir DIR --from-db --limit 500
    EMBED_QWEN3_06B_URL=http://embed-cpu:8080 python -m enrich.pilot
        --model qwen3-embedding-0.6b-97b0c614 --texts-file F --batch-size 32

Cikti tek JSON nesnesidir: parti gecikmesi p50/p95, metin/sn, tepe RSS, metin uzunlugu ve
modelin token sinirini asan (kesilecek) metin orani. Metinlerin kendisi ciktiya girmez.

Sinirlar:
- Veritabanina YAZMAZ, `api_usage`/`job_run` birakmaz; Jina ya da baska ag cagrisi yapmaz.
- `--from-db` yalnizca yerel veritabaniyla (localhost/127.0.0.1) calisir; uretim reddedilir.
- Yalniz kendi calistirdigimiz modeller (`local_onnx`, `remote_http`); Jina (ucretli API) olculmez.
  `disabled` modeller de olculebilir: pilot yazmaz (E3 karsilastirmasi icin, karar 0186).
- `remote_http`: `peak_rss_mb` ISTEMCI surecidir; sunucu bellegi `docker stats` ile olculur.
  Sonuca altin vektor kanaryasinin olcumu (`canary_min_cosine`) eklenir; kanaryasi gecmeyen
  modelin hiz sayisi anlamsizdir (yanlis vektor uretiyor olabilir).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from enrich.product_text import build_product_text
from enrich.products import latency_detail
from enrich.providers import EmbeddingError, build_text_provider
from enrich.registry import RegistryError, registry
from enrich.text_prep import ProductFields, estimate_counter, prepare_product_text

SAMPLE_SQL = """
SELECT p.title, b.name, p.mpn, p.attributes
  FROM product p
  LEFT JOIN brand b ON b.id = p.brand_id
 WHERE p.publication_state = 'published'
 ORDER BY p.id
 LIMIT %(limit)s
"""


def is_local_url(url: str) -> bool:
    from urllib.parse import urlparse

    return (urlparse(url).hostname or "").lower() in {"localhost", "127.0.0.1", "::1"}


def read_texts(path: Path, limit: int) -> list[str]:
    lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines()]
    return [line for line in lines if line][:limit]


def texts_from_db(limit: int, text_version: int, chars_per_token: float, max_tokens: int):
    from db.connection import connect, database_url

    if not is_local_url(database_url("DATABASE_URL")):
        raise SystemExit("HATA: --from-db yalnizca yerel veritabaniyla calisir")
    count = estimate_counter(chars_per_token)
    texts: list[str] = []
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SET TRANSACTION READ ONLY")
        cur.execute(SAMPLE_SQL, {"limit": limit})
        for title, brand, mpn, attributes in cur.fetchall():
            if text_version == 1:
                text = build_product_text(title, brand)
            else:
                fields = ProductFields(title=title, brand=brand, model=mpn, attributes=attributes)
                text = prepare_product_text(
                    fields, model="pilot", max_tokens=max_tokens, count=count
                ).text
            if text:
                texts.append(text)
        conn.rollback()
    return texts


def peak_rss_mb() -> float | None:
    try:
        import psutil
    except ImportError:
        return None
    info = psutil.Process().memory_info()
    peak = getattr(info, "peak_wset", None) or info.rss  # Windows: peak_wset
    return round(peak / (1 << 20), 1)


def measure(provider: Any, texts: list[str], max_tokens: int) -> dict[str, Any]:
    started = time.perf_counter()
    batch_size = provider.text_batch_size
    errors = 0
    for start in range(0, len(texts), batch_size):
        try:
            provider.embed_texts(texts[start : start + batch_size])
        except EmbeddingError:
            errors += 1
    elapsed = time.perf_counter() - started
    lengths = sorted(len(t) for t in texts)
    over = sum(1 for t in texts if len(t) / provider.spec.chars_per_token > max_tokens)
    return {
        "model": provider.spec.id,
        "texts": len(texts),
        "batch_size": batch_size,
        "failed_batches": errors,
        "seconds": round(elapsed, 2),
        "texts_per_s_wall": round(len(texts) / elapsed, 1) if elapsed > 0 else None,
        **latency_detail(provider.latencies_ms, len(texts) - errors * batch_size),
        "peak_rss_mb": peak_rss_mb(),
        "chars_p50": lengths[len(lengths) // 2] if lengths else 0,
        "chars_max": lengths[-1] if lengths else 0,
        "over_token_limit_ratio": round(over / len(texts), 3) if texts else 0.0,
        "max_input_tokens": max_tokens,
    }


def _canary_min(spec: Any, args: argparse.Namespace) -> float | None:
    """Altin vektor olcumu (esiksiz). Altin dosya yoksa None; hata sonucu bozmaz."""
    from enrich.canary import CanaryFailed, compare, load_golden

    try:
        golden = load_golden(spec.id)
        result = compare(
            spec,
            golden,
            lambda purpose: build_text_provider(
                spec, purpose=purpose, model_dir=args.model_dir, threads=args.threads
            ),
            threshold=None,
        )
    except CanaryFailed:
        return None
    low = result.min_cosine
    return None if result.problems or low is None else round(low, 6)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="enrich.pilot", description="Yerel embedding pilotu")
    parser.add_argument(
        "--model", required=True, help="kayit defteri kimligi (local_onnx | remote_http)"
    )
    parser.add_argument("--model-dir", type=Path, help="local_onnx icin zorunlu")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--texts-file", type=Path, help="satir basina bir metin")
    source.add_argument("--from-db", action="store_true", help="yalniz YEREL veritabani")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--text-version", type=int, choices=(1, 2), default=1)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--batch-size", type=int, default=64)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.limit < 1 or args.threads < 1 or args.batch_size < 1:
        print("HATA: --limit, --threads, --batch-size pozitif olmali", file=sys.stderr)
        return 2
    try:
        # Pilot YAZMAZ: devre disi modeller de olculebilir (secim kurali uretim yazimi icindir).
        spec = registry().get(args.model)
        if "product_text" not in spec.roles:
            raise RegistryError(f"{spec.id}: product_text rolu yok")
    except RegistryError as error:
        print(f"HATA: {error}", file=sys.stderr)
        return 2
    if not spec.self_hosted:
        print("HATA: pilot yalniz kendi calistirilan modelleri olcer; API yok", file=sys.stderr)
        return 2
    if spec.provider == "local_onnx" and args.model_dir is None:
        print("HATA: local_onnx icin --model-dir gerekli", file=sys.stderr)
        return 2
    try:
        provider = build_text_provider(
            spec,
            purpose="passage",
            batch_size=args.batch_size,
            model_dir=args.model_dir,
            threads=args.threads,
        )
    except (RegistryError, RuntimeError, ImportError) as error:
        print(f"HATA: model yuklenemedi: {error}", file=sys.stderr)
        return 2
    if args.texts_file is not None:
        texts = read_texts(args.texts_file, args.limit)
    else:
        texts = texts_from_db(
            args.limit, args.text_version, spec.chars_per_token, spec.max_input_tokens
        )
    if not texts:
        print("HATA: olculecek metin yok", file=sys.stderr)
        return 2
    result = measure(provider, texts, spec.max_input_tokens)
    result.update(threads=args.threads, text_version=args.text_version, provider=spec.provider)
    result["canary_min_cosine"] = _canary_min(spec, args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["failed_batches"] else 0


if __name__ == "__main__":
    sys.exit(main())
