"""Urun metni veri kalitesi analizi: SALT OKUNUR, ornekleme ile (karar 0184, E2-C).

Soru: marka + baslik disinda embedding'e girebilecek veri (aciklama, teknik ozellik, kategori,
tanimlayici) katalogda ne kadar dolu ve ne kadar kullanilabilir?

    python -m enrich.quality --sample-percent 0.5 --max-rows 20000 --out rapor.md
    python -m enrich.quality --emit-sql > q.sql      # psql ile (or. uretim, salt okunur)
    python -m enrich.quality --render sonuc.jsonl --out rapor.md

Guvenlik ve maliyet:
- Islem `READ ONLY`; `statement_timeout` ve `lock_timeout` kisa. Hicbir sey yazmaz.
- Buyuk tablolar (`product`, `offer`) yalniz `TABLESAMPLE SYSTEM (p) REPEATABLE (seed)` +
  `LIMIT` ile okunur. Her sorgu once `EXPLAIN (FORMAT JSON)` ile planlanir; plan buyuk tabloda
  ornekleme disi tam tarama (Seq Scan) iceriyorsa ve tahmini satir sinirin ustundeyse sorgu
  CALISTIRILMAZ (rapor bunu yazar).
- Toplam satir sayilari `pg_class.reltuples` TAHMINIDIR (son ANALYZE); kesin sayim yapilmaz.

Sinirlar (rapora da yazilir): SYSTEM ornekleme blok duzeyindedir (ayni sayfadaki satirlar
birlikte gelir; yakin zamanda eklenen kayitlar kumelenebilir). Oranlar ornek icindir; tum
katalog icin kesin olcum DEGILDIR. Guven araligi basit binom yaklasimidir (Wilson %95).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

#: Plan bu tablolarda ornekleme disi Seq Scan iceriyorsa ve tahmini satir > sinir ise calismaz.
BIG_TABLES = frozenset({"product", "offer", "price_point", "click", "product_text_embedding"})
MAX_SEQ_SCAN_ROWS = 200_000
#: Saglayici/ingest'in kendi yazdigi, icerik olmayan anahtarlar (ozellik sayilmaz).
INTERNAL_KEYS = (
    "gtin",
    "gtin_source",
    "identifiers_checked_at",
    "stock_state",
    "variant_id",
    "mpn",
    "sku",
    "barcode",
)
#: Aciklama benzeri anahtar adlari (kucuk harfle eslesir).
DESCRIPTION_KEY_RE = (
    "(descr|aciklama|açıklama|detail|detay|body|content|icerik|içerik|summary|ozet|özet)"
)
#: Anlamsiz deger kaliplari (kucuk harf, kirpilmis).
JUNK_VALUE_RE = "^(-+|\\.+|0|null|none|yok|n/?a|belirtilmemi[sş]|diğer|diger|other|\\?+)$"


@dataclass(frozen=True)
class Query:
    name: str
    sql: str
    #: Sonuc tek satir tek JSON degeri dondurur.
    explain: bool = True


def _sample(table: str, alias: str, params: Mapping[str, Any]) -> str:
    return (
        f"{table} {alias} TABLESAMPLE SYSTEM ({float(params['sample_percent'])}) "
        f"REPEATABLE ({int(params['seed'])})"
    )


def queries(params: Mapping[str, Any]) -> list[Query]:
    """Sabit parametreli (yalniz sayi) sorgular; SQL'e kullanici metni girmez."""
    limit = int(params["max_rows"])
    product_sample = f"""
      WITH s AS MATERIALIZED (
        SELECT p.id, p.title, p.brand_id, p.category_id, p.gtin, p.mpn, p.model_key, p.color,
               p.attributes, p.primary_image_url, p.offer_count, p.foreign_offer_count,
               p.publication_state, p.source_offer_id
          FROM {_sample("product", "p", params)}
         LIMIT {limit}
      ), e AS (
        SELECT * FROM s
         WHERE publication_state = 'published' AND offer_count + foreign_offer_count > 0
      )"""
    internal = ", ".join(f"'{k}'" for k in INTERNAL_KEYS)
    return [
        Query(
            "estimates",
            """SELECT json_object_agg(relname, json_build_object(
                     'reltuples', reltuples::bigint,
                     'table_bytes', pg_relation_size(oid),
                     'total_bytes', pg_total_relation_size(oid)))
                 FROM pg_class
                WHERE relkind = 'r' AND relname IN ('product', 'offer', 'brand', 'category',
                      'product_text_embedding', 'generated_content')""",
            explain=False,
        ),
        Query(
            "product_fill",
            product_sample
            + f"""
      SELECT json_build_object(
        'sampled', (SELECT count(*) FROM s),
        'eligible', count(*),
        'title_len', json_build_object(
            'p10', percentile_cont(0.1) WITHIN GROUP (ORDER BY char_length(title)),
            'p50', percentile_cont(0.5) WITHIN GROUP (ORDER BY char_length(title)),
            'p90', percentile_cont(0.9) WITHIN GROUP (ORDER BY char_length(title)),
            'max', max(char_length(title))),
        'title_short_lt12', count(*) FILTER (WHERE char_length(btrim(title)) < 12),
        'title_no_letters', count(*) FILTER (WHERE title !~ '[[:alpha:]]'),
        'title_equals_brand', count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM brand b WHERE b.id = e.brand_id
               AND lower(btrim(b.name)) = lower(btrim(e.title)))),
        'brand', count(*) FILTER (WHERE brand_id IS NOT NULL),
        'category', count(*) FILTER (WHERE category_id IS NOT NULL),
        'gtin', count(*) FILTER (WHERE nullif(btrim(gtin), '') IS NOT NULL),
        'mpn', count(*) FILTER (WHERE nullif(btrim(mpn), '') IS NOT NULL),
        'model_key', count(*) FILTER (WHERE nullif(btrim(model_key), '') IS NOT NULL),
        'color', count(*) FILTER (WHERE nullif(btrim(color), '') IS NOT NULL),
        'image', count(*) FILTER (WHERE primary_image_url IS NOT NULL),
        'source_offer', count(*) FILTER (WHERE source_offer_id IS NOT NULL),
        'attributes_any', count(*) FILTER (WHERE attributes <> '{{}}'::jsonb),
        'attributes_content', count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM jsonb_each_text(e.attributes) kv
             WHERE kv.key NOT IN ({internal}) AND btrim(kv.value) <> ''
               AND lower(btrim(kv.value)) !~ '{JUNK_VALUE_RE}')),
        'attributes_text_len', json_build_object(
            'p50', percentile_cont(0.5) WITHIN GROUP (ORDER BY char_length(attributes::text)),
            'p90', percentile_cont(0.9) WITHIN GROUP (ORDER BY char_length(attributes::text))),
        'offers', json_build_object(
            'p50', percentile_cont(0.5) WITHIN GROUP (ORDER BY offer_count + foreign_offer_count),
            'p90', percentile_cont(0.9) WITHIN GROUP (ORDER BY offer_count + foreign_offer_count),
            'single', count(*) FILTER (WHERE offer_count + foreign_offer_count = 1)),
        'duplicate_titles', (SELECT coalesce(sum(n - 1), 0) FROM (
            SELECT count(*) AS n FROM e GROUP BY lower(regexp_replace(title, '\\s+', ' ', 'g'))
            HAVING count(*) > 1) d),
        'ai_description', (SELECT count(*) FROM generated_content g
            WHERE g.target_type = 'product' AND g.kind = 'description'
              AND g.target_id IN (SELECT id FROM e))
      ) FROM e""",
        ),
        Query(
            "product_attribute_keys",
            product_sample
            + f"""
      SELECT coalesce(json_agg(k ORDER BY k.products DESC), '[]'::json) FROM (
        SELECT kv.key, count(DISTINCT e.id) AS products,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY char_length(kv.value)) AS len_p50,
               count(*) FILTER (WHERE lower(btrim(kv.value)) ~ '{JUNK_VALUE_RE}') AS junk
          FROM e, jsonb_each_text(e.attributes) kv
         GROUP BY kv.key ORDER BY count(DISTINCT e.id) DESC LIMIT 25) k""",
        ),
        Query(
            "offer_attribute_keys",
            f"""
      WITH s AS MATERIALIZED (
        SELECT o.id, o.attributes_raw, o.category_raw, o.brand_raw
          FROM {_sample("offer", "o", params)}
         WHERE o.is_active
         LIMIT {limit}
      )
      SELECT json_build_object(
        'sampled', (SELECT count(*) FROM s),
        'category_raw', (SELECT count(*) FROM s WHERE nullif(btrim(category_raw), '') IS NOT NULL),
        'brand_raw', (SELECT count(*) FROM s WHERE nullif(btrim(brand_raw), '') IS NOT NULL),
        'with_content_key', (SELECT count(*) FROM s WHERE EXISTS (
            SELECT 1 FROM jsonb_each_text(s.attributes_raw) kv
             WHERE kv.key NOT IN ({internal}) AND btrim(kv.value) <> '')),
        'with_description_key', (SELECT count(*) FROM s WHERE EXISTS (
            SELECT 1 FROM jsonb_object_keys(s.attributes_raw) k
             WHERE lower(k) ~ '{DESCRIPTION_KEY_RE}')),
        'keys', (SELECT coalesce(json_agg(k ORDER BY k.offers DESC), '[]'::json) FROM (
            SELECT kv.key, count(*) AS offers,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY char_length(kv.value)) AS len_p50,
                   max(char_length(kv.value)) AS len_max,
                   count(*) FILTER (WHERE lower(btrim(kv.value)) ~ '{JUNK_VALUE_RE}') AS junk
              FROM s, jsonb_each_text(s.attributes_raw) kv
             GROUP BY kv.key ORDER BY count(*) DESC LIMIT 30) k)
      )""",
        ),
        Query(
            "product_vs_source_offer",
            product_sample
            + """
      SELECT json_build_object(
        'pairs', count(*),
        'title_equal', count(*) FILTER (WHERE btrim(e.title) = btrim(o.title_raw)),
        'title_equal_ci', count(*) FILTER (
            WHERE lower(regexp_replace(e.title, '\\s+', ' ', 'g'))
                = lower(regexp_replace(o.title_raw, '\\s+', ' ', 'g'))),
        'offer_title_longer', count(*) FILTER (
            WHERE char_length(o.title_raw) > char_length(e.title) + 5),
        'offer_brand_raw', count(*) FILTER (WHERE nullif(btrim(o.brand_raw), '') IS NOT NULL),
        'product_brand_missing_offer_has', count(*) FILTER (
            WHERE e.brand_id IS NULL AND nullif(btrim(o.brand_raw), '') IS NOT NULL),
        'offer_category_raw', count(*) FILTER (WHERE nullif(btrim(o.category_raw), '') IS NOT NULL),
        'product_category_missing_offer_has', count(*) FILTER (
            WHERE e.category_id IS NULL AND nullif(btrim(o.category_raw), '') IS NOT NULL),
        'offer_attrs_more_keys', count(*) FILTER (WHERE (
            SELECT count(*) FROM jsonb_object_keys(o.attributes_raw)) > (
            SELECT count(*) FROM jsonb_object_keys(e.attributes)))
      ) FROM e JOIN offer o ON o.id = e.source_offer_id""",
        ),
    ]


