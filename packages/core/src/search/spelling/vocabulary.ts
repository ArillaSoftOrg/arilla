/**
 * Yazim duzeltici sozcuk dagarcigi (karar 0172). Saf ve bellek ici; DB okumasi
 * `vocabulary-repository.ts`'tedir.
 *
 * Kaynaklar mevcut veridir, yeni buyuk sozluk yazilmaz:
 * - `category.name` (Turkce urun adlari; Trendyol agaci),
 * - `lexicon` yuzeyleri (renk, kategori, marka, es anlam; TR <-> EN urun kelimeleri),
 * - `brand.name`,
 * - `SEED_WORDS`: hicbir tabloda bulunmayan model aileleri ve teknik kisaltmalar.
 *
 * Duzeltme hedefi olabilmek icin kelimenin bu dagarcikta olmasi gerekir; dagarcikta birebir
 * bulunan kelime ise asla duzeltilmez.
 */
import { createHash } from "node:crypto";
import type { VocabularySource } from "../normalized-query.ts";
import { foldForMatch } from "../text-match.ts";
import { phoneticForm, phoneticKey } from "./phonetic.ts";

/**
 * Tohum: marka ya da kategori adi olmayan, ama urun adi olarak yaygin model aileleri ve
 * teknik kisaltmalar. Genisleme yolu `lexicon` tablosudur; bu liste buyutulmez.
 */
export const SEED_WORDS: readonly string[] = [
  "iphone",
  "ipad",
  "airpods",
  "galaxy",
  "redmi",
  "powerbank",
  "usb",
  "hdmi",
];

export interface VocabularyInput {
  categories: readonly string[];
  lexicon: readonly { surface: string }[];
  brands: readonly string[];
  seed?: readonly string[];
}

export interface VocabularyWord {
  /** Katlanmis bicim (anahtar). */
  folded: string;
  /** Gorunen bicimler (Turkce kucuk harf) ve kac kez gectikleri. */
  displays: Map<string, number>;
  sources: Set<VocabularySource>;
  /** Tum kaynaklarda toplam gecis (siklik onceligi). */
  count: number;
  /** Onceden hesaplanmis fonetik bicim ve anahtar. */
  form: string;
  key: string;
}

export interface Vocabulary {
  /** Dagarcik anlik goruntusunun kisa hash'i (`normalizerVersion`'a girer). */
  readonly version: string;
  readonly size: number;
  get(folded: string): VocabularyWord | undefined;
  /** Ayni fonetik anahtari tasiyan kelimeler. */
  byKey(key: string): readonly VocabularyWord[];
  /** Ilk harfi ayni, uzunlugu `length` olan kelimeler. */
  byBucket(first: string, length: number): readonly VocabularyWord[];
  /** Fonetik bicimi ayni harfle baslayip `length` uzunlukta olan kelimeler. */
  byPhoneticBucket(first: string, length: number): readonly VocabularyWord[];
  /** Iki katlanmis kelime dagarciktaki bir cok kelimeli adda yan yana geciyor mu. */
  hasBigram(left: string, right: string): boolean;
}

const WORD_RE = /[\p{L}\p{N}]+/gu;

/**
 * Kelimeler, Turkce kucuk harfle. Tamami buyuk ASCII harf olan kisaltmalar ("HDMI", "USB")
 * Turkce kurala gore cevrilmez: "HDMI" -> "hdmı" degil "hdmi".
 */
function wordsOf(text: string): string[] {
  return (text.match(WORD_RE) ?? []).map((word) =>
    /^[A-Z0-9]+$/.test(word) ? word.toLowerCase() : word.toLocaleLowerCase("tr-TR"),
  );
}

/** Rakam icermeyen, en az iki harfli kelimeler dagarciga girer. */
function eligible(word: string): boolean {
  return word.length >= 2 && !/\d/.test(word);
}

export function buildVocabulary(input: VocabularyInput): Vocabulary {
  const words = new Map<string, VocabularyWord>();
  const bigrams = new Set<string>();

  const add = (text: string, source: VocabularySource) => {
    const parts = wordsOf(text);
    let previous: string | null = null;
    for (const display of parts) {
      const folded = foldForMatch(display);
      if (previous !== null) bigrams.add(`${previous} ${folded}`);
      previous = folded;
      if (!eligible(display)) continue;
      const word = words.get(folded) ?? {
        folded,
        displays: new Map<string, number>(),
        sources: new Set<VocabularySource>(),
        count: 0,
        form: phoneticForm(folded),
        key: phoneticKey(folded),
      };
      word.displays.set(display, (word.displays.get(display) ?? 0) + 1);
      word.sources.add(source);
      word.count += 1;
      words.set(folded, word);
    }
  };

  for (const name of input.categories) add(name, "category");
  for (const entry of input.lexicon) add(entry.surface, "lexicon");
  for (const name of input.brands) add(name, "brand");
  for (const seed of input.seed ?? SEED_WORDS) add(seed, "seed");

  const keyIndex = new Map<string, VocabularyWord[]>();
  const bucketIndex = new Map<string, VocabularyWord[]>();
  const phoneticBucketIndex = new Map<string, VocabularyWord[]>();
  for (const word of words.values()) {
    const phoneticBucket = `${word.form[0]}:${word.form.length}`;
    const phoneticList = phoneticBucketIndex.get(phoneticBucket) ?? [];
    phoneticList.push(word);
    phoneticBucketIndex.set(phoneticBucket, phoneticList);
    const keyList = keyIndex.get(word.key) ?? [];
    keyList.push(word);
    keyIndex.set(word.key, keyList);
    const bucket = `${word.folded[0]}:${word.folded.length}`;
    const bucketList = bucketIndex.get(bucket) ?? [];
    bucketList.push(word);
    bucketIndex.set(bucket, bucketList);
  }

  const hash = createHash("sha256");
  for (const folded of [...words.keys()].sort()) {
    const word = words.get(folded) as VocabularyWord;
    hash.update(`${folded}\t${[...word.displays.keys()].sort().join(",")}\t`);
    hash.update(`${[...word.sources].sort().join(",")}\n`);
  }
  for (const bigram of [...bigrams].sort()) hash.update(`${bigram}\n`);
  const version = hash.digest("hex").slice(0, 12);

  return {
    version,
    size: words.size,
    get: (folded) => words.get(folded),
    byKey: (key) => keyIndex.get(key) ?? [],
    byBucket: (first, length) => bucketIndex.get(`${first}:${length}`) ?? [],
    byPhoneticBucket: (first, length) => phoneticBucketIndex.get(`${first}:${length}`) ?? [],
    hasBigram: (left, right) => bigrams.has(`${left} ${right}`),
  };
}

/** En sik gorunen bicim; ikinci bicim de en az 1/3 sikliktaysa belirsizdir (null). */
export function dominantDisplay(word: VocabularyWord): string | null {
  const ranked = [...word.displays.entries()].sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  if (!first) return null;
  if (second && second[1] * 3 > first[1]) return null;
  return first[0];
}
