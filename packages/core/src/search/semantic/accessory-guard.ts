/**
 * Aksesuarin ana urun gibi gosterilmesini onleme ve acik renk zorunlulugu (karar 0170).
 *
 * Gercek katalogda ("akıllı saat", "süpürge", "kulaklık") sonuclarin buyuk cogunlugu CIHAZIN aksesuari
 * ya da yedek parcasidir (kilif, kayis, sarj kablosu, pil, filtre...). Kullanici aksesuar istemiyorsa:
 * - anlamsal-yalniz aday aksesuarsa alinmaz;
 * - metin sonucu aksesuarsa siralamada asagi cekilir (silinmez: siniflandirma yanilabilir).
 * Kullanici aksesuar istiyorsa ("telefon kılıfı", "kulaklık standı", "araba ...") hicbir sey uygulanmaz.
 *
 * Saf fonksiyonlar; SQL/model yok. Pilot dalindaki Python etiketleme kurallari
 * (`services/ingest/semantic_pilot/real_queries.py`) ayni kalibi kullanir.
 */
import { foldForMatch } from "../text-match.ts";

const ACCESSORY_NOUN =
  "case|cases|cover|covers|strap|straps|band|bands|bracelet|charger|charging|cable|cord|battery|batteries|adapter|adaptor|protector|film|tempered|replacement|spare|parts?|dock|stand|holder|mount|sleeve|pouch|ear ?pads?|earpads?|cushions?|ear ?tips?|filter|filters|hose|skin|sticker|keycaps?|propellers?|screen|glass|bag|brush|lanyard|hook|stylus|remote";

const ACCESSORY_FOR = new RegExp(
  `\\b(?:${ACCESSORY_NOUN})\\b.{0,70}\\b(?:for|compatible|fits?|fit for|suitable for|replacement for)\\b|^(?:replacement|spare|original)\\b|\\b(?:replacement|spare)\\b.{0,25}\\b(?:parts?|battery|pads?)\\b`,
);
const ACCESSORY_ANY =
  /\baccessor(?:y|ies)\b|\bstorage bag\b|\btest probe\b|\bpower supply\b|\brepair\b|\bspare\b|\breplacement\b|\bparts?\b|\bpower adapter\b/;

/** Baslik, bir cihazin aksesuari/yedek parcasi gibi mi gorunuyor? */
export function looksLikeAccessory(title: string): boolean {
  const folded = title.toLowerCase();
  return ACCESSORY_FOR.test(folded) || ACCESSORY_ANY.test(folded);
}

/**
 * Sorgu aksesuar/parca mi istiyor? Evet ise koruma uygulanmaz. Arac ("araba", "car") sorgulari da
 * aksesuar alanidir (katalogdaki arac urunleri parca/aksesuardir).
 */
const WANTS_ACCESSORY = new RegExp(
  [
    "\\bkilif",
    "\\bcases?\\b",
    "\\bcovers?\\b",
    "\\bkayis",
    "\\bstraps?\\b",
    "\\bband\\b",
    "bilezik",
    "\\bsarj\\b|sarj (cihaz|alet|kablo|adaptor)",
    "charger",
    "charging",
    "\\bkablo\\b|\\bkablolar",
    "\\bcables?\\b",
    "\\bpil\\b",
    "batarya",
    "battery",
    "adaptor",
    "adapter",
    "koruyucu",
    "protector",
    "\\bfilm\\b",
    "\\byedek",
    "replacement",
    "spare",
    "\\bparca",
    "\\bparts?\\b",
    "\\bstand",
    "\\btutucu",
    "\\bholders?\\b",
    "\\bmounts?\\b",
    "askilik",
    "\\bped",
    "\\bpad",
    "\\bfiltre",
    "\\bfilters?\\b",
    // Yedek parca isimleri (TR iyelik ekiyle: "dizustu bilgisayar pili", "yazici nozulu").
    "\\bpil(i|ler|leri)\\b",
    "\\bnozzles?\\b",
    "\\bnozul",
    "firca",
    "brush",
    "aksesuar",
    "accessor",
    "\\blens",
    "\\barac\\b|\\barac ",
    "\\baraba",
    "otomobil",
    "oto ",
    "\\bcars?\\b",
    "\\bauto\\b",
    "vehicle",
  ].join("|"),
);