def plan_problem(plan: Any) -> str | None:
    """EXPLAIN (FORMAT JSON) -> buyuk tabloda ornekleme disi buyuk Seq Scan varsa aciklama."""
    found: list[str] = []

    def walk(node: Mapping[str, Any]) -> None:
        if node.get("Node Type") == "Seq Scan" and node.get("Relation Name") in BIG_TABLES:
            rows = float(node.get("Plan Rows") or 0)
            if rows > MAX_SEQ_SCAN_ROWS:
                found.append(f"{node['Relation Name']} Seq Scan ~{int(rows)} satir")
        for child in node.get("Plans") or []:
            walk(child)

    root = plan[0]["Plan"] if isinstance(plan, list) else plan["Plan"]
    walk(root)
    return "; ".join(found) or None


def plan_summary(plan: Any) -> dict[str, Any]:
    root = plan[0]["Plan"] if isinstance(plan, list) else plan["Plan"]
    nodes: list[str] = []

    def walk(node: Mapping[str, Any]) -> None:
        if node.get("Relation Name"):
            nodes.append(f"{node['Node Type']}({node['Relation Name']})")
        for child in node.get("Plans") or []:
            walk(child)

    walk(root)
    return {"total_cost": root.get("Total Cost"), "scans": sorted(set(nodes))}


