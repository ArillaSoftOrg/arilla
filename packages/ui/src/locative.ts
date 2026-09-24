/**
 * docs/copy.md `action.open_at_merchant`: "{mağaza}'da aç". Türkçede bulunma
 * eki ünlü uyumu (-da/-de) ve ünsüz benzeşmesiyle (-ta/-te) değişir;
 * "Boyner'da aç" yanlış, "Boyner'de aç" doğrudur. Sunum katmanında kalan,
 * yaklaşık bir okunuş kuralıdır - yabancı adlar ("Nike" = "nayki") yazıma
 * göre çekimlenir.
 */

const BACK_VOWELS = "aıou";
const FRONT_VOWELS = "eiöü";
/** Fıstıkçı Şahap: sert ünsüzden sonra ek "t" ile başlar. */
const HARD_CONSONANTS = "çfhkpsşt";

/** Son rakamın okunuşuna göre ek: 1 "bir" -> 'de, 3 "üç" -> 'te ... */
const DIGIT_SUFFIX: Record<string, string> = {
  "1": "'de",
  "2": "'de",
  "3": "'te",
  "4": "'te",
  "5": "'te",
  "6": "'da",
  "7": "'de",
  "8": "'de",
  "9": "'da",
};

/** Sıfırla biten sayılar onlar basamağıyla okunur: 10 "on", 40 "kırk" ... */
const TENS_SUFFIX: Record<string, string> = {
  "0": "'da",
  "1": "'da",
  "2": "'de",
  "3": "'da",
  "4": "'ta",
  "5": "'de",
  "6": "'ta",
  "7": "'te",
  "8": "'de",
  "9": "'da",
};

function lowerTr(value: string): string {
  return value.toLocaleLowerCase("tr-TR");
}

function suffixForWord(word: string): string {
  // Kısaltma (H&M, LCW): harf adıyla okunur - çoğu "-e" ile biter ("me",
  // "ve"), yalnızca X "iks" sert ünsüzle biter.
  const letters = word.replace(/[^\p{L}]/gu, "");
  const last = word.at(-1) ?? "";
  const isAbbreviation =
    letters.length > 0 &&
    letters.length <= 4 &&
    letters === letters.toLocaleUpperCase("tr-TR") &&
    letters !== lowerTr(letters);
  const lastLower = lowerTr(last);
  if (isAbbreviation && !BACK_VOWELS.includes(lastLower) && !FRONT_VOWELS.includes(lastLower)) {
    return lastLower === "x" ? "'te" : "'de";
  }

  // Tamamı büyük harfli yabancı ad ("SHEIN"): "I" Türkçe "ı" değil "i" okunur.
  const lower = letters === letters.toUpperCase() ? word.toLowerCase() : lowerTr(word);
  let vowel = "";
  for (let index = lower.length - 1; index >= 0; index -= 1) {
    const char = lower[index] ?? "";
    if (BACK_VOWELS.includes(char) || FRONT_VOWELS.includes(char)) {
      vowel = char;
      break;
    }
  }
  const harmony = FRONT_VOWELS.includes(vowel) ? "e" : "a";
  const consonant = HARD_CONSONANTS.includes(lower.at(-1) ?? "") ? "t" : "d";
  return `'${consonant}${harmony}`;
}

/** "Trendyol" -> "Trendyol'da", "Boyner" -> "Boyner'de", "N11" -> "N11'de". */
export function withLocativeSuffix(name: string): string {
  const trimmed = name.trim().replace(/[^\p{L}\p{N}]+$/u, "");
  if (trimmed.length === 0) return name;

  const lastChar = trimmed.at(-1) ?? "";
  if (/\d/.test(lastChar)) {
    if (lastChar === "0") {
      const digits = trimmed.match(/\d+$/)?.[0] ?? "0";
      if (/^0+$/.test(digits)) return `${trimmed}'da`;
      if (digits.endsWith("00")) return `${trimmed}'de`; // yüz, bin -> 'de
      return `${trimmed}${TENS_SUFFIX[digits.at(-2) ?? "0"] ?? "'da"}`;
    }
    return `${trimmed}${DIGIT_SUFFIX[lastChar] ?? "'de"}`;
  }

  const words = trimmed.split(/\s+/);
  const lastWord = words.at(-1) ?? trimmed;
  return `${trimmed}${suffixForWord(lastWord)}`;
}
