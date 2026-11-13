"""E4 degerlendirmesi: kontrol noktasi butunlugu (TUM satirlar) + yerel 0114 taslak tablosuna yukleme.

YALNIZ yerel, yalitilmis degerlendirme veritabaninda calisir (127.0.0.1). Uretime baglanmaz.

    python integrity_load.py --ckpt <ckpt-kopyasi> --db postgresql://arilla:...@127.0.0.1:55436/arilla \
        --out integrity.json [--load]

Denetimler:
- `verify --deep`: dosya boyutlari, SHA-256, sonlu degerler, norm, tek model, parca surekliligi
- tekrarlanan urun kimligi (parcalar arasi)
- ust veri: model, revizyon, havuzlama, boyut, metin surumu
- norm dagilimi (float16 yuvarlamasi sonrasi)
- HER satir: saklanan content_hash ve source_hash, yerel kopyadaki urun basligi/markasindan yeniden
  hesaplananla ayni mi (urun <-> vektor eslemesinin yapisal kaniti; yeniden gomme degil)
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2] / "services" / "ingest"))

from enrich.offline_embed import CheckpointStore
from enrich.product_text import build_product_text, content_hash, source_hash

DDL_0114 = """
CREATE TABLE IF NOT EXISTS product_text_embedding_d1024 (
    product_id    BIGINT        NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    model_version TEXT          NOT NULL CHECK (model_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    text_version  SMALLINT      NOT NULL CHECK (text_version > 0),
    content_hash  BYTEA         NOT NULL CHECK (octet_length(content_hash) = 16),
    source_hash   BYTEA         NOT NULL CHECK (octet_length(source_hash) = 16),
    embedding     halfvec(1024) NOT NULL,
    embedded_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, model_version)
);
ALTER TABLE product_text_embedding_d1024 ALTER COLUMN embedding SET STORAGE PLAIN;
CREATE INDEX IF NOT EXISTS product_text_embedding_d1024_hash_idx
    ON product_text_embedding_d1024 (model_version, content_hash);
ALTER TABLE embedding_index DROP CONSTRAINT IF EXISTS embedding_index_storage_table_check;
ALTER TABLE embedding_index ADD CONSTRAINT embedding_index_storage_table_check CHECK (
    storage_table IN ('product_text_embedding', 'product_text_embedding_d384',
                      'product_text_embedding_d1024'));
