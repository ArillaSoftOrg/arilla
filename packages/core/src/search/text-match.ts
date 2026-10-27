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
import type { Database } from "@arilla/db";
import { type SQL, sql } from "drizzle-orm";
import { productHasVerifiableOfferSql } from "../offers/freshness.ts";
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

/**
 * Aynı katlama, başka metin kolonları için (yönetim kullanıcı araması: ad ve
 * e-posta). Sorgu tarafı `foldForMatch` ile katlanır.
 */
export function foldedTextExpr(value: SQL): SQL {
  return foldExpr(value);
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
 * Aday kumesinin dal basina ust siniri (karar 0129). Milyonluk katalogda yaygin
 * bir bas isim ("kilif", "case") yuz binlerce urunle eslesir; kapi, skor ve
 * gorsel tekillestirmesi bunlarin hepsinde kosarsa sorgu saniyeler surer. Dal
 * bu kadar urunle durur; toplam o zaman alt sinirdir (`cand_meta.capped`).
 */
export const CANDIDATE_LIMIT = 1000;

/** "Bir eksik" dallarinin paylasimli sinirinin tabani. */
const MIN_BRANCH_LIMIT = 200;

/** Aday dalina itilen urun kolonu filtreleri (`buildFilterClause` ile ayni kosullar). */
export interface CandidateFilters {
  category_path?: string | undefined;
  color?: string[] | undefined;
  brand_include?: string[] | undefined;
  brand_exclude?: string[] | undefined;
}

/**
 * Aday dalinin baslik eslesmesinde kelime koku: kelimenin basi, sonundan en fazla
 * iki harf atilmis (en az 4 harf kalir). Turkce ek ve unsuz yumusamasi kokun
 * arkasina gelir: "cantasi" -> "canta" ("canta", "cantasi"), "koltuk" -> "kolt"
 * ("koltugu"), "kulaklik" -> "kulakl". 4 harf ve kisasi oldugu gibi kalir.
 */
export function candidateStem(word: string): string {
  return word.length <= 4 ? word : word.slice(0, Math.max(4, word.length - 2));
}

/** Bulanik adayda `<<%` kullanilan en kisa kelime (harf) ve en fazla kac kelime. */
const FUZZY_MIN_LENGTH = 5;
const FUZZY_MAX_WORDS = 3;

const REGEX_SPECIAL = /[\\^$.|?*+()[\]{}]/g;

/**
 * Bir alternatifin aday dali regex'i: her kelimenin koku KELIME BASINDA (`\m`),
 * cok kelimeli alternatifte kelimeler arka arkaya; kokten sonra kelimenin kalani
 * (`\w*`) serbesttir ("akıllı saat" -> `\makil\w*\s+saat`: "akilli saat"). Trigram GIN regex'ten tum
 * trigramlari (VE) cikarir; `<<%` ise kisa kelimede (" ca", "ta ") yaygin trigramlarla
 * kayipli aday alir ve hepsini yeniden denetler (olculdu, karar 0129: 3,77M urunde
 * "canta" icin `<<%` 19 sn, `~ '\mcant'` 7 ms). Nihai kabul yine metin kapisidir.
 */
export function candidatePattern(alternative: string): string | null {
  const words = alternative.split(/\s+/).filter((word) => word.length > 0);
  // 1-2 harfli kelime ("tv", "4k") trigram uretmez: regex indeksi kullanamaz.
  if (words.length === 0 || words.some((word) => word.length < 3)) return null;
  const stems = words.map((word) => candidateStem(word).replace(REGEX_SPECIAL, "\\$&"));
  return `\\m${stems.join("\\w*\\s+")}`;
}

/**
 * Aday dalinin baslik kosullari: birbirini kapsayan alternatifler tek kosula iner.
 * `\mkulakl` ("kulaklik") `\mkulakli` ("kulakligi") ve `\mkulakl`i zaten kapsar; ek
 * kosul ayni satirlari bir daha arar (esanlamlilarla bir slot 9 alternatife cikiyordu,
 * olculdu). 1-2 harfli kelime `<<%` kosulu olarak kalir.
 */
export function retrievalArms(slot: readonly string[]): { pattern: string | null; alt: string }[] {
  const arms = slot.map((alt) => ({ alt, pattern: candidatePattern(alt) }));
  const kept: { pattern: string | null; alt: string }[] = [];
  for (const arm of [...arms].sort((a, b) => (a.pattern?.length ?? 0) - (b.pattern?.length ?? 0))) {
    if (arm.pattern === null) {
      if (!kept.some((k) => k.pattern === null && k.alt === arm.alt)) kept.push(arm);
      continue;
    }
    const pattern = arm.pattern;
    if (!kept.some((k) => k.pattern !== null && pattern.startsWith(k.pattern))) kept.push(arm);
  }
  return kept;
}

/**
 * Kapinin alternatifleri: bir alternatifin 1-2 harf ekli bicimi ("earphones",
 * "kilifi", "cantasi") ayni slotta kisa bicimi varken atilir. Kisa bicimin ekli
 * kelimeye benzerligi esigin ustunde kalir (or. "kilif"/"kilifi" 0,62), slotun kabul
 * karari degismez; her aday satirinda bir benzerlik hesabi eksilir.
 */
export function gateAlternatives(slot: readonly string[]): string[] {
  const sorted = [...slot].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const alt of sorted) {
    const covered = kept.some(
      (k) =>
        !/\s/.test(k) &&
        !/\s/.test(alt) &&
        k.length >= 4 &&
        alt.startsWith(k) &&
        alt.length - k.length <= 2,
    );
    if (!covered) kept.push(alt);
  }
  // Slot sirasi korunur (ilk alternatif sorgudaki bicimdir).
  return slot.filter((alt) => kept.includes(alt));
}