export function queryWantsAccessory(query: string): boolean {
  return WANTS_ACCESSORY.test(foldForMatch(query));
}

/**
 * Metin yolu icin aksesuar/yedek parca baslik deseni (POSIX, katlanmis baslik; karar 0197).
 *
 * Ana cihaz sorgusu ("iphone 15", "kamera", "robot supurge") metin kapisindan gecen aksesuarlarla
 * (kilif, kablo, ekran koruyucu...) dolar: aksesuar ucuzdur, fiyat carpani onu one cikarir.
 * Burada YALNIZ belirgin aksesuar ifadeleri vardir; baska urun turlerinde ana urun adi olan
 * kelimeler yoktur ("koruyucu", "skin", "kayis", "strap", "sticker", "tutucu", "yedek", "case", "holder").
 * Kategori yolu sinyali KULLANILMAZ: "aksesuar" uretimde moda kokudur (aksesuar/canta, moda/aksesuar/saat). Sonuc eleme degil sira kademesidir (once ana urun, sonra aksesuar; kademe ici mevcut skor): yanlis siniflanan dogru urun
 * kaybolmaz, sadece alta iner. Sorgu aksesuar/parca istiyorsa `null` (hicbir sey uygulanmaz).
 */
const STRONG_ACCESSORY_TITLE = [
  "kilif[a-z]*",
  "(phone|silicone|silikon|clear|transparent|shockproof|magnetic|protective|flip) (case|cover)s?",
  "ekran koruyucu[a-z]*|ekran koruma|screen protectors?",
  "temperli cam (ekran|koruyucu)|tempered glass (screen|protector)",
  "kablo[a-z]*|cables?",
  "charger[a-z]*|sarj (aleti|cihazi|kablo[a-z]*|adaptor[a-z]*|istasyon[a-z]*)",
  "adaptor[a-z]*|adapters?",
  "telefon tutucu[a-z]*|(phone|car) holders?",
  "yedek parca[a-z]*|replacement|spare",
  "aksesuar[a-z]*|accessor[a-z]*",
].join("|");
export const ACCESSORY_TITLE_PATTERN = `(^|[^a-z0-9])(${STRONG_ACCESSORY_TITLE})($|[^a-z0-9])`;

/**
 * Sira kademesi deseni; `null` = uygulanmaz. Acik kullanici niyeti (sorguda aksesuar/parca sozu)
 * ve dogrulanmis model rolu (`accessory`/`part`) aksesuar istendigini gosterir. Model rolu yalniz
 * sozel olarak sessiz kalan sorguda etkilidir; acik soz her zaman onceliklidir.
 */
export function accessoryTitleDemotionPattern(
  query: string,
  role?: "main" | "accessory" | "part" | null,
): string | null {
  if (queryWantsAccessory(query) || role === "accessory" || role === "part") return null;
  return foldForMatch(query).trim() === "" ? null : ACCESSORY_TITLE_PATTERN;
}

/** Acikca belirtilen renk (TR/EN) -> basliktaki esdeger yuzeyler. Anlamsal-yalniz aday bunlardan birini tasimali. */
const COLOR_GROUPS: readonly (readonly string[])[] = [
  ["kirmizi", "red", "crimson", "burgundy", "bordo", "wine red"],
  ["siyah", "black"],
  ["beyaz", "white"],
  ["mavi", "blue", "navy", "lacivert"],
  ["yesil", "green"],
  ["pembe", "pink", "rose"],
  ["gri", "grey", "gray"],
  ["sari", "yellow"],
  ["mor", "purple", "violet"],
  ["kahverengi", "brown"],
  ["turuncu", "orange"],
  ["altin", "gold", "golden"],
  ["gumus", "silver"],
];

/** Sorguda renk varsa, baslik katlanmis metne uygulanacak POSIX regex (yoksa null). */
export function requiredColorPattern(query: string): string | null {
  const tokens = new Set(foldForMatch(query).split(/[^a-z0-9]+/));
  const groups = COLOR_GROUPS.filter((group) =>
    group.some((surface) => !surface.includes(" ") && tokens.has(surface)),
  );
  if (groups.length === 0) return null;
  const alternatives = groups.flat().map((surface) => surface.replace(/[^a-z0-9 ]/g, ""));
  return `(^|[^a-z0-9])(${alternatives.join("|")})($|[^a-z0-9])`;
}
