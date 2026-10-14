/**
 * Kullanicinin KENDI actigi arama sayfasindan urun cikarma (tarayici eklentisi
 * prototipi). Ag istegi atmaz; yalnizca sayfada zaten bulunan veriyi okur.
 *
 * Kaynak sirasi:
 *  1) Trendyol: sunucu tarafinda sayfaya gomulen
 *     window["__single-search-result__PROPS"] JSON'u (ilk ~36 urun).
 *  2) Genel: JSON-LD ItemList / Product (Hepsiburada ve digerleri icin yedek).
 * Dogrulanamayan fiyat/gorsel uretilmez; null kalir, `missing`e yazilir.
 */

const TRENDYOL_PROPS_KEY = 'window["__single-search-result__PROPS"]=';

/** "72.989" | "1.499,90" | "1499.90" | 72989 -> kurus tamsayi; float kullanilmaz. */
export function priceTextToKurus(raw) {
  if (raw == null) return null;
  let s = String(raw)
    .trim()
    .replace(/\s*(TL|TRY|₺)$/i, "");
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const kurus = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return Number.isSafeInteger(kurus) && kurus > 0 ? kurus : null;
}

export function formatKurus(kurus) {
  const lira = Math.floor(kurus / 100);
  const k = String(kurus % 100).padStart(2, "0");
  return `${String(lira).replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${k}`;
}

function currencyCode(raw) {
  const s = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (s === "TL" || s === "TRY" || s === "₺") return "TRY";
  return /^[A-Z]{3}$/.test(s) ? s : null;
}