/** Bir slotun eslestigi marka ve ana kategori (alt kategorileriyle) kimlikleri. */
export interface SlotLookup {
  brandIds: number[];
  categoryIds: number[];
}

/**
 * Slot basina marka/kategori eslesmeleri, aramadan ONCE ayri ve kucuk bir sorguyla
 * (karar 0131). Kimlikler aday sorgusuna sabit olarak gomulur: eslesmesi olmayan slot
 * icin dal hic uretilmez, olanlarda planlayici gercek dizi boyutunu gorup marka
 * indeksini kullanir. Alt sorgu olarak kaldiginda planlayici diziyi bilmiyor, bos
 * olsa bile basligin bitmap'iyle gidip satir suzuyordu (olculdu: 1,7 sn, 0 sonuc).
 */
export async function resolveSlotLookups(
  db: Database,
  slots: readonly string[][],
  /** Ayni ifadede ek SQL (or. `withCandidatePlan`in plan ayari); tek gidis-donus. */
  alongside: SQL | null = null,
): Promise<SlotLookup[]> {
  const lookups: SlotLookup[] = slots.map(() => ({ brandIds: [], categoryIds: [] }));
  if (slots.length === 0) {
    if (alongside) await db.execute(sql`SELECT ${alongside}`);
    return lookups;
  }
  const index: number[] = [];
  const alternatives: string[] = [];
  slots.forEach((slot, i) => {
    for (const alt of gateAlternatives(slot)) {
      index.push(i + 1);
      alternatives.push(alt);
    }
  });
  const pairs = sql`unnest(${sql.param(index)}::int[], ${sql.param(alternatives)}::text[]) AS h(i, t)`;
  const result = await db.execute<{ i: number; kind: string; id: string }>(sql`
    SELECT DISTINCT h.i, 'b' AS kind, br.id::text AS id
      FROM ${pairs} JOIN brand br ON h.t <<% ${foldExpr(sql`br.name`)}
    UNION ALL
    SELECT DISTINCT rh.i, 'c' AS kind, cc.id::text AS id
      FROM (
        SELECT h.i, cr.path FROM ${pairs}
          JOIN category cr ON position('/' IN cr.path) = 0 AND h.t <<% ${foldExpr(sql`cr.name`)}
      ) rh
      JOIN category cc ON split_part(cc.path, '/', 1) = rh.path
    ${alongside ? sql`UNION ALL SELECT 0, 'x', ${alongside}::text` : sql``}
  `);
  for (const row of result.rows) {
    const lookup = lookups[Number(row.i) - 1];
    if (!lookup) continue;
    (row.kind === "b" ? lookup.brandIds : lookup.categoryIds).push(Number(row.id));
  }
  return lookups;
}

