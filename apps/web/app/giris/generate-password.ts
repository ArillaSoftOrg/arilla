/**
 * "Güçlü şifre oluştur": tarayıcıda, `crypto.getRandomValues` ile üretilir.
 * Şifre sunucuya, loga ya da analitiğe gitmez; bu dosya ağa/depoya dokunmaz.
 * Çıktı backend politikasını (`checkPasswordPolicy`: 10..128 karakter, yaygın
 * şifre listesi dışı) her zaman karşılar: 20 karakter, dört sınıftan en az biri,
 * karıştırılabilen karakterler (0/O, 1/l/I) çıkarılmış, e-posta adresiyle ilgisiz.
 */
export const GENERATED_PASSWORD_LENGTH = 20;

const LOWER = "abcdefghijkmnpqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+?";
const CLASSES = [LOWER, UPPER, DIGITS, SYMBOLS] as const;
const ALL = CLASSES.join("");

export type RandomSource = (array: Uint32Array) => Uint32Array;

const defaultSource: RandomSource = (array) => globalThis.crypto.getRandomValues(array);

/** [0, max) aralığında tekdüze tam sayı (modulo yanlılığı olmadan: reddetmeli örnekleme). */
export function randomBelow(max: number, source: RandomSource = defaultSource): number {
  if (!Number.isInteger(max) || max < 1 || max > 0x1_0000_0000) {
    throw new RangeError("randomBelow: max 1..2^32 aralığında tam sayı olmalı");
  }
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    const value = source(buffer)[0] ?? 0;
    if (value < limit) return value % max;
  }
}

export function generatePassword(
  length: number = GENERATED_PASSWORD_LENGTH,
  source: RandomSource = defaultSource,
): string {
  if (length < CLASSES.length) throw new RangeError("generatePassword: uzunluk çok kısa");
  // Her sınıftan bir karakter garanti edilir, kalanı tüm havuzdan gelir.
  const chars: string[] = CLASSES.map((set) => set[randomBelow(set.length, source)] as string);
  while (chars.length < length) chars.push(ALL[randomBelow(ALL.length, source)] as string);
  // Fisher-Yates: garanti edilen karakterlerin konumu da rastgele olur.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1, source);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join("");
}
