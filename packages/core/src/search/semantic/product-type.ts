/**
 * Urun turu zorunlulugu (karar 0170): sorgudaki BAS ISIM (Turkcede son kelime) bilinen bir urun turuyse,
 * anlamsal-yalniz adayin basligi o turun Ingilizce/Turkce karsiligini tasimali. Boylece "kirmizi sort"
 * sorgusu yalnizca vektor benzerligi yuksek diye tisort ya da bardak getirmez.
 *
 * Yalnizca anlamsal-yalniz adaylara uygulanir (metin sonuclarinin kendi kapisi vardir). Tur bilinmiyorsa
 * hicbir sey zorunlu degildir (bilinmeyen sorgu anlamsal kesfi kapatmaz). Sozluk ELLE bakilir ve
 * genisletilebilir bir baslangictir; kapsami olculerek buyutulur (bkz. karar 0170).
 */
import { foldForMatch } from "../text-match.ts";

interface ProductType {
  id: string;
  /** Katlanmis sorgu belirteci bu on eklerden biriyle basliyorsa eslesir (Turkce cekim). */
  stems?: readonly string[];
  /** Katlanmis sorgu belirteci bunlardan birine esitse eslesir (Ingilizce). */
  words?: readonly string[];
  /** Katlanmis basliga uygulanan POSIX regex govdesi (alternatifler). */
  title: string;
}

/** Cok sozcuklu ifadeler once denenir ("bebek arabasi" = stroller, "araba" degil). */
const PHRASES: readonly { phrase: string; id: string; title: string }[] = [
  { phrase: "bebek araba", id: "stroller", title: "strollers?|prams?|pushchairs?|bebek arab" },
  { phrase: "baby stroller", id: "stroller", title: "strollers?|prams?|pushchairs?" },
  { phrase: "sirt canta", id: "backpack", title: "backpacks?|rucksacks?|sirt canta" },
  { phrase: "akilli saat", id: "smartwatch", title: "smart ?watch|akilli saat" },
  { phrase: "smart watch", id: "smartwatch", title: "smart ?watch" },
  { phrase: "kot pantolon", id: "jeans", title: "jeans|denim|kot pantolon" },
  {
    phrase: "oyuncak araba",
    id: "toycar",
    title: "toy cars?|rc cars?|diecast|die-cast|car model|oyuncak araba",
  },
  { phrase: "yoga mat", id: "yogamat", title: "yoga mats?|yoga mat" },
  { phrase: "gunes gozluk", id: "sunglasses", title: "sunglasses|gunes gozluk" },
];