/**
 * Bir slotun indeksli eslesmesi: alternatiflerinden biri katlanmis baslikta,
 * markada ya da ana kategori adinda gecer. Baslik kosullari bolumun kismi trigram
 * GIN'ini (kok regex'i; 1-2 harfli kelimede `<<%`), marka/kategori kosullari kendi
 * btree indekslerini kullanir; eslesen marka/kategori `slotLookupCtes`ten okunur.
 * `slotNumber` 1'den baslar.
 */
function slotMatch(slot: readonly string[], lookup: SlotLookup | undefined, alias: string): SQL {
  const byLookup = slotLookupMatch(lookup, alias);
  return byLookup
    ? sql`(${slotTitleMatch(slot, alias)} OR ${byLookup})`
    : slotTitleMatch(slot, alias);
}

/** Slotun yalnizca baslik kosulu (bolum GIN'i). */
function slotTitleMatch(slot: readonly string[], alias: string): SQL {
  const title = foldedTitleExpr(sql.raw(`${alias}.title`));
  const titleArms = retrievalArms(slot).map(({ alt, pattern }) =>
    pattern === null ? sql`${alt}::text <<% ${title}` : sql`${title} ~ ${pattern}::text`,
  );
  return sql`(${sql.join(titleArms, sql` OR `)})`;
}

