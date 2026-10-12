/**
 * Pazarama sayfa ayristirma (arastirma prototipi, docs/research/arastirma-gunlugu.md).
 * Gozlenen yapi (2026-10-12): liste sayfalari urun kartlarini sunucu tarafinda HTML'e
 * yazar; urun sayfasi JSON-LD `Product` tasir; urun URL'si `-p-<barkod>` ile biter.
 * Dogrulanamayan alan null kalir; deger uretilmez.
 */

export const PAZARAMA_ORIGIN = "https://www.pazarama.com";

export type PazaramaAvailability = "in_stock" | "out_of_stock" | "unknown";

export interface PazaramaCard {
  title: string;
  /** Kartta gosterilen satis fiyati (son fiyat; ilki ustu cizili liste fiyatidir), kurus. */
  priceKurus: number | null;
  imageUrl: string | null;
  productUrl: string;
  /** URL'deki `-p-` sonrasi kimlik: cogu urunde barkod (EAN/UPC), bazilarinda ic kod. */
  productId: string;
}

export interface PazaramaProductPage {
  title: string | null;
  /** Stokta degilse fiyat gosterilmez (canli testte stoksuz urunlerde eski fiyat goruldu). */
  priceKurus: number | null;
  availability: PazaramaAvailability;
  seller: string | null;
  imageUrl: string | null;
  /**
   * Faz 5: normal ve sepette fiyati AYRI. `priceKurus` urun sayfasi JSON-LD fiyatidir
   * (Pazarama'nin gosterdigi odenecek tutar). JSON-LD fiyati "Sepette" blogundaki fiyata
   * esitse `priceKind: "basket"`: `basketPriceKurus` = o fiyat, `regularPriceKurus` = ustu
   * cizili normal fiyat. Degilse `priceKind: "regular"`, `basketPriceKurus` null.
   */
  priceKind: "regular" | "basket";
  regularPriceKurus: number | null;
  basketPriceKurus: number | null;
  /**
   * Sepet kampanyasinin kosullari (en az sepet tutari, kupon, satici kampanyasi, sure)
   * DOGRULANMADI; her zaman false. Arayuz "Sepette fiyati; kosullar magazada" demeli.
   */
  basketConditionsVerified: false;
  /** Urun sayfasindaki "Renk" degeri (varsa). Beden/kapasite barkod duzeyindedir: her barkod ayri sonuc. */
  color: string | null;
}

/** Sayfadaki "<liste> TL ... Sepette ... <sepet> TL" fiyat blogu. */
export function parseBasketPrice(html: string): { listKurus: number; basketKurus: number } | null {
  const m =
    /(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:TL|₺)(?:\s|<[^>]*>|\|){0,40}?Sepette(?:\s|<[^>]*>|\|){0,40}?(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:TL|₺)/.exec(
      html,
    );
  if (!m) return null;
  const listKurus = trPriceToKurus(m[1] as string);
  const basketKurus = trPriceToKurus(m[2] as string);
  return listKurus !== null && basketKurus !== null ? { listKurus, basketKurus } : null;
}

/** "Renk</...> ... Siyah" -> "Siyah". */
export function parseColor(html: string): string | null {
  const m = /Renk\s*(?:<[^>]*>\s*){1,6}([^<>]{2,40}?)\s*</.exec(html);
  const v = m?.[1]?.trim();
  return v && !/^[|:\s]+$/.test(v) ? v : null;
}

/** "73.329,00" -> 7332900. Gecersizse null. */
export function trPriceToKurus(text: string): number | null {
  const m = /^(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const kurus = Number((m[1] ?? "").replace(/\./g, "")) * 100 + Number(m[2]);
  return Number.isSafeInteger(kurus) && kurus > 0 ? kurus : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Liste (marka+kategori, kategori+filtre) sayfasindaki SSR urun kartlari. */
export function parseListingCards(html: string): PazaramaCard[] {
  const re = /<a href="(\/[^"?#]*-p-([A-Za-z0-9]+))" title="([^"]+)"/g;
  const matches = [...html.matchAll(re)];
  const seen = new Map<string, PazaramaCard>();
  matches.forEach((m, i) => {
    const path = m[1] as string;
    if (seen.has(path)) return;
    const start = m.index ?? 0;
    const end = matches[i + 1]?.index ?? Math.min(html.length, start + 8000);
    const chunk = html.slice(start, Math.min(end, start + 8000));
    const prices = [...chunk.matchAll(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:TL|₺)/g)].map(
      (x) => x[1] as string,
    );
    const last = prices.length > 0 ? trPriceToKurus(prices[prices.length - 1] as string) : null;
    const img = /<img[^>]+src="(https:\/\/img\.pzrmcdn\.com\/[^"]+)"/.exec(chunk)?.[1] ?? null;
    seen.set(path, {
      title: decodeEntities(m[3] as string).trim(),
      priceKurus: last,
      imageUrl: img,
      productUrl: `${PAZARAMA_ORIGIN}${path}`,
      productId: m[2] as string,
    });
  });
  return [...seen.values()];
}