const TYPES: readonly ProductType[] = [
  {
    id: "headphone",
    stems: ["kulaklik", "kulakl"],
    words: [
      "headphone",
      "headphones",
      "headset",
      "headsets",
      "earphone",
      "earphones",
      "earbud",
      "earbuds",
    ],
    title: "headphones?|headsets?|earphones?|earbuds?|earpods?|airpods?|kulakl",
  },
  { id: "watch", stems: ["saat"], words: ["watch", "watches", "smartwatch"], title: "watch|saat" },
  { id: "shorts", stems: ["sort"], words: ["shorts"], title: "shorts|short pants|sort" },
  {
    id: "tshirt",
    stems: ["tisort", "tshirt"],
    words: ["tshirt", "tshirts", "tee", "tees", "shirt"],
    title: "t-?shirts?|tees?|tisort|shirt",
  },
  { id: "dress", stems: ["elbise"], words: ["dress", "dresses"], title: "dress|gown|elbise" },
  {
    id: "pants",
    stems: ["pantolon"],
    words: ["pants", "trousers", "leggings"],
    title: "pants|trousers|leggings|jeans|pantolon",
  },
  {
    id: "shoes",
    stems: ["ayakkabi", "sneaker", "terlik", "sandalet"],
    words: ["shoes", "shoe", "sneakers", "boots", "sandals", "trainers"],
    title: "shoes?|sneakers?|boots?|sandals?|trainers|loafers|slippers|ayakkabi",
  },
  {
    id: "bag",
    stems: ["canta"],
    words: ["bag", "bags", "handbag", "backpack", "tote", "purse"],
    title: "bags?|backpacks?|handbags?|purse|tote|satchel|canta",
  },
  { id: "wallet", stems: ["cuzdan"], words: ["wallet", "wallets"], title: "wallets?|cuzdan" },
  {
    id: "glasses",
    stems: ["gozluk"],
    words: ["glasses", "sunglasses", "eyewear"],
    title: "glasses|sunglasses|eyewear|gozluk",
  },
  {
    id: "necklace",
    stems: ["kolye"],
    words: ["necklace", "pendant"],
    title: "necklaces?|pendants?|kolye",
  },
  { id: "earring", stems: ["kupe"], words: ["earring", "earrings"], title: "earrings?|kupe" },
  { id: "ring", stems: ["yuzuk"], words: ["ring", "rings"], title: "rings?|yuzuk" },
  {
    id: "bracelet",
    stems: ["bileklik"],
    words: ["bracelet", "bangle"],
    title: "bracelets?|bangles?|wristbands?|bileklik",
  },
  {
    id: "phone",
    stems: ["telefon"],
    words: ["phone", "smartphone", "iphone"],
    title: "phones?|smartphones?|iphone|telefon",
  },
  {
    id: "case",
    stems: ["kilif"],
    words: ["case", "cases", "cover", "covers"],
    title: "cases?|covers?|pouch|kilif",
  },
  {
    id: "laptop",
    stems: ["dizustu", "laptop", "bilgisayar", "notebook"],
    words: ["laptop", "laptops", "notebook", "computer"],
    title: "laptops?|notebooks?|computers?|bilgisayar",
  },
  { id: "tablet", stems: ["tablet"], words: ["tablet", "tablets"], title: "tablets?" },
  {
    id: "keyboard",
    stems: ["klavye"],
    words: ["keyboard", "keyboards"],
    title: "keyboards?|klavye",
  },
  { id: "mouse", stems: ["fare"], words: ["mouse", "mice"], title: "mouse|mice|fare" },
  {
    id: "speaker",
    stems: ["hoparlor"],
    words: ["speaker", "speakers", "soundbar"],
    title: "speakers?|soundbar|hoparlor",
  },
  { id: "vacuum", stems: ["supurge"], words: ["vacuum"], title: "vacuum|supurge" },
  { id: "blender", stems: ["blender"], words: ["blender"], title: "blenders?|mixers?" },
  { id: "coffee", stems: ["kahve"], words: ["coffee"], title: "coffee|kahve" },
  {
    id: "bottle",
    stems: ["termos", "matara"],
    words: ["thermos", "bottle", "tumbler", "flask"],
    title: "thermos|bottles?|tumblers?|flasks?|termos|matara",
  },
  {
    id: "lamp",
    stems: ["lamba", "aydinlatma"],
    words: ["lamp", "light", "lighting"],
    title: "lamps?|lights?|lighting|led|lamba|aydinlatma",
  },
  {
    id: "charger",
    stems: ["sarj"],
    words: ["charger", "powerbank"],
    title: "chargers?|charging|power ?banks?|sarj",
  },
  { id: "cable", stems: ["kablo"], words: ["cable", "cord"], title: "cables?|cords?|wires?|kablo" },
  {
    id: "rug",
    stems: ["hali", "kilim"],
    words: ["rug", "carpet"],
    title: "rugs?|carpets?|hali|kilim",
  },
  {
    id: "curtain",
    stems: ["perde"],
    words: ["curtain", "curtains"],
    title: "curtains?|drapes?|perde",
  },
  {
    id: "pillow",
    stems: ["yastik"],
    words: ["pillow", "cushion"],
    title: "pillows?|cushions?|yastik",
  },
  {
    id: "bedding",
    stems: ["nevresim", "carsaf"],
    words: ["bedding", "duvet"],
    title: "bedding|duvet|quilt|bed ?sheets?|comforter|nevresim|carsaf",
  },
  { id: "blanket", stems: ["battaniye"], words: ["blanket"], title: "blankets?|throws?|battaniye" },
  {
    id: "toy",
    stems: ["oyuncak"],
    words: ["toy", "toys", "doll", "plush"],
    title: "toys?|dolls?|plush|figures?|building blocks?|oyuncak",
  },
  {
    id: "car",
    stems: ["araba", "otomobil"],
    words: ["car", "cars", "automobile", "vehicle"],
    title: "cars?|autos?|automotive|automobile|vehicles?|araba|otomobil",
  },
  {
    id: "bike",
    stems: ["bisiklet"],
    words: ["bike", "bicycle"],
    title: "bikes?|bicycles?|cycling|bisiklet",
  },
  { id: "drone", stems: ["drone"], words: ["drone"], title: "drones?|quadcopter" },
  {
    id: "camera",
    stems: ["kamera"],
    words: ["camera", "webcam"],
    title: "cameras?|cam|camcorder|webcam|kamera",
  },
  {
    id: "perfume",
    stems: ["parfum"],
    words: ["perfume", "fragrance", "cologne"],
    title: "perfumes?|fragrances?|colognes?|eau de|parfum",
  },
  { id: "shampoo", stems: ["sampuan"], words: ["shampoo"], title: "shampoo|sampuan" },
  {
    id: "cream",
    stems: ["krem"],
    words: ["cream", "lotion", "serum"],
    title: "cream|lotion|serum|moisturi|krem",
  },
  {
    id: "makeup",
    stems: ["makyaj"],
    words: ["makeup", "lipstick", "mascara"],
    title: "makeup|lipstick|mascara|eyeshadow|foundation|makyaj",
  },
  {
    id: "dumbbell",
    stems: ["dambil"],
    words: ["dumbbell", "kettlebell"],
    title: "dumbbells?|kettlebells?|dambil",
  },
  {
    id: "tv",
    stems: ["televizyon"],
    words: ["tv", "television", "monitor"],
    title: "tv|television|monitor|televizyon",
  },
  { id: "printer", stems: ["yazici"], words: ["printer"], title: "printers?|yazici" },
  {
    id: "microphone",
    stems: ["mikrofon"],
    words: ["microphone", "mic"],
    title: "microphones?|mics?|mikrofon",
  },
  {
    id: "chair",
    stems: ["sandalye"],
    words: ["chair", "stool"],
    title: "chairs?|stools?|sandalye",
  },
  { id: "desk", stems: ["masa"], words: ["desk", "table"], title: "desks?|tables?|masa" },
  { id: "tent", stems: ["cadir"], words: ["tent"], title: "tents?|cadir" },
  {
    id: "hat",
    stems: ["sapka", "bere"],
    words: ["hat", "cap", "beanie"],
    title: "hats?|caps?|beanies?|sapka|bere",
  },
  { id: "gloves", stems: ["eldiven"], words: ["gloves", "glove"], title: "gloves?|eldiven" },
  { id: "socks", stems: ["corap"], words: ["socks"], title: "socks?|corap" },
  {
    id: "swimwear",
    stems: ["mayo", "bikini"],
    words: ["swimsuit", "bikini", "swimwear"],
    title: "swimsuits?|bikini|swimwear|swim ?trunks|mayo",
  },
  {
    id: "jacket",
    stems: ["ceket", "mont", "kaban"],
    words: ["jacket", "coat", "parka"],
    title: "jackets?|coats?|parkas?|blazers?|puffer|ceket|mont|kaban",
  },
  {
    id: "sweater",
    stems: ["kazak", "hirka"],
    words: ["sweater", "hoodie", "pullover"],
    title: "sweaters?|hoodies?|pullovers?|jumpers?|cardigans?|knit|kazak|hirka",
  },
  { id: "skirt", stems: ["etek"], words: ["skirt"], title: "skirts?|etek" },
  {
    id: "scarf",
    stems: ["atki", "esarp"],
    words: ["scarf", "shawl"],
    title: "scarf|scarves|shawls?|atki|esarp",
  },
  { id: "belt", stems: ["kemer"], words: ["belt"], title: "belts?|kemer" },
];

