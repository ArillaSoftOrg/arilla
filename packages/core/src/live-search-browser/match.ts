/**
 * Katı baslik eslestirme. Magazanin siralamasina guvenilmez; canli testlerde
 * (2026-10-12) gorulen hatalar burada kural olarak durur:
 *  - CicekSepeti "iPhone 16 Pro 128 GB" -> iPhone 17; "Sony WH-1000XM5" -> kulaklik pedi.
 *  - Hepsiburada "Sony WH-1000XM5" -> "Sony Ult Wear ... WH-1000XM5 ile Ayni Islemci".
 *  - "PlayStation 5" -> oyun ("EA SPORTS FC 27 Playstation 5"), kol, sarj istasyonu.
 *  - "Dyson V15" -> filtre, batarya, boru.
 */

const TR_FOLD: Record<string, string> = {
  ı: "i",
  İ: "i",
  ç: "c",
  Ç: "c",
  ğ: "g",
  Ğ: "g",
  ö: "o",
  Ö: "o",
  ş: "s",
  Ş: "s",
  ü: "u",
  Ü: "u",
};
const VARIANT_WORDS = new Set(["max", "plus", "mini", "ultra", "pro", "air", "se", "fe", "lite"]);
/** Onekle eslesen aksesuar/yedek parca kokleri (Turkce ekler: "kilifi", "filtresi"). */
const ACCESSORY_STEMS = [
  "uyumlu",
  "kilif",
  "kapak",
  "koruyucu",
  "cam",
  "film",
  "ped",
  "sunger",
  "case",
  "cover",
  "sarj",
  "filtre",
  "batarya",
  "boru",
  "yedek",
  "aparat",
  "hazne",
  // "basli": "baslik" / "basligi" (k -> g yumusamasi).
  "basli",
  "firca",
  "emici",
];
/** Urun durumu: sorguda istenmedikce sifir urunle karistirilmaz ("PlayStation 5 ... (IKINCI EL)"). */
const CONDITION_STEMS = ["ikinci", "yenilenmis", "teshir", "outlet", "kullanilmis"];
/**
 * Yalnizca tam sozcuk olarak aksesuar sayilanlar. "kol" BILEREK yok: giyimde
 * "Balon Kol", "Sifir Kol" yen demektir (canli test, CicekSepeti elbise).
 */
const ACCESSORY_WORDS = new Set(["controller", "gamepad", "joystick", "kumanda", "fiziki"]);
/** Katlanmis (ı->i, ü->u) yaygin Turkce ekler: iyelik, cogul, belirtme, yonelme, bulunma. */
const TR_SUFFIXES = new Set([
  "i",
  "u",
  "si",
  "su",
  "in",
  "un",
  "nin",
  "nun",
  "ler",
  "lar",
  "leri",
  "lari",
  "lerin",
  "larin",
  "de",
  "da",
  "te",
  "ta",
  "den",
  "dan",
  "ye",
  "ya",
  "yi",
  "yu",
]);
/** Model kodu/sayi iceren sorgu sozcugu baslikta ilk bu kadar sozcuk icinde olmali. */
const CODE_WINDOW = 6;

export function tokenize(text: string): string[] {
  return text
    .replace(/[ıİçÇğĞöÖşŞüÜ]/g, (c) => TR_FOLD[c] ?? c)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\b(\d+)\s+(gb|tb)\b/g, "$1$2")
    .split(" ")
    .filter(Boolean);
}

/**
 * Aksesuar kokuyle baslayan ama urunun KENDI niteligi olan sozcukler. Canli (Faz 3):
 * "Dyson V15 Detect Kablosuz Sarjli Dikey Supurge" "sarj" kokuyle aksesuar sayilip
 * eleniyordu (Dyson V15 sifir sonucunun nedeni).
 */
const PRODUCT_ATTRIBUTE_WORDS = new Set(["sarjli", "sarjsiz"]);

export const isAccessory = (tok: string) =>
  !PRODUCT_ATTRIBUTE_WORDS.has(tok) &&
  (ACCESSORY_WORDS.has(tok) || ACCESSORY_STEMS.some((s) => tok.startsWith(s)));

