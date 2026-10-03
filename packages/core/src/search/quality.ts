/**
 * Arama kalitesi günlük özeti (`search_query_day`, migration 0040, kararlar
 * 0052 ve 0054). Olay tablosu DEĞİL ve analitik olayı DEĞİL
 * (docs/events.md): (gün, normalize sorgu) başına tek satır, sayaçlar artar.
 * Kimlik yok — kullanıcı, oturum, IP, çerez yazılmaz; rızadan bağımsızdır
 * çünkü kişiyle ilişkilendirilemez.
 *
 * Kişisel veri süzgeci (`isRecordableQuery`): e-posta, telefon, adres, URL ya
 * da 7+ haneli rakam dizisi içeren veya 200 karakteri aşan sorgu HİÇ yazılmaz.
 *
 * Gün sınırı Europe/Istanbul (UTC+3, yaz saati yok): yönetim ekranı "dün"ü
 * Türkiye takvimiyle okur; gece yarısı UTC'de bölünen bir gün kafa karıştırır.
 *
 * Arızaya dayanıklı: `/ara`'yı asla bozmaz, asla fırlatmaz; hata yalnızca
 * sınıfıyla loglanır, sorgu metni loglara girmez.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { findLexiconMatches, type LexiconEntry } from "./lexicon.ts";
import { loadLexicon } from "./lexicon-repository.ts";
import { normalizeQueryText, tokenizeWithOffsets } from "./normalize.ts";
import { parseQueryText } from "./parse-query.ts";

export const SEARCH_QUALITY_QUERY_MAX = 200;
export const SEARCH_QUALITY_TERMS_MAX = 8;
export const SEARCH_QUALITY_TERM_LENGTH_MAX = 40;
export const SEARCH_QUALITY_RETENTION_DAYS = 90;
export const SEARCH_QUALITY_TIME_ZONE = "Europe/Istanbul";

const EMAIL_LIKE = /@/u;
const URL_LIKE =
  /(?:https?:\/\/|www\.|\b[\p{L}\p{N}-]+\.(?:com|net|org|tr|io|co|app|dev|me|info|biz|shop|store|xyz)\b)/iu;
const LONG_DIGITS = /\d{7,}/u;
/** 3/4 + 3 + 2 + 2 hane, tek ayraçlı (0532 123 45 67, (212) 555-12-34, +90 532 ...). */
const PHONE_LIKE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3,4}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}/u;
/** Açık adres işaretleri. "no: 12" de adres kalıbıdır. */
const ADDRESS_LIKE =
  /(?:^|[^\p{L}])(?:mahalle|mahallesi|mah\.|sokak|sokağı|sk\.|cadde|caddesi|cad\.|bulvarı|apartmanı|apt\.|posta kodu|no\s*:\s*\d)(?=$|[^\p{L}])/u;

/**
 * Sorgu bu tabloya yazılabilir mi. Yanlış pozitif kabul edilebilir (bir
 * sorgu sayılmaz); yanlış negatif kabul edilemez (kişisel veri yazılır).
 */
export function isRecordableQuery(queryNorm: string): boolean {
  if (typeof queryNorm !== "string") return false;
  if (queryNorm.length === 0 || queryNorm.length > SEARCH_QUALITY_QUERY_MAX) return false;
  if (EMAIL_LIKE.test(queryNorm)) return false;
  if (URL_LIKE.test(queryNorm)) return false;
  if (LONG_DIGITS.test(queryNorm)) return false;
  if (PHONE_LIKE.test(queryNorm)) return false;
  if (ADDRESS_LIKE.test(queryNorm)) return false;
  return true;
}

/**
 * Alışveriş sorgusunda anlam taşımayan bağlaç/ek kelimeler ve fiyat
 * kalıbının parçaları. "Tanınmayan kelime" listesine girmez.
 */