interface Match {
  index: number;
  title: string;
}

/**
 * Desen: Ingilizce alternatifler tam sozcuk, Turkce govde alternatifleri (stems ile baslayan) govde+ek.
 * Basliga "short sleeve" gibi yanlis kabul ve "ringtone" gibi alt-dize eslesmesi girmez.
 */
function titlePattern(title: string, stems: readonly string[]): string {
  const alternatives = title.split("|").map((alt) => {
    const turkish = stems.some((stem) => alt.startsWith(stem) || stem.startsWith(alt));
    return turkish && /^[a-z ]+$/.test(alt) ? `${alt}[a-z]*` : alt;
  });
  return `(^|[^a-z0-9])(${alternatives.join("|")})($|[^a-z0-9])`;
}

/** Sorgunun bas isim turune ait baslik deseni (katlanmis basliga uygulanir); tur bilinmiyorsa null. */
export function requiredTypePattern(query: string): string | null {
  const folded = foldForMatch(query)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (folded === "") return null;
  const tokens = folded.split(" ");

  const matches: Match[] = [];
  const consumed = new Set<number>();
  for (const { phrase, title } of PHRASES) {
    const words = phrase.split(" ");
    for (let i = 0; i + words.length <= tokens.length; i += 1) {
      const hit = words.every((word, offset) => {
        const token = tokens[i + offset] as string;
        return offset === words.length - 1 ? token.startsWith(word) : token === word;
      });
      if (hit && !words.some((_, offset) => consumed.has(i + offset))) {
        for (let offset = 0; offset < words.length; offset += 1) consumed.add(i + offset);
        matches.push({ index: i + words.length - 1, title: titlePattern(title, words) });
      }
    }
  }
  tokens.forEach((token, index) => {
    if (consumed.has(index) || token.length < 3) return;
    const type = TYPES.find(
      (t) =>
        t.words?.includes(token) ||
        t.stems?.some((stem) => token.startsWith(stem) && stem.length >= 4),
    );
    if (type) matches.push({ index, title: titlePattern(type.title, type.stems ?? []) });
  });
  if (matches.length === 0) return null;
  // Ingilizce ozellik obegi: "drone with camera", "headphones without mic". Edatin ARDINDAKI tur bir
  // ozelliktir, urun turu degil; bas isim edattan onceki turlerden secilir. Edattan once tur yoksa
  // ozellik turu zorunlu tutulmaz (bilinmeyen tur = zorunluluk yok).
  const feature = tokens.findIndex((token) => FEATURE_PREPOSITIONS.has(token));
  const candidates = feature === -1 ? matches : matches.filter((match) => match.index < feature);
  if (candidates.length === 0) return null;
  // Bas isim: sorguda en sonda gecen tur (Turkce tamlama; Ingilizce "red shorts" icin de sondaki).
  const head = candidates.reduce((best, current) => (current.index > best.index ? current : best));
  return head.title;
}

/** Ardindan gelen ismin ozellik oldugunu belirten Ingilizce edatlar ("for" bilerek yok: "case for phone"). */
const FEATURE_PREPOSITIONS: ReadonlySet<string> = new Set([
  "with",
  "without",
  "w",
  "featuring",
  "including",
]);