ALTER TABLE embedding_index DROP CONSTRAINT IF EXISTS embedding_index_table_dims;
ALTER TABLE embedding_index ADD CONSTRAINT embedding_index_table_dims CHECK (
    (storage_table = 'product_text_embedding' AND dimensions = 768)
    OR (storage_table = 'product_text_embedding_d384' AND dimensions = 384)
    OR (storage_table = 'product_text_embedding_d1024' AND dimensions = 1024));
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", type=Path, required=True)
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--load", action="store_true")
    args = ap.parse_args()
    if urlparse(args.db).hostname not in {"127.0.0.1", "localhost"}:
        print("yalniz yerel degerlendirme veritabani", file=sys.stderr)
        return 2
    import psycopg

    store = CheckpointStore(args.ckpt)
    report: dict = {"verify_deep": store.verify(deep=True, dimensions=1024)}
    parts = store.parts()
    metas = Counter(
        (
            p.meta["model"],
            p.meta["revision"],
            p.meta["pooling"],
            p.meta["dimensions"],
            p.meta["text_version"],
            p.meta["normalization"],
        )
        for p in parts
    )
    report["metadata_variants"] = [list(k) + [v] for k, v in metas.items()]
    report["fetched_total"] = sum(p.meta["fetched"] for p in parts)
    report["rejected_total"] = sum(len(p.meta["rejected_ids"]) for p in parts)
    report["skipped_empty_total"] = sum(p.meta["skipped_empty"] for p in parts)
    report["retries_total"] = sum(p.meta["retries"] for p in parts)

    rows: list[
        tuple[int, bytes, bytes, int, int]
    ] = []  # id, content, source, seq, index
    for p in parts:
        ids = store.path(p.seq, "ids").read_bytes()
        hashes = store.path(p.seq, "hash").read_bytes()
        for i in range(p.rows):
            rows.append(
                (
                    struct.unpack_from("<q", ids, i * 8)[0],
                    hashes[i * 32 : i * 32 + 16],
                    hashes[i * 32 + 16 : i * 32 + 32],
                    p.seq,
                    i,
                )
            )
    id_counts = Counter(r[0] for r in rows)
    report["rows"] = len(rows)
    report["unique_ids"] = len(id_counts)
    report["duplicate_ids"] = sum(1 for c in id_counts.values() if c > 1)

    norms: list[float] = []
    nonfinite = 0
    for p in parts:
        data = store.path(p.seq, "f16").read_bytes()
        for i in range(p.rows):
            v = struct.unpack_from("<1024e", data, i * 2048)
            if not all(math.isfinite(x) for x in v):
                nonfinite += 1
                continue
            norms.append(math.sqrt(sum(x * x for x in v)))
    norms.sort()
    report["nonfinite_vectors"] = nonfinite
    report["norm"] = {
        "min": round(norms[0], 6),
        "p50": round(norms[len(norms) // 2], 6),
        "max": round(norms[-1], 6),
        "max_abs_dev": round(max(abs(n - 1) for n in norms), 6),
    }

    with psycopg.connect(args.db, autocommit=True) as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT p.id, p.title, b.name, coalesce(split_part(c.path,'/',1),'(kategorisiz)'),"
            " p.category_id IS NULL FROM product p LEFT JOIN brand b ON b.id = p.brand_id"
            " LEFT JOIN category c ON c.id = p.category_id"
        )
        catalog = {int(r[0]): (r[1], r[2], r[3], r[4]) for r in cur.fetchall()}
        model = parts[0].meta["model"]
        content_ok = source_ok = missing = 0
        content_bad: list[int] = []
        roots: Counter = Counter()
        for pid, ch, sh, _seq, _i in rows:
            found = catalog.get(pid)
            if found is None:
                missing += 1
                continue
            title, brand, root, _ = found
            roots[root] += 1
            if content_hash(model, build_product_text(title, brand)) == ch:
                content_ok += 1
            else:
                content_bad.append(pid)
            if source_hash(title or "", brand) == sh:
                source_ok += 1
        report["hash_check"] = {
            "catalog_rows": len(catalog),
            "checkpoint_ids_missing_in_catalog": missing,
            "catalog_ids_not_in_checkpoint": len(set(catalog) - set(id_counts)),
            "content_hash_match": content_ok,
            "content_hash_mismatch": len(content_bad),
            "content_hash_mismatch_sample": content_bad[:20],
            "source_hash_match": source_ok,
        }
        report["root_category_distribution"] = dict(roots.most_common())

        if args.load:
            cur.execute(DDL_0114)
            cur.execute("TRUNCATE product_text_embedding_d1024")
            with cur.copy(
                "COPY product_text_embedding_d1024"
                " (product_id, model_version, text_version, content_hash, source_hash, embedding)"
                " FROM STDIN"
            ) as copy:
                for p in parts:
                    data = store.path(p.seq, "f16").read_bytes()
                    ids = store.path(p.seq, "ids").read_bytes()
                    hashes = store.path(p.seq, "hash").read_bytes()
                    for i in range(p.rows):
                        pid = struct.unpack_from("<q", ids, i * 8)[0]
                        if pid not in catalog:
                            continue
                        v = struct.unpack_from("<1024e", data, i * 2048)
                        literal = "[" + ",".join(repr(x) for x in v) + "]"
                        copy.write_row(
                            (
                                pid,
                                model,
                                p.meta["text_version"],
                                hashes[i * 32 : i * 32 + 16],
                                hashes[i * 32 + 16 : i * 32 + 32],
                                literal,
                            )
                        )
            cur.execute("ANALYZE product_text_embedding_d1024")
            cur.execute(
                "SELECT count(*), pg_size_pretty(pg_table_size('product_text_embedding_d1024')),"
                " max(pg_column_size(embedding)) FROM product_text_embedding_d1024"
            )
            n, size, colsize = cur.fetchone()
            cur.execute(
                "SELECT attstorage FROM pg_attribute WHERE attrelid ="
                " 'product_text_embedding_d1024'::regclass AND attname = 'embedding'"
            )
            report["loaded"] = {
                "rows": n,
                "table_size": size,
                "max_vector_bytes": colsize,
                "storage": cur.fetchone()[0],
            }
    args.out.write_text(
        json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(report, indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