function availabilityOf(raw: unknown): PazaramaAvailability {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s.endsWith("instock")) return "in_stock";
  if (s.endsWith("outofstock") || s.endsWith("soldout")) return "out_of_stock";
  return "unknown";
}

/** Urun sayfasinin JSON-LD `Product` dugumu. Stokta degilse fiyat null. */
export function parseProductPage(html: string): PazaramaProductPage | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let node: unknown;
    try {
      node = JSON.parse(m[1] ?? "");
    } catch {
      continue;
    }
    for (const n of Array.isArray(node) ? node : [node]) {
      if (
        typeof n !== "object" ||
        n === null ||
        (n as { "@type"?: unknown })["@type"] !== "Product"
      ) {
        continue;
      }
      const p = n as Record<string, unknown>;
      const offer = (Array.isArray(p.offers) ? p.offers[0] : p.offers) as
        | Record<string, unknown>
        | undefined;
      const availability = availabilityOf(offer?.availability);
      const price = typeof offer?.price === "number" ? offer.price : Number(offer?.price);
      const priceKurus =
        availability === "in_stock" &&
        offer?.priceCurrency === "TRY" &&
        Number.isFinite(price) &&
        price > 0
          ? Math.round(price * 100)
          : null;
      const image = Array.isArray(p.image) ? p.image[0] : p.image;
      const basket = parseBasketPrice(html);
      // JSON-LD fiyati "Sepette" kampanya fiyatina esitse etiketlenir ve liste fiyati ayrica verilir.
      const isBasket = priceKurus !== null && basket !== null && basket.basketKurus === priceKurus;
      return {
        title: typeof p.name === "string" && p.name.trim() ? p.name.trim() : null,
        priceKurus,
        availability,
        seller: typeof offer?.seller === "string" ? offer.seller : null,
        imageUrl: typeof image === "string" && image.startsWith("https://") ? image : null,
        priceKind: isBasket ? "basket" : "regular",
        regularPriceKurus: isBasket ? basket.listKurus : priceKurus,
        basketPriceKurus: isBasket ? priceKurus : null,
        basketConditionsVerified: false,
        color: parseColor(html),
      };
    }
  }
  return null;
}

/** Barkoddan urun adresi. Pazarama `/-p-<barkod>` adresini kanonik adrese yonlendirir. */
export function barcodeProductUrl(gtin: string): string | null {
  const digits = gtin.trim();
  if (!/^\d{8,14}$/.test(digits)) return null;
  // Uydurma/doldurma barkodlar (cok sayida bastaki sifir) canli testte 404 verdi.
  if (/^0{4,}/.test(digits)) return null;
  return `${PAZARAMA_ORIGIN}/-p-${digits}`;
}

/**
 * Akis kesme kurallari (Faz 4, olculdu 2026-10-12): liste sayfasi 2,7 MB'in ilk ~%12'sinde
 * (30 kartin tamami `window.__NUXT__` durumundan ONCE) biter; urun sayfasinda fiyat/stok
 * tasiyan JSON-LD `Product` ilk ~7 KB'tadir (sayfa 0,57 MB). Kural saglanmazsa sayfa tam
 * okunur (yapi degisirse veri kaybi olmaz, yalnizca kazanc kaybolur).
 */
export const LISTING_STOP = (text: string): boolean => text.includes("window.__NUXT__");

const PRODUCT_LD_COMPLETE = /"@type"\s*:\s*"Product"[\s\S]*?<\/script>/;
/**
 * Urun sayfasi: JSON-LD Product (~7 KB) VE Nuxt durumunun basi (~195 KB, sayfanin ~%34'u)
 * okununca kes. Arada fiyat blogu ("Sepette", ~105 KB) ve "Renk" (~122 KB) var; sepet/liste
 * fiyati ve renk icin bu kadari gerekli (dogruluk > bayt; olculdu 2026-10-12).
 */
export const DETAIL_STOP = (text: string): boolean =>
  text.includes("window.__NUXT__") && PRODUCT_LD_COMPLETE.test(text);

/** Liste sayfasinin kendi urun sayisi ("1.215 ürün"); sayfadaki fazla kartlar oneri blogudur. */
export function parseListingTotal(html: string): number | null {
  const m = /([\d.]+)\s*ürün/i.exec(html);
  if (!m) return null;
  const n = Number((m[1] ?? "").replace(/\./g, ""));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Gozlenen sayfa boyutu (buyuk listelerde 30 kart/sayfa). */
export const LISTING_PAGE_SIZE = 30;