const STOPWORDS = new Set([
  "ve",
  "ile",
  "için",
  "icin",
  "bir",
  "en",
  "çok",
  "cok",
  "da",
  "de",
  "ki",
  "mi",
  "mı",
  "ya",
  "veya",
  "gibi",
  "tarzı",
  "tarzi",
  "olan",
  "olsun",
  "olmasın",
  "olmasin",
  "olmayan",
  "hariç",
  "haric",
  "değil",
  "degil",
  "dışında",
  "disinda",
  "altı",
  "alti",
  "altında",
  "altinda",
  "üstü",
  "ustu",
  "üstünde",
  "ustunde",
  "üzeri",
  "uzeri",
  "arası",
  "arasi",
  "kadar",
  "max",
  "min",
  "tl",
  "lira",
  "₺",
  "numara",
  "beden",
  "adet",
  "her",
  "the",
  "and",
  "for",
  "with",
]);

/** Rakam ya da kısa birimli rakam ("42", "100ml", "2.5kg"). */
const NUMBER_LIKE = /^\d+(?:[.,]\d+)?[\p{L}]{0,3}$/u;

/**
 * Sorgunun sözlükte karşılığı olmayan kelimeleri: ayrıştırıcının fiyat,
 * beden, renk, kategori, marka olarak tükettikleri ve herhangi bir sözlük
 * yüzeyine (eşanlamlı, malzeme, stil dahil) denk gelenler çıkar; bağlaç ve
 * rakamlar atılır. En fazla 8, her biri en fazla 40 karakter, tekrarsız.
 */
export function extractUnrecognizedTerms(
  queryNorm: string,
  entries: readonly LexiconEntry[],
): string[] {
  const normalized = normalizeQueryText(queryNorm);
  if (!normalized) return [];
  const parsed = parseQueryText(normalized, entries);
  const unparsed = new Set(parsed.unparsed.split(" ").filter(Boolean));

  const covered = new Set<string>();
  const tokens = tokenizeWithOffsets(normalized);
  for (const match of findLexiconMatches(normalized, entries)) {
    for (const token of tokens) {
      if (token.start < match.end && token.end > match.start) covered.add(token.value);
    }
  }

  const terms: string[] = [];
  for (const token of tokens) {
    if (!unparsed.has(token.value) || covered.has(token.value)) continue;
    // Noktalama kelime değildir: "çanta," -> "çanta".
    const term = token.value.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (term.length < 2 || term.length > SEARCH_QUALITY_TERM_LENGTH_MAX) continue;
    if (STOPWORDS.has(term) || NUMBER_LIKE.test(term)) continue;
    if (covered.has(term) || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length >= SEARCH_QUALITY_TERMS_MAX) break;
  }
  return terms;
}

export interface SearchQualityInput {
  queryNorm: string;
  /** `/ara`'nın gösterdiği toplam (sonuç sayısı). */
  resultCount: number;
  /** Sonuç yokken filtresiz yedek liste gösterildi ve boş değildi. */
  usedFallback: boolean;
  /** Netleştirme sorusu soruldu. */
  clarification: boolean;
  /** 1–3 (query_resolution ile aynı); bilinmiyorsa null. */
  parserTier: number | null;
  unrecognizedTerms: readonly string[];
}

export type SearchQualityOutcome = "recorded" | "skipped" | "failed";

function cleanTerms(terms: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of terms) {
    if (typeof raw !== "string") continue;
    const term = raw.trim();
    if (term.length === 0 || term.length > SEARCH_QUALITY_TERM_LENGTH_MAX) continue;
    // Terim de kişisel veri süzgecinden geçer (sorgu geçtiyse zaten geçer; savunma).
    if (!isRecordableQuery(term) || out.includes(term)) continue;
    out.push(term);
    if (out.length >= SEARCH_QUALITY_TERMS_MAX) break;
  }
  return out;
}

function logFailure(error: unknown): void {
  // Yalnızca sınıf: sorgu metni, parametre ya da SQL loglara girmez.
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? "";
  console.error(
    "[search-quality] record failed",
    error instanceof Error ? error.name : "unknown",
    code,
  );
}

/**
 * Upsert: (gün, sorgu) satırı yoksa açılır, varsa sayaçlar artar; son sonuç
 * sayısı, kademe ve tanınmayan kelimeler en son aramanınkiyle değişir.
 * Kısa zaman aşımlı kendi işleminde çalışır. Asla fırlatmaz.
 */
