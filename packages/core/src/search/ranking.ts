/**
 * `search()`'in "Bizim seçtiklerimiz" sekmesi icin paylasilan skor
 * ifadeleri (docs/search.md, "Sıralama"). Dahili detay - `index.ts`'ten
 * disa acilmaz.
 *
 * Sabitler docs/search.md'de sayi olarak verilmez; `clarification.ts`'teki
 * esik sabitleriyle ayni desen: ayarlanabilir placeholder olarak belgelenir.
 */
import { type SQL, sql } from "drizzle-orm";

/**
 * Ham `sql` sablonuna dogrudan interpolе edilen bir JS dizisi, drizzle
 * tarafindan `(a, b, c)` seklinde ayri parametrelere bolunur - `= ANY(...)`
 * ile tek bir dizi parametresi olarak baglamak icin `sql.param()` kullanmak
 * gerekir (aksi halde `::text[]` cast'i tek bir skaler degere uygulanmis
 * olur ve "malformed array literal" hatasi verir).
 */
export function arrayParam<T>(value: readonly T[] | null) {
  return sql.param(value);
}

/** Stokta olmayan urunun aldigi ceza carpani. */
export const OUT_OF_STOCK_PENALTY = 0.3;

/** `product_price_stats` satiri henuz yoksa (B5 calismamis) notr varsayilan. */
export const MISSING_PERCENTILE_FALLBACK = 50;

/**
 * "Bizim seçtiklerimiz" skorunun dört çarpanı. Skor bunların çarpımıdır
 * (`balancedScoreExpr`); yönetim arama tanısı aynı ifadeleri ayrı kolon
 * olarak okur, formül ikinci bir yerde yazılmaz.
 */
export interface BalancedScoreFactors {
  /** Metin alakası (`tm.rel`, metin yoksa 1.0). */
  relevance: SQL;
  /** Mağaza güveni / 100. */
  trust: SQL;
  /** Stokta 1.0, değilse `OUT_OF_STOCK_PENALTY`. */
  stock: SQL;
  /** 1 - fiyat yüzdeliği / 100 (yüzdelik yoksa `MISSING_PERCENTILE_FALLBACK`). */
  price: SQL;
}

export function balancedScoreFactors(
  relevance: SQL,
  trustScore: SQL,
  inStock: SQL,
  currentPercentile: SQL,
): BalancedScoreFactors {
  return {
    relevance: sql`${relevance}`,
    trust: sql`(${trustScore}::numeric / 100.0)`,
    stock: sql`(CASE WHEN ${inStock} THEN 1.0 ELSE ${OUT_OF_STOCK_PENALTY} END)`,
    price: sql`(1 - COALESCE(${currentPercentile}, ${MISSING_PERCENTILE_FALLBACK})::numeric / 100.0)`,
  };
}

/**
 * Sonuc `::double precision`e cast edilir: aksi halde Postgres'in `numeric`
 * ciktisi node-postgres tarafindan (hassasiyet kaybini onlemek icin) JS
 * string'i olarak donuyor - biz burada tam JS number istiyoruz.
 */
export function balancedScoreExpr(
  relevance: SQL,
  trustScore: SQL,
  inStock: SQL,
  currentPercentile: SQL,
): SQL {
  const f = balancedScoreFactors(relevance, trustScore, inStock, currentPercentile);
  return sql`(
    (
      ${f.relevance}
      * ${f.trust}
      * ${f.stock}
      * ${f.price}
    )::double precision
  )`;
}
