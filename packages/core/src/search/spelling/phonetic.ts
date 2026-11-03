/**
 * Fonetik bicim ve anahtar (karar 0172). Turkce kullanicinin yabanci urun/marka adlarini
 * kulaga gore yazmasini ("blutut", "ayfon", "zamzung", "hedfon") ayni bicime indirger.
 *
 * Girdi KATLANMIS metindir (`foldForMatch`: Turkce kucuk harf + ASCII). Kurallar kucuk ve
 * genel ses denklikleridir; belirli bir kelimeye ozel kural yazilmaz. Anahtar yalnizca ADAY
 * uretir; kabul karari mesafe ve guvenle verilir (`correct.ts`).
 */

/** Sirali yeniden yazma kurallari: uzun/ozel dizi once. */
const REWRITES: readonly (readonly [RegExp, string])[] = [
  [/sch/g, "s"], // bosch -> bos
  [/ph/g, "f"], // iphone, philips, headphone
  [/th/g, "t"], // bluetooth
  [/ck/g, "k"],
  [/ch/g, "k"], // logitech, tech
  [/sh/g, "s"],
  [/q/g, "k"],
  [/w/g, "v"], // wireless, huawei, powerbank
  [/^x(?=[aeiou])/, "s"], // cince x = s: xiaomi
  [/x/g, "ks"], // galaxy, xbox
  [/c(?=[eiy])/g, "s"], // ingilizce yumusak c: mercedes, cell
  [/c/g, "k"], // casio, case
  [/z/g, "s"], // zamzung, adidaz
  [/y$/, "i"], // sondaki ingilizce y = i: sony/soni, galaxy/galaksi
  [/([^aeiou])i([^aeiou])e$/, "$1ai$2"], // ingilizce sessiz e: nike = naik
  [/([^aeiou])e$/, "$1"], // sondaki sessiz e: mouse = maus, phone = fon
  [/ay(?![aeiou])/g, "i"], // ingilizce i = "ay": iphone/ayfon, wireless/vayrlis
  [/air/g, "er"], // airpods/erpods
  [/ee/g, "i"],
  [/ou/g, "au"], // mouse = maus
  [/(oo|ue)/g, "u"], // bluetooth
];

/** Fonetik yeniden yazilmis bicim; unluler korunur, cift harf teklesir. */
export function phoneticForm(folded: string): string {
  let out = folded;
  for (const [pattern, replacement] of REWRITES) out = out.replace(pattern, replacement);
  return out.replace(/(.)\1+/g, "$1");
}

const VOWELS = /[aeiouy]/g;

/**
 * Iskelet anahtari: ilk harf + unsuzler (y unlu sayilir), ardisik tekrar teklesir.
 * "blutut" = "bluetooth" = "blt", "leptop" = "laptop" = "lptp".
 */
export function phoneticKey(folded: string): string {
  const form = phoneticForm(folded);
  if (form.length === 0) return "";
  const head = form[0] as string;
  const rest = form.slice(1).replace(VOWELS, "");
  return `${head}${rest}`.replace(/(.)\1+/g, "$1");
}