/** Slotun marka/ana kategori kosulu (btree); eslesme yoksa null (dal uretilmez). */
function slotLookupMatch(lookup: SlotLookup | undefined, alias: string): SQL | null {
  const a = sql.raw(alias);
  const parts: SQL[] = [];
  if (lookup && lookup.brandIds.length > 0) {
    parts.push(sql`${a}.brand_id = ANY(${sql.param(lookup.brandIds)}::bigint[])`);
  }
  if (lookup && lookup.categoryIds.length > 0) {
    parts.push(sql`${a}.category_id = ANY(${sql.param(lookup.categoryIds)}::bigint[])`);
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? (parts[0] as SQL) : sql`(${sql.join(parts, sql` OR `)})`;
}

/**
 * Aday dalinin ortak kosullari: yayindaki urun ve urun kolonu filtreleri. Filtreler
 * sonradan `buildFilterClause` ile AYNEN yeniden uygulanir; burada yalnizca sinirli
 * dalin seyrek filtreli bir sorguda eslesmeyen urunlerle dolmasini onler.
 */
function candidateBase(filters: CandidateFilters, alias: string): SQL[] {
  const a = sql.raw(alias);
  const parts: SQL[] = [sql`${a}.publication_state = 'published'`];
  if (filters.category_path) {
    parts.push(sql`${a}.category_id IN (
      SELECT id FROM category WHERE path = ${filters.category_path} OR path LIKE ${filters.category_path} || '/%')`);
  }
  if (filters.color && filters.color.length > 0) {
    parts.push(sql`${a}.color = ANY(${sql.param(filters.color)}::text[])`);
  }
  if (filters.brand_include && filters.brand_include.length > 0) {
    parts.push(sql`${a}.brand_id IN (
      SELECT id FROM brand WHERE name_norm = ANY(${sql.param(filters.brand_include)}::text[]))`);
  }
  if (filters.brand_exclude && filters.brand_exclude.length > 0) {
    parts.push(sql`(${a}.brand_id IS NULL OR ${a}.brand_id NOT IN (
      SELECT id FROM brand WHERE name_norm = ANY(${sql.param(filters.brand_exclude)}::text[])))`);
  }
  // Karar 0156 eki: tum teklifleri dogrulanamayan urun, `LIMIT`ten ONCE aday olmaz; yoksa
  // sinirli pencereyi doldurup guncel urunleri disarida birakir. Politika yoksa maliyetsiz.
  parts.push(productHasVerifiableOfferSql(alias));
  return parts;
}

/**
 * Aday bolumleri (karar 0129). Bir bolumun sinirli dali digerini dolduramaz:
 * 2,8M yurt disi ilan, ayni bas ismi tasiyan TRY teklifli urunleri adaydan
 * itmez. `offer_count` TRY ozetidir; `= 0` bolumu yurt disi ilanlari VE ozeti
 * gecikmis urunleri tasir, yani iki bolum birlikte tum yayindaki urunleri kapsar
 * (hicbir urun bolumsuz kalmaz). Her bolumun kendi kismi baslik GIN'i vardir
 * (migration 0083); kosul ifadeleri indeks yuklemiyle AYNI yazilir.
 */
const PARTITIONS: readonly SQL[] = [sql`p.offer_count > 0`, sql`p.offer_count = 0`];

/**
 * Tek urun icin bas isim eslesmesi (yonetim tanisi): bas isim dalinin kosulu.
 * `<<%` = strict_word_similarity >= `pg_trgm.strict_word_similarity_threshold`
 * (varsayilan 0.5 = TOKEN_MATCH_THRESHOLD). Esik 0.5'in altina inerse aday
 * dallari adaylari kacirir; ikisi birlikte degismeli.
 */
export function headSlotMatch(
  slots: readonly string[][],
  lookups: readonly SlotLookup[],
  alias: string,
): SQL {
  return slotMatch(slots[slots.length - 1] ?? [], lookups[slots.length - 1], alias);
}

/**
 * Bulanik (typo) adimin kelimeleri: yalnizca uzunlar, en uzun once. 3-4 harfte
 * esik 0.3 neredeyse her basligi aday yapar ("pro": 3,77M urunde 588 bin aday,
 * 14 sn, olculdu) ve bir duzeltme degeri tasimaz.
 */
export function fuzzyWords(slots: readonly string[][]): string[] {
  const words = new Set<string>();
  for (const slot of slots) {
    for (const alt of slot) {
      if (!/\s/.test(alt) && alt.length >= FUZZY_MIN_LENGTH) words.add(alt);
    }
  }
  return [...words].sort((a, b) => b.length - a.length).slice(0, FUZZY_MAX_WORDS);
}

export interface CandidateOptions {
  /** `resolveSlotLookups` sonucu; verilmezse marka/kategori dali yoktur. */
  lookups?: readonly SlotLookup[] | undefined;
  limit?: number | undefined;
  /**
   * Bulanik (typo) adim: kok regex'i yazim hatasini tutmaz. Her uzun kelime icin TEK
   * kosullu bir `<<%` dali (esik islem icinde 0.3); kapi yine tum slotlari olcer.
   * Kosullar birlestirilmez: planlayici aksi halde yaygin kisa kelimenin bitmap'ini
   * surup her satirda benzerlik hesaplar.
   */
  fuzzy?: boolean | undefined;
  /**
   * "En iyi firsatlar": yalnizca TRY bolumu ve sisik olmayan fiyat istatistigi olan
   * urun (sekmenin kendi kosulu; aksi halde sinirli dal yurt disi ilanlarla dolar).
   */
  bestDeal?: boolean | undefined;
}

/**
 * Sinirli aday kumesi (karar 0129): `cand_raw`, `cand`, `cand_meta` CTE'leri.
 *
 * Her bolum (`PARTITIONS`) icin:
 * - Bas isim dali: bas isim slotu (baslik/marka/ana kategori) eslesen en fazla
 *   `limit` urun — eski `headPrefilter`in kumesi, sinirli.
 * - Siki dal (2+ slot): TUM slotlari eslesen en fazla `limit` urun. Bas isim dali
 *   doldugunda bile en alakali urunler (tum niteleyiciler) aday kalir. Iki slotta
 *   tek daldir (kapi iki slotu da ister).
 * - Bulanik adim: her uzun kelime icin tek kosullu `<<%` dali (`fuzzyWords`).
 * - Metin yoksa: urun kolonu filtreleriyle en fazla `limit` urun.
 *
 * Aday kumesi kapidan (`tokenMatchGate`) ONCE bir kez hesaplanir; teklif secimi,
 * kapi, skor ve tekillestirme yalnizca onun uzerinde calisir. `cand_meta.capped`:
 * toplamin alt sinir oldugu durum. Kapidan gecen her urunu kapsamasi gereken dal
 * sinira ulasti: tek slotta bas isim dali; iki slotta (eksik izni yok) siki dal;
 * uc ve daha cok slotta (bir niteleyici eksik olabilir) yine bas isim dali.
 */
export function candidateCtes(
  slots: readonly string[][],
  filters: CandidateFilters,
  options: CandidateOptions = {},
): SQL {
  const limit = options.limit ?? CANDIDATE_LIMIT;
  const base = candidateBase(filters, "p");
  const partitions = options.bestDeal
    ? [
        sql`${PARTITIONS[0] as SQL} AND EXISTS (
          SELECT 1 FROM product_price_stats ps
          WHERE ps.product_id = p.id AND ps.list_price_inflated = FALSE)`,
      ]
    : PARTITIONS;
  const n = slots.length;
  const lookups = options.lookups ?? [];
  const headLookup = slotLookupMatch(lookups[n - 1], "p");
  const head = slots[n - 1] ?? [];
  const titles = slots.map((slot) => slotTitleMatch(slot, "p"));
  const and = (parts: SQL[]) => sql.join(parts, sql` AND `);
  const or = (parts: SQL[]) => sql`(${sql.join(parts, sql` OR `)})`;
  // Siki aile (1): tum slotlar baslikta; ya da TEK slot markada/kategoride, digerleri
  // baslikta. Kosullar ayni ifade GIN'inde oldugu icin planlayici bitmap duzeyinde
  // kesistirir (marka kolu her slotta olunca tek slotun bitmap'iyle gidip digerlerini
  // satir satir denetliyordu: "bluetooth hoparlor" 3,7 sn, olculdu).
  const strictConditions: SQL[] =
    n >= 2
      ? [
          and(titles),
          ...slots.flatMap((_, i) => {
            const byLookup = slotLookupMatch(lookups[i], "p");
            return byLookup ? [and([byLookup, ...titles.filter((_, j) => j !== i)])] : [];
          }),
        ]
      : [];
  // Bas isim ailesi (2): tek slotta bas isim (baslik/marka/kategori). 3+ slotta kapi
  // bas ismi ve en fazla BIR eksik niteleyiciyi kabul eder; tam ust kumesi "her seferinde
  // bir niteleyici disarida" kalan n-1 dal: hepsi yalnizca baslik kosulu, GIN'de kesisir.
  // ("bas isim VE herhangi biri" 337 bin "case" icinden kapidan gecemeyen 1000 aday
  // getiriyordu, olculdu.) Bas isim markada/kategorideyse niteleyicilerden biri yeter.
  const others = titles.slice(0, -1);
  const headTitle = titles[n - 1] as SQL;
  const headConditions: SQL[] =
    n === 1
      ? [slotMatch(head, lookups[0], "p")]
      : n >= 3
        ? [
            ...others.map((_, skip) => and([headTitle, ...others.filter((_, j) => j !== skip)])),
            ...(headLookup ? [and([headLookup, or(others)])] : []),
          ]
        : [];
  const typoWords = options.fuzzy ? fuzzyWords(slots) : [];
  const title = foldedTitleExpr(sql.raw("p.title"));
  const branches: SQL[] = [];
  let sequence = 0;
  // Kapidan gecen her urunu kapsayan dal ailesi: tek slotta bas isim, iki slotta siki,
  // 3+ slotta siki + "bir eksik" dallari (ikisi birlikte).
  const completeKinds = n === 1 || n === 0 ? [2] : n === 2 && allowedMisses(2) === 0 ? [1] : [1, 2];
  partitions.forEach((partition, index) => {
    const where = sql.join([...base, partition], sql` AND `);
    // branch: 10*bolum + (1 siki | 2 bas isim/metinsiz/bulanik)
    const strictBranch = 10 * index + 1;
    const headBranch = 10 * index + 2;
    const branch = (kind: number, condition: SQL | null, cap: number = limit) => {
      sequence += 1;
      const filter = condition ? sql` AND ${condition}` : sql``;
      return sql`(SELECT p.id, ${kind}::int AS branch, ${sequence}::int AS seq, ${cap}::int AS cap
        FROM product p WHERE ${where}${filter} LIMIT ${cap})`;
    };
    if (typoWords.length > 0) {
      for (const word of typoWords)
        branches.push(branch(headBranch, sql`${word}::text <<% ${title}`));
      return;
    }
    if (n === 0) {
      branches.push(branch(headBranch, null));
      return;
    }
    for (const condition of strictConditions) branches.push(branch(strictBranch, condition));
    // "Bir eksik" dallari bolum basina toplam butceyi paylasir (5 slotta 4 dal x 1000
    // aday puanlamada 2+ sn tutuyordu, olculdu); tek slotta bas isim dali tam sinirdadir.
    const headCap = n >= 3 ? Math.max(MIN_BRANCH_LIMIT, Math.ceil(limit / (n - 1))) : limit;
    for (const condition of headConditions) branches.push(branch(headBranch, condition, headCap));
  });
  return sql`
    cand_raw AS (${sql.join(branches, sql` UNION ALL `)}),
    cand AS (SELECT DISTINCT id FROM cand_raw),
    cand_meta AS (
      SELECT COALESCE(bool_or(n >= cap), FALSE) AS capped
      FROM (SELECT count(*) AS n, max(cap) AS cap FROM cand_raw
             WHERE branch % 10 = ANY(${sql.param(completeKinds)}::int[]) GROUP BY seq) x
    )`;
}

/**
 * `tm` adli LATERAL: `tm.matched` (esigi gecen slot sayisi), `tm.head` (son
 * slotun benzerligi), `tm.rel` (slot benzerliklerinin ortalamasi). Bir slotun
 * benzerligi alternatiflerinin en iyisidir. Slotlar bossa cagrilmaz.
 */
export function tokenMatchLateral(
  slots: readonly string[][],
  document: SQL,
  threshold: number = TOKEN_MATCH_THRESHOLD,
): SQL {
  const slotIndex: number[] = [];
  const alternatives: string[] = [];
  slots.forEach((slot, i) => {
    for (const alt of gateAlternatives(slot)) {
      slotIndex.push(i + 1);
      alternatives.push(alt);
    }
  });
  return sql`LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE s.v >= ${threshold})::int AS matched,
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
export function tokenMatchGate(
  slots: readonly string[][],
  threshold: number = TOKEN_MATCH_THRESHOLD,
): SQL {
  const required = slots.length - allowedMisses(slots.length);
  return sql`(tm.head >= ${threshold} AND tm.matched >= ${required})`;
}