/** Sorgu sozcugunun baslikta bulundugu ilk konum; yoksa -1. Bitisik ikiliyi de tanir. */
function positionOf(
  t: string[],
  tok: string,
  next: string | undefined,
): { at: number; used: number } {
  for (let i = 0; i < t.length; i++) {
    const cur = t[i] as string;
    if (cur === tok) return { at: i, used: 1 };
    // "wh" + "1000xm5" sorgusu, baslikta bitisik "wh1000xm5" olarak.
    if (next && cur === `${tok}${next}`) return { at: i, used: 2 };
  }
  // Turkce ek: "elbise" -> "elbisesi". Yalnizca harf, en az 4 karakterli sozcukte ve kalan kisim
  // gercek bir Turkce ek ise eslesir (Faz 3 canli: "Sambae" ayri bir modeldir, "Samba" degil).
  // Sayi/model kodu (128gb, xm5) her zaman tam eslesmelidir.
  if (tok.length >= 4 && /^[a-z]+$/.test(tok)) {
    const i = t.findIndex((x) => x.startsWith(tok) && TR_SUFFIXES.has(x.slice(tok.length)));
    if (i >= 0) return { at: i, used: 1 };
  }
  return { at: -1, used: 1 };
}

export function matchesQuery(title: string, query: string): boolean {
  const q = tokenize(query);
  const t = tokenize(title);
  if (q.length === 0) return false;
  const qset = new Set(q);

  for (let i = 0; i < q.length; i++) {
    const tok = q[i] as string;
    const { at, used } = positionOf(t, tok, q[i + 1]);
    if (at < 0) return false;
    // Model kodu/sayi baslik basinda olmali: "... WH-1000XM5 ile ayni islemci" elenir.
    if (/\d/.test(tok) && at >= CODE_WINDOW) return false;
    i += used - 1;
  }
  // Varyant kurali yalnizca model sorgularinda: "iPhone 16" Max'i dislar, ama
  // "Siyah kadin elbise" icin "Mini Elbise" bir kesimdir, varyant degil.
  const isModelQuery = q.some((tok) => /\d/.test(tok));
  if (isModelQuery && t.some((tok) => VARIANT_WORDS.has(tok) && !qset.has(tok))) return false;

  const isCondition = (tok: string) => CONDITION_STEMS.some((s) => tok.startsWith(s));
  if (!q.some(isCondition) && t.some(isCondition)) return false;

  if (listsCompatibleModels(t, q)) return false;

  // Aksesuar kontrolu yalnizca ana urun kisminda: "+ 2. kol", "+ sarj istasyonu" paketin ekidir.
  const main = tokenize(title.split("+")[0] ?? title);
  const wantsAccessory = q.some(isAccessory);
  return wantsAccessory || !main.some(isAccessory);
}

/**
 * Uyumluluk listesi: sorgudaki harfle baslayan model kodunun ailesinden ("v15" -> "v")
 * baslikta en az 3 FARKLI kod varsa urun coklu modele uyan bir aksesuardir
 * ("Dyson V15s, V15, V11, V10 ve V8 Icin Temizlik Seti"). Rakamla baslayan kodlar
 * (iPhone "16", "128gb", "5g") bu kurala girmez; telefon basliklari etkilenmez.
 */
const COMPAT_MIN_CODES = 3;

function listsCompatibleModels(titleTokens: string[], queryTokens: string[]): boolean {
  for (const qt of queryTokens) {
    const m = /^([a-z]+)\d+[a-z]*$/.exec(qt);
    if (!m) continue;
    const family = new RegExp(`^${m[1]}\\d+[a-z]*$`);
    const codes = new Set(titleTokens.filter((tok) => family.test(tok)));
    if (codes.size >= COMPAT_MIN_CODES) return true;
  }
  return false;
}

/** Baslik ana urune ek parca iceriyor mu ("PS5 Slim + 2. kol"). Arayuzde "paket" etiketi icin. */
export function isBundleTitle(title: string): boolean {
  return /\s\+\s?\S|\+\s?\d/.test(title);
}