export async function recordSearchQuality(
  db: Database,
  input: SearchQualityInput,
  now: Date = new Date(),
): Promise<SearchQualityOutcome> {
  try {
    const queryNorm = typeof input.queryNorm === "string" ? input.queryNorm : "";
    if (!isRecordableQuery(queryNorm)) return "skipped";
    const resultCount =
      Number.isFinite(input.resultCount) && input.resultCount > 0
        ? Math.min(Math.trunc(input.resultCount), 2_147_483_647)
        : 0;
    const parserTier =
      Number.isInteger(input.parserTier) &&
      (input.parserTier as number) >= 1 &&
      (input.parserTier as number) <= 3
        ? (input.parserTier as number)
        : null;
    const terms = cleanTerms(input.unrecognizedTerms ?? []);
    const zero = resultCount === 0 ? 1 : 0;
    const fallback = input.usedFallback === true ? 1 : 0;
    const clarification = input.clarification === true ? 1 : 0;
    const at = now.toISOString();

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = 1500`);
      await tx.execute(sql`
        INSERT INTO search_query_day AS d
          (day, query_norm, searches, zero_results, fallbacks, clarifications,
           last_result_count, parser_tier, unrecognized_terms, last_seen_at)
        VALUES (
          (${at}::timestamptz AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date,
          ${queryNorm}, 1, ${zero}, ${fallback}, ${clarification},
          ${resultCount}, ${parserTier}::smallint, ${sql.param(terms)}::text[], ${at}::timestamptz
        )
        ON CONFLICT (day, query_norm) DO UPDATE SET
          searches = d.searches + 1,
          zero_results = d.zero_results + EXCLUDED.zero_results,
          fallbacks = d.fallbacks + EXCLUDED.fallbacks,
          clarifications = d.clarifications + EXCLUDED.clarifications,
          last_result_count = EXCLUDED.last_result_count,
          parser_tier = EXCLUDED.parser_tier,
          unrecognized_terms = EXCLUDED.unrecognized_terms,
          last_seen_at = GREATEST(d.last_seen_at, EXCLUDED.last_seen_at)
      `);
    });
    return "recorded";
  } catch (error) {
    logFailure(error);
    return "failed";
  }
}

export interface TextSearchQualityInput {
  /** `/ara`'ya giden sorgu metni (normalize edilir). */
  query: string;
  resultCount: number;
  usedFallback: boolean;
  clarification: boolean;
  parserTier: number | null;
}

/**
 * `/ara` metin araması için tek giriş noktası: kişisel veri süzgeci sözlük
 * okunmadan ÖNCE çalışır; sonra tanınmayan kelimeler çıkarılır ve sayaç
 * yazılır. Asla fırlatmaz. Yönetim tanısı bunu ÇAĞIRMAZ.
 */
export async function recordTextSearchQuality(
  db: Database,
  input: TextSearchQualityInput,
  now: Date = new Date(),
): Promise<SearchQualityOutcome> {
  try {
    const queryNorm = normalizeQueryText(typeof input.query === "string" ? input.query : "");
    if (!isRecordableQuery(queryNorm)) return "skipped";
    const entries = await loadLexicon(db);
    return await recordSearchQuality(
      db,
      {
        queryNorm,
        resultCount: input.resultCount,
        usedFallback: input.usedFallback,
        clarification: input.clarification,
        parserTier: input.parserTier,
        unrecognizedTerms: extractUnrecognizedTerms(queryNorm, entries),
      },
      now,
    );
  } catch (error) {
    logFailure(error);
    return "failed";
  }
}

/**
 * 90 günden eski günleri siler (Europe/Istanbul takvim günü). Cron'a
 * bağlanması üst katmanın işidir. Silinen satır sayısını döner.
 */
export async function purgeSearchQueryDays(db: Database, now: Date = new Date()): Promise<number> {
  const at = now.toISOString();
  const result = await db.execute(sql`
    DELETE FROM search_query_day
    WHERE day < ((${at}::timestamptz AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date
                 - ${SEARCH_QUALITY_RETENTION_DAYS}::int)
  `);
  return result.rowCount ?? 0;
}
