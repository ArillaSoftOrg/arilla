/**
 * Metin aramasinda aday kapisi ve alaka (docs/decisions/0029).
 *
 * Eski davranis: `similarity(p.title, sorgu)` yalnizca SIRALAMADA kullaniliyor,
 * WHERE'de hicbir alaka kosulu yoktu — aktif teklifi olan her urun 24'luk
 * listeyi dolduruyordu. Katalogda karsiligi olmayan "yoga mati" 24 alakasiz
 * sonuc donduruyordu. Ustelik tum-baslik benzerligi kisa basliklari
 * odullendiriyordu ("hali" -> "Cift Halkali Kemer").
 *
 * Yeni kural, token duzeyinde:
 *
 * - Sorgu ve urun metni ayni sekilde katlanir: Turkce kucuk harf + ASCII
 *   (ı->i, ş->s ...). "hali" ile "halı" ayni sorgudur (ASCII klavye).
 * - Urun metni = baslik + marka + renk. Marka sorgulari ("grohe") ve
 *   basligina yazilmamis renkler (Shopify renk bolmesi, 0024) bulunur.
 *   Kategori adi BILEREK yok: kategori ipucu kaba (0027) ve yanlis pozitif
 *   uretir.
 * - Her token icin `strict_word_similarity` (kelime sinirli en iyi parca):
 *   "hali" "halkali"nin icinde gecse bile kelime olarak eslesmez.
 * - Turkce isim tamlamasinda bas isim sondadir ("kadin omuz CANTASI",
 *   "telefon KILIFI"). Son token her zaman eslesmeli; 1-2 tokenli sorguda
 *   tum tokenlar, 3+ tokenli sorguda en fazla bir niteleyici eksik olabilir.
 *
 * Esik tek bir sihirli sayi degil, olculmus bir secim:
 * `packages/core/src/search/eval/` degerlendirme seti ile ayarlandi.
 */
import { type SQL, sql } from "drizzle-orm";
import type { LexiconEntry } from "./lexicon.ts";
import { foldTurkish } from "./normalize.ts";

/**
 * Token eslesme esigi (strict_word_similarity). 0.5, Turkce ek ve unsuz
 * yumusamasini ("koltugu" ~ "koltuk" = 0.50, "cantasi" ~ "canta") kabul edip
 * alt-dize tuzaklarini ("hali" ~ "halkali" < 0.4) reddeden en dusuk deger.
 */
export const TOKEN_MATCH_THRESHOLD = 0.5;

/** Asiri uzun sorgu metni SQL'i sisirmesin. */
export const MAX_QUERY_TOKENS = 8;

const ASCII_FOLD: Record<string, string> = {
  ı: "i",
  ş: "s",
  ç: "c",
  ğ: "g",
  ö: "o",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
};

/** Sorgu tarafi katlama; SQL tarafindaki `foldedDocumentExpr` ile ayni kural. */
export function foldForMatch(text: string): string {
  return foldTurkish(text).replace(/[ışçğöüâîû]/g, (ch) => ASCII_FOLD[ch] ?? ch);
}

/**
 * Eslesme icin anlamli tokenlar: katlanmis, harf/rakam disi temizlenmis,
 * tek karakterliler atilmis, tekrarsiz, sirasi korunmus (bas isim sonda).
 */
export function matchTokens(text: string | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of foldForMatch(text).split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || seen.has(raw)) continue;
    seen.add(raw);
    tokens.push(raw);
  }
  return tokens.slice(-MAX_QUERY_TOKENS);
}

/**
 * Metin slotlari: her token bir slot; `synonym` sozluk yuzeyi (tek ya da cok
 * kelimeli) eslesen tokenlar TEK slota toplanir ve alternatifleri ayni
 * `normalized` degerini paylasan tum yuzeylerdir. "kablosuz mouse" ->
 * [["kablosuz","wireless"],["mouse"]]; "spor ayakkabi" -> tek slot.
 * En uzun eslesme once; slot sirasi sorgu sirasidir (bas isim sonda kalir).
 */
export function buildTextSlots(text: string, entries: readonly LexiconEntry[]): string[][] {
  const tokens = matchTokens(text);
  if (tokens.length === 0) return [];

  const groups = new Map<string, string[]>();
  const surfaces: { words: string[]; group: string }[] = [];
  for (const entry of entries) {
    if (entry.kind !== "synonym") continue;
    const words = matchTokens(entry.surface);
    if (words.length === 0) continue;
    const alternatives = groups.get(entry.normalized) ?? [];
    alternatives.push(words.join(" "));
    groups.set(entry.normalized, alternatives);
    surfaces.push({ words, group: entry.normalized });
  }
  surfaces.sort((a, b) => b.words.length - a.words.length);

  const slots: string[][] = [];
  let index = 0;
  while (index < tokens.length) {
    const hit = surfaces.find((surface) =>
      surface.words.every((word, offset) => tokens[index + offset] === word),
    );
    if (hit) {
      const phrase = hit.words.join(" ");
      const alternatives = groups.get(hit.group) ?? [];
      slots.push([phrase, ...alternatives.filter((alt) => alt !== phrase)]);
      index += hit.words.length;
    } else {
      slots.push([tokens[index] as string]);
      index += 1;
    }
  }
  return slots;
}

/** Bas isim haric kac slot eksik olabilir. */
export function allowedMisses(slotCount: number): number {
  return slotCount >= 3 ? 1 : 0;
}

