/**
 * Yazim duzeltici sozcuk dagarciginin tek DB okuma noktasi ve surec ici onbellegi (karar 0172).
 * `lexicon-cache.ts` desenini izler: `Database` basina, sureli, es zamanli istekler tek okumayi
 * paylasir, hata onbellege yazilmaz. Istek yolunda (onbellek isabetinde) DB cagrisi yoktur.
 *
 * Faz 1: istek yoluna BAGLI DEGIL; yalniz Faz 2 bayrak arkasinda kullanir.
 */
import { brand, category, type Database, product } from "@arilla/db";
import { exists, sql } from "drizzle-orm";
import { loadLexiconCached } from "../lexicon-cache.ts";
import { buildVocabulary, type Vocabulary } from "./vocabulary.ts";

export const VOCABULARY_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Dagarciga giren en fazla marka. Yalniz en az bir urunu olan markalar okunur: feed'lerden
 * gelen urunsuz/artik marka adlari duzeltme hedefi olmasin.
 */
export const VOCABULARY_BRAND_LIMIT = 20_000;

export async function loadVocabulary(db: Database): Promise<Vocabulary> {
  const [categories, brands, lexicon] = await Promise.all([
    db.select({ name: category.name }).from(category),
    db
      .select({ name: brand.name })
      .from(brand)
      .where(
        exists(
          db.select({ one: sql`1` }).from(product).where(sql`${product.brandId} = ${brand.id}`),
        ),
      )
      .limit(VOCABULARY_BRAND_LIMIT),
    loadLexiconCached(db),
  ]);
  return buildVocabulary({
    categories: categories.map((row) => row.name),
    brands: brands.map((row) => row.name),
    lexicon,
  });
}

interface Entry {
  value: Vocabulary | null;
  expiresAt: number;
  inflight: Promise<Vocabulary> | null;
}

const entries = new WeakMap<Database, Entry>();

export async function loadVocabularyCached(
  db: Database,
  now: () => number = Date.now,
  load: (db: Database) => Promise<Vocabulary> = loadVocabulary,
): Promise<Vocabulary> {
  const entry = entries.get(db) ?? { value: null, expiresAt: 0, inflight: null };
  entries.set(db, entry);
  if (entry.value !== null && now() < entry.expiresAt) return entry.value;
  if (entry.inflight) return entry.inflight;
  const pending = load(db)
    .then((value) => {
      entry.value = value;
      entry.expiresAt = now() + VOCABULARY_CACHE_TTL_MS;
      return value;
    })
    .finally(() => {
      entry.inflight = null;
    });
  entry.inflight = pending;
  return pending;
}

export function invalidateVocabularyCache(db: Database): void {
  entries.delete(db);
}