def run(conn: Any, params: Mapping[str, Any]) -> dict[str, Any]:
    """Tek READ ONLY islemde tum sorgular. Plan reddi o sorguyu atlar, digerleri calisir."""
    results: dict[str, Any] = {"params": dict(params), "plans": {}, "skipped": {}}
    results["measured_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("SET TRANSACTION READ ONLY")
        cur.execute(f"SET LOCAL statement_timeout = {int(params['statement_timeout_ms'])}")
        cur.execute("SET LOCAL lock_timeout = 1000")
        for query in queries(params):
            if query.explain:
                cur.execute("EXPLAIN (FORMAT JSON) " + query.sql)
                plan = cur.fetchone()[0]
                results["plans"][query.name] = plan_summary(plan)
                problem = plan_problem(plan)
                if problem:
                    results["skipped"][query.name] = problem
                    continue
            cur.execute(query.sql)
            results[query.name] = cur.fetchone()[0]
    return results


def emit_sql(params: Mapping[str, Any]) -> str:
    """psql icin betik: once planlar, sonra her sorgu tek satir JSON (`--render` okur).

    Plan kapisi burada psql'de UYGULANAMAZ; betik yalniz ornekleme sorgularini icerir ve
    EXPLAIN ciktilarini da ayni dosyaya yazar ki `--render` ayni kontrolu sonradan yapsin.
    """
    lines = [
        "\\set QUIET on",
        "\\set ON_ERROR_STOP on",
        "\\pset format unaligned",
        "\\pset tuples_only on",
        "BEGIN READ ONLY;",
        f"SET LOCAL statement_timeout = {int(params['statement_timeout_ms'])};",
        "SET LOCAL lock_timeout = 1000;",
        f"SELECT json_build_object('params', '{json.dumps(dict(params))}'::json, "
        "'measured_at', now());",
    ]
    for query in queries(params):
        sql = " ".join(query.sql.split())
        if query.explain:
            lines.append(f"EXPLAIN (FORMAT JSON) {sql};")
        lines.append(f"SELECT json_build_object('name', '{query.name}', 'value', ({sql}));")
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


def parse_psql_output(text: str) -> dict[str, Any]:
    """`--emit-sql` ciktisi -> `run` ile ayni sozluk. EXPLAIN bloklari sirayla eslenir."""
    results: dict[str, Any] = {"plans": {}, "skipped": {}}
    names = [q.name for q in queries({"sample_percent": 1, "seed": 1, "max_rows": 1}) if q.explain]
    plans: list[Any] = []
    buffer = ""
    for line in text.splitlines():
        if not line.strip():
            continue
        # psql komut etiketleri (BEGIN, SET, COMMIT) ve bilgi satirlari JSON degildir; yalniz
        # `{` ya da `[` ile baslayan satir yeni bir deger baslatir.
        if not buffer and not line.lstrip().startswith(("{", "[")):
            continue
        buffer += line
        try:
            value = json.loads(buffer)
        except json.JSONDecodeError:
            continue
        buffer = ""
        if isinstance(value, list):
            plans.append(value)
        elif isinstance(value, dict) and "name" in value:
            results[value["name"]] = value["value"]
        elif isinstance(value, dict) and "params" in value:
            results["params"] = value["params"]
            results["measured_at"] = value["measured_at"]
    for name, plan in zip(names, plans, strict=False):
        results["plans"][name] = plan_summary(plan)
        problem = plan_problem(plan)
        if problem:
            results["skipped"][name] = problem
            results.pop(name, None)
    return results


# --- rapor ------------------------------------------------------------------------------


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def pct(k: int | None, n: int | None) -> str:
    if not n or k is None:
        return "-"
    low, high = wilson(int(k), int(n))
    return f"%{100 * k / n:.1f} (%95 GA %{100 * low:.1f}–{100 * high:.1f}; {k}/{n})"


def _rows(items: Iterable[tuple[str, str]]) -> list[str]:
    return [f"| {a} | {b} |" for a, b in items]


def render_markdown(results: Mapping[str, Any], *, source: str) -> str:
    params = results.get("params", {})
    est = results.get("estimates") or {}
    fill = results.get("product_fill") or {}
    offers = results.get("offer_attribute_keys") or {}
    pairs = results.get("product_vs_source_offer") or {}
    n = fill.get("eligible")
    lines = [
        "# E2-C urun metni veri kalitesi olcumu",
        "",
        f"- Olcum zamani (UTC): {results.get('measured_at', '-')}",
        f"- Kaynak: {source}",
        f"- Yontem: `TABLESAMPLE SYSTEM ({params.get('sample_percent')}%) REPEATABLE "
        f"({params.get('seed')})`, ust sinir {params.get('max_rows')} satir; READ ONLY islem, "
        f"statement_timeout {params.get('statement_timeout_ms')} ms.",
        "- Oranlar ORNEK icindir; tum katalog icin kesin degildir. Toplamlar `reltuples` tahmini.",
        "",
        "## Katalog buyuklugu (tahmini)",
        "",
        "| Tablo | Satir (reltuples) | Tablo boyutu |",
        "|---|---|---|",
    ]
    for name, value in sorted(est.items()):
        lines.append(f"| {name} | {value['reltuples']:,} | {value['table_bytes'] / 1e9:.2f} GB |")
    lines += [
        "",
        "## Urun ornegi: doluluk (uygun = yayinda ve teklifli)",
        "",
        f"Ornek: {fill.get('sampled', '-')} urun, uygun: {pct(n, fill.get('sampled'))}",
        "",
        "| Alan | Dolu (uygun urunler icinde) |",
        "|---|---|",
    ]
    lines += _rows(
        (label, pct(fill.get(key), n))
        for label, key in (
            ("Marka (brand_id)", "brand"),
            ("Kategori (category_id)", "category"),
            ("GTIN", "gtin"),
            ("MPN", "mpn"),
            ("model_key", "model_key"),
            ("Renk", "color"),
            ("Gorsel", "image"),
            ("Kaynak teklif (source_offer_id)", "source_offer"),
            ("attributes bos degil", "attributes_any"),
            ("attributes anlamli icerik (ic anahtar/anlamsiz deger haric)", "attributes_content"),
            ("AI aciklamasi (generated_content.description)", "ai_description"),
        )
    )
    title_len = fill.get("title_len") or {}
    lines += [
        "",
        "Baslik uzunlugu (karakter): "
        + ", ".join(f"{k} {v:g}" for k, v in title_len.items() if v is not None),
        "",
        "| Sorunlu icerik | Oran |",
        "|---|---|",
    ]
    lines += _rows(
        (label, pct(fill.get(key), n))
        for label, key in (
            ("Baslik < 12 karakter", "title_short_lt12"),
            ("Baslikta harf yok", "title_no_letters"),
            ("Baslik = marka adi", "title_equals_brand"),
            ("Ornek icinde tekrar eden baslik (fazlalik)", "duplicate_titles"),
            ("Tek teklifli urun", None),
        )
        if key
    )
    off = fill.get("offers") or {}
    lines.append(f"| Tek teklifli urun | {pct(off.get('single'), n)} |")
    lines += [
        "",
        "## Teklif ornegi: `attributes_raw` (aciklama/ozellik adaylari)",
        "",
        f"Ornek: {offers.get('sampled', '-')} aktif teklif.",
        "",
        "| Olcut | Oran |",
        "|---|---|",
    ]
    m = offers.get("sampled")
    lines += _rows(
        (label, pct(offers.get(key), m))
        for label, key in (
            ("category_raw dolu", "category_raw"),
            ("brand_raw dolu", "brand_raw"),
            ("Ic anahtar disinda en az bir icerik anahtari", "with_content_key"),
            ("Aciklama benzeri anahtar (descr/aciklama/detay/...)", "with_description_key"),
        )
    )
    keys = offers.get("keys") or []
    if keys:
        lines += [
            "",
            "| Anahtar | Teklif | Uzunluk p50 | Uzunluk max | Anlamsiz deger |",
            "|---|---|---|---|---|",
        ]
        for k in keys[:20]:
            cells = (f"`{k['key']}`", k["offers"], f"{k['len_p50']:g}", k["len_max"], k["junk"])
            lines.append("| " + " | ".join(str(c) for c in cells) + " |")
    lines += [
        "",
        "## Urun - kaynak teklif farklari",
        "",
        f"Eslesen cift: {pairs.get('pairs', '-')}",
        "",
        "| Olcut | Oran |",
        "|---|---|",
    ]
    p = pairs.get("pairs")
    lines += _rows(
        (label, pct(pairs.get(key), p))
        for label, key in (
            ("Baslik birebir ayni", "title_equal"),
            ("Baslik ayni (buyuk/kucuk, bosluk haric)", "title_equal_ci"),
            ("Teklif basligi belirgin uzun (+5 karakter)", "offer_title_longer"),
            ("Teklifte brand_raw var", "offer_brand_raw"),
            ("Urunde marka yok, teklifte var", "product_brand_missing_offer_has"),
            ("Teklifte category_raw var", "offer_category_raw"),
            ("Urunde kategori yok, teklifte var", "product_category_missing_offer_has"),
            ("Teklifin ozellik anahtari urundekinden fazla", "offer_attrs_more_keys"),
        )
    )
    lines += [
        "",
        "## Plan denetimi (EXPLAIN)",
        "",
        "| Sorgu | Tahmini maliyet | Taramalar |",
        "|---|---|---|",
    ]
    for name, plan in (results.get("plans") or {}).items():
        lines.append(f"| {name} | {plan['total_cost']} | {', '.join(plan['scans'])} |")
    for name, reason in (results.get("skipped") or {}).items():
        lines.append(f"| {name} | CALISTIRILMADI | {reason} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m enrich.quality", description=__doc__.split("\n")[0]
    )
    parser.add_argument("--sample-percent", type=float, default=0.5)
    parser.add_argument("--seed", type=int, default=183)
    parser.add_argument("--max-rows", type=int, default=20_000)
    parser.add_argument("--statement-timeout-ms", type=int, default=60_000)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--source", default="DATABASE_URL")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--emit-sql", action="store_true")
    mode.add_argument("--render", type=Path, help="--emit-sql betiginin psql ciktisi")
    args = parser.parse_args(argv)
    if not 0 < args.sample_percent <= 10 or not 100 <= args.max_rows <= 200_000:
        print("HATA: 0 < --sample-percent <= 10, 100 <= --max-rows <= 200000", file=sys.stderr)
        return 2
    params = {
        "sample_percent": args.sample_percent,
        "seed": args.seed,
        "max_rows": args.max_rows,
        "statement_timeout_ms": args.statement_timeout_ms,
    }
    if args.emit_sql:
        # psql UTF-8 bekler; Windows konsol kodlamasi (cp1254) Turkce desenleri bozardi.
        sys.stdout.buffer.write(emit_sql(params).encode("utf-8"))
        return 0
    if args.render:
        results = parse_psql_output(args.render.read_text(encoding="utf-8"))
    else:
        from db.connection import connect

        with connect() as conn:
            results = run(conn, params)
    report = render_markdown(results, source=args.source)
    if args.out:
        args.out.write_text(report, encoding="utf-8")
        args.out.with_suffix(".json").write_text(
            json.dumps(results, ensure_ascii=False, indent=1, default=str), encoding="utf-8"
        )
        print(f"yazildi: {args.out}")
    else:
        sys.stdout.write(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