const FOLD_FROM = "ıİIŞşÇçĞğÖöÜüÂâÎîÛû";
const FOLD_TO = "iiissccggoouuaaiiuu";

/**
 * Katlanmis metin. `translate` once, `lower` sonra: "I" -> "i" (Turkce'de
 * "ı" olurdu ama sorgu tarafi da "ı"yi "i"ye katliyor). Sabitler SQL'e
 * parametre olarak DEGIL, metin olarak gomulur: `product_title_fold_trgm`
 * indeksi (migration 0019) ayni ifadeyi bekler, parametreli ifade eslesmez.
 */
function foldExpr(value: SQL): SQL {
  return sql`lower(translate(${value}, ${sql.raw(`'${FOLD_FROM}'`)}, ${sql.raw(`'${FOLD_TO}'`)}))`;
}

/** `product_title_fold_trgm` indeksinin ifadesi. */
export function foldedTitleExpr(title: SQL): SQL {
  return foldExpr(title);
}

/**
 * Baslik + marka + renk + ANA kategori adi, katlanmis. Renkteki tire bosluga
 * cevrilir. Ana kategori ("Anne / Bebek", "Elektronik") kitle/bolum
 * kelimelerini karsilar: "bebek battaniyesi" basliginda "bebek" gecmeyen
 * muslin battaniyeyi bulur. Alt kategori BILEREK yok: bootstrap ipuclari
 * kaba (Derimod cantalari moda/ayakkabi altinda, 0027).
 */
export function foldedDocumentExpr(
  title: SQL,
  brandName: SQL,
  color: SQL,
  rootCategoryName: SQL,
): SQL {
  return foldExpr(
    sql`concat_ws(' ', ${title}, ${brandName}, replace(COALESCE(${color}, ''), '-', ' '), ${rootCategoryName})`,
  );
}

/** Urunun ana kategorisi: `category.path`in ilk parcasi. */
export function rootCategoryJoin(categoryPath: SQL): SQL {
  return sql`LEFT JOIN category rc ON rc.path = split_part(${categoryPath}, '/', 1)`;
}

/**
 * Indeksli on filtre: bas isim katlanmis baslikta, markada ya da ana
 * kategori adinda gecmeli.
 * `<<%` = strict_word_similarity >= `pg_trgm.strict_word_similarity_threshold`
 * (varsayilan 0.5 = TOKEN_MATCH_THRESHOLD). Esik 0.5'in altina inerse bu on
 * filtre adaylari kacirir; ikisi birlikte degismeli.
 *
 * UNION bilerek: `baslik <<% .. OR brand_id IN (..)` bicimi planlayicinin
 * indeksi birakip her basligi taramasina yol aciyordu (olculdu: 4 bin urunde
 * 113 ms -> UNION ile ~20 ms). Iki dal da kendi indeksini kullanir.
 */
export function headPrefilter(slots: readonly string[][], productId: SQL): SQL {
  const head = slots[slots.length - 1] ?? [];
  return sql`${productId} IN (
    SELECT pf.id FROM unnest(${sql.param(head)}::text[]) AS h(t)
      JOIN product pf ON h.t <<% ${foldedTitleExpr(sql`pf.title`)}
    UNION
    SELECT pb.id FROM product pb
     WHERE pb.brand_id = ANY(ARRAY(
       SELECT br.id FROM unnest(${sql.param(head)}::text[]) AS h(t)
         JOIN brand br ON h.t <<% ${foldExpr(sql`br.name`)}
     ))
    UNION
    SELECT pc.id FROM product pc
     WHERE pc.category_id = ANY(ARRAY(
       SELECT cc.id FROM category cc
         JOIN category cr ON cr.path = split_part(cc.path, '/', 1)
         JOIN unnest(${sql.param(head)}::text[]) AS h(t) ON h.t <<% ${foldExpr(sql`cr.name`)}
     ))
  )`;
}

/**
 * `tm` adli LATERAL: `tm.matched` (esigi gecen slot sayisi), `tm.head` (son
 * slotun benzerligi), `tm.rel` (slot benzerliklerinin ortalamasi). Bir slotun
 * benzerligi alternatiflerinin en iyisidir. Slotlar bossa cagrilmaz.
 */
export function tokenMatchLateral(slots: readonly string[][], document: SQL): SQL {
  const slotIndex: number[] = [];
  const alternatives: string[] = [];
  slots.forEach((slot, i) => {
    for (const alt of slot) {
      slotIndex.push(i + 1);
      alternatives.push(alt);
    }
  });
  return sql`LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE s.v >= ${TOKEN_MATCH_THRESHOLD})::int AS matched,
           COALESCE(max(s.v) FILTER (WHERE s.i = ${slots.length}), 0)::double precision AS head,
           avg(s.v)::double precision AS rel
      FROM (
        SELECT u.i, max(strict_word_similarity(u.t, ${document})) AS v
          FROM unnest(${sql.param(slotIndex)}::int[], ${sql.param(alternatives)}::text[]) AS u(i, t)
         GROUP BY u.i
      ) s
  ) tm ON TRUE`;
}

/** Aday kapisi: bas isim eslesmeli, niteleyicilerden en fazla `allowedMisses` eksik. */
export function tokenMatchGate(slots: readonly string[][]): SQL {
  const required = slots.length - allowedMisses(slots.length);
  return sql`(tm.head >= ${TOKEN_MATCH_THRESHOLD} AND tm.matched >= ${required})`;
}