function httpsOrNull(url) {
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

function finalize(p) {
  const missing = [];
  for (const k of ["title", "priceKurus", "currency", "imageUrl", "productUrl"]) {
    if (p[k] == null) missing.push(k);
  }
  if (p.availability === "unknown") missing.push("availability");
  return { ...p, price: p.priceKurus != null ? formatKurus(p.priceKurus) : null, missing };
}

/** Script metinlerinden Trendyol gomulu arama sonucu nesnesini bulur. */
export function findTrendyolProps(scriptTexts) {
  for (const text of scriptTexts) {
    const i = text.indexOf(TRENDYOL_PROPS_KEY);
    if (i < 0) continue;
    const body = text
      .slice(i + TRENDYOL_PROPS_KEY.length)
      .trim()
      .replace(/;\s*$/, "");
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}

export function extractTrendyol(props, { origin, checkedAt }) {
  const products = props?.data?.products;
  if (!Array.isArray(products)) return [];
  return products.map((p) => {
    // Gosterilen (indirimli) fiyat; yoksa guncel fiyat. Metin alani esas alinir.
    const priceKurus =
      priceTextToKurus(p?.price?.discountedPriceText) ?? priceTextToKurus(p?.price?.currentText);
    let productUrl = null;
    try {
      const u = new URL(p.url, origin);
      if (u.origin === origin && /-p-\d+$/.test(u.pathname))
        productUrl = `${u.origin}${u.pathname}`;
    } catch {}
    return finalize({
      title: typeof p.name === "string" ? [p.brand, p.name].filter(Boolean).join(" ").trim() : null,
      priceKurus,
      currency: priceKurus != null ? currencyCode(p?.price?.currency) : null,
      imageUrl: httpsOrNull(p.image) ?? httpsOrNull(p.images?.[0]),
      productUrl,
      merchant: "Trendyol",
      // Liste nesnesinde stok bilgisi guvenilir degil (cogu zaman bos {}).
      availability: "unknown",
      lastCheckedAt: checkedAt,
      source: "trendyol-embedded-search-props",
      category: typeof p?.category?.name === "string" ? p.category.name : null,
    });
  });
}

function asArray(v) {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function mapAvailability(v) {
  const s = String(v ?? "").toLowerCase();
  if (s.endsWith("instock")) return "in_stock";
  if (s.endsWith("outofstock") || s.endsWith("soldout")) return "out_of_stock";
  return "unknown";
}

export function extractJsonLd(scriptTexts, { origin, checkedAt, merchant }) {
  const nodes = [];
  for (const text of scriptTexts) {
    try {
      for (const n of asArray(JSON.parse(text))) {
        if (n && typeof n === "object") nodes.push(...asArray(n["@graph"] ?? n));
      }
    } catch {}
  }
  const items = [];
  for (const n of nodes) {
    const types = asArray(n["@type"]);
    if (types.includes("ItemList")) {
      for (const el of asArray(n.itemListElement)) items.push(el?.item ?? el);
    } else if (types.includes("Product")) items.push(n);
  }
  return items
    .filter((n) => n && typeof n === "object")
    .map((n) => {
      const offer = asArray(n.offers)[0] ?? null;
      const priceKurus = priceTextToKurus(offer?.price ?? offer?.lowPrice);
      const currency = priceKurus != null ? currencyCode(offer?.priceCurrency) : null;
      let productUrl = null;
      try {
        const u = new URL(n.url, origin);
        if (u.origin === origin) productUrl = `${u.origin}${u.pathname}`;
      } catch {}
      const img = asArray(n.image)[0];
      return finalize({
        title: typeof n.name === "string" ? n.name.trim() : null,
        priceKurus: currency ? priceKurus : null,
        currency,
        imageUrl: httpsOrNull(typeof img === "string" ? img : (img?.url ?? img?.contentUrl)),
        productUrl,
        merchant,
        availability: mapAvailability(offer?.availability),
        lastCheckedAt: checkedAt,
        source: "json-ld",
      });
    });
}

// --- sorgu eslestirme (packages/core/src/live-discovery/match.ts ile ayni kurallar) ---

const TR_FOLD = {
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
const CONDITION_WORDS = new Set([
  "yenilenmis",
  "yenilio",
  "outlet",
  "kalite",
  "ikinci",
  "kullanilmis",
]);
// Canli Trendyol testinde (2026-10-12) "iPhone 16 Pro" aramasinin 36 sonucunun 19'u
// kilif/ekran koruyucuydu. Sorguda istenmedikce aksesuar elenir. Kok (onek) eslesir:
// Turkce ekler ("kilifi", "aparatli") tam kelime listesini atlatir.
const ACCESSORY_STEMS = [
  "uyumlu",
  "kilif",
  "kapak",
  "koruyucu",
  "cam",
  "film",
  "aparat",
  "sarj",
  "kablo",
  "adaptor",
  "lens",
  "tutucu",
  "aksesuar",
  // Hepsiburada canli testinde "Apple iPhone 16 Pro Silicone Case With Magsafe" gecti.
  "case",
  "cover",
  "protector",
  "glass",
  "charger",
  "cable",
];
const isAccessory = (tok) => ACCESSORY_STEMS.some((stem) => tok.startsWith(stem));

export function tokenize(text) {
  return String(text)
    .replace(/[ıİçÇğĞöÖşŞüÜ]/g, (c) => TR_FOLD[c] ?? c)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\b(\d+)\s+(gb|tb)\b/g, "$1$2")
    .split(" ")
    .filter(Boolean);
}

/**
 * `category`: kaynagin verdigi kategori adi (ornegin "Kapak & Kilif",
 * "Yenilenmis Cep Telefonu"); durum ve aksesuar kontrolune katilir.
 */
export function matchTitle(title, query, category = null) {
  const q = tokenize(query);
  const t = tokenize(title ?? "");
  if (q.length === 0) return false;
  const tset = new Set(t);
  const qset = new Set(q);
  if (!q.every((tok) => tset.has(tok))) return false;
  if (t.some((tok) => VARIANT_WORDS.has(tok) && !qset.has(tok))) return false;
  const context = [...t, ...tokenize(category ?? "")];
  if (context.some((tok) => CONDITION_WORDS.has(tok) && !qset.has(tok))) return false;
  if (q.some(isAccessory)) return true;
  return !context.some(isAccessory);
}

/**
 * Hepsiburada arama sayfasi JSON-LD etiketi tasimiyor; ayni schema.org ItemList,
 * sunucunun gomdugu <script id="reduxStore"> durumunun icinde METIN olarak duruyor:
 * voltranState.fragmentsMap.<n>.ProductList.seoState.itemListElement (canli, 2026-10-12).
 * Dondurulen deger extractJsonLd'nin okuyacagi bir ItemList JSON metnidir.
 */
export function findHepsiburadaItemList(reduxStoreText) {
  if (!reduxStoreText) return null;
  try {
    const fragments = JSON.parse(reduxStoreText)?.voltranState?.fragmentsMap ?? {};
    for (const fragment of Object.values(fragments)) {
      const raw = fragment?.ProductList?.seoState?.itemListElement;
      if (typeof raw !== "string") continue;
      const items = JSON.parse(raw);
      if (Array.isArray(items)) {
        return JSON.stringify({ "@type": "ItemList", itemListElement: items });
      }
    }
  } catch {}
  return null;
}

/** Sayfa -> en fazla `limit` eslesen, fiyati ve gorseli dogrulanmis urun. */
export function extractFromPage({
  scriptTexts,
  jsonLdTexts,
  reduxStoreText = null,
  origin,
  query,
  checkedAt,
  limit = 3,
}) {
  const merchant = origin.includes("hepsiburada") ? "Hepsiburada" : "Trendyol";
  const props = merchant === "Trendyol" ? findTrendyolProps(scriptTexts) : null;
  const hbList = merchant === "Hepsiburada" ? findHepsiburadaItemList(reduxStoreText) : null;
  const all = props
    ? extractTrendyol(props, { origin, checkedAt })
    : extractJsonLd(hbList ? [hbList, ...jsonLdTexts] : jsonLdTexts, {
        origin,
        checkedAt,
        merchant,
      });
  const matched = all.filter((p) => matchTitle(p.title, query, p.category));
  return {
    source: props
      ? "trendyol-embedded-search-props"
      : hbList
        ? "hepsiburada-redux-itemlist"
        : "json-ld",
    totalOnPage: all.length,
    matchedCount: matched.length,
    products: matched.slice(0, limit),
  };
}
