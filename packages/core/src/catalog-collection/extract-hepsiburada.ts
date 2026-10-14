/**
 * Hepsiburada `/ara?q=` sayfasindan urun cikarma (karar 0115). Arsivlenen,
 * canli dogrulanmis yontem (research/hepsiburada-archive, f9d5a47):
 * `<script id="reduxStore">` -> voltranState.fragmentsMap.*.ProductList.seoState
 * .itemListElement (JSON metni, schema.org ItemList).
 *
 * Listede OLMAYAN alan uydurulmaz: satici, GTIN, kategori, varyant `null` kalir.
 * Marka yalnizca ogede `brand` varsa alinir. Veri yapisi resmi sozlesme degildir.
 */
import { decimalToKurus, httpsUrlOn, isRecord, scriptTextById } from "./parse-helpers.ts";

export interface ExtractedItem {
  externalId: string;
  title: string;
  url: string;
  priceMinor: number;
  currency: "TRY";
  inStock: boolean | null;
  imageUrl: string | null;
  brand: string | null;
}

export interface ExtractedPage {
  items: ExtractedItem[];
  /** Ham oge sayisi (gecersizler dahil): kapsam raporu "sayfada kac oge vardi" der. */
  rawCount: number;
  /** Sayfa beklenen yapiyi tasimiyor (engel sayfasi, yapi degisimi). */
  structureFound: boolean;
}

const ORIGIN = "https://www.hepsiburada.com";

/** `...-p-HBCV000123` / `...-pm-ABC123` -> kod. */
export function externalIdFromUrl(url: string): string | null {
  try {
    const m = /-(?:p|pm)-([A-Za-z0-9]{4,40})$/.exec(new URL(url).pathname);
    return m ? (m[1] as string) : null;
  } catch {
    return null;
  }
}

function availabilityOf(raw: unknown): boolean | null {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s.endsWith("instock")) return true;
  if (s.endsWith("outofstock") || s.endsWith("soldout")) return false;
  return null;
}

function brandOf(raw: unknown): string | null {
  const v = isRecord(raw) ? raw.name : raw;
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
}

const NONE: ExtractedPage = { items: [], rawCount: 0, structureFound: false };

export function extractHepsiburadaPage(html: string): ExtractedPage {
  const raw = scriptTextById(html, "reduxStore");
  if (!raw) return NONE;
  let list: unknown[] | null = null;
  try {
    const fragments = JSON.parse(raw)?.voltranState?.fragmentsMap ?? {};
    for (const fragment of Object.values(fragments) as unknown[]) {
      const pl = isRecord(fragment) && isRecord(fragment.ProductList) ? fragment.ProductList : null;
      const text = pl && isRecord(pl.seoState) ? pl.seoState.itemListElement : null;
      if (typeof text !== "string") continue;
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        list = parsed.map((e) => (isRecord(e) && isRecord(e.item) ? e.item : e));
        break;
      }
    }
  } catch {
    return NONE;
  }
  if (!list) return NONE;

  const items: ExtractedItem[] = [];
  for (const it of list) {
    if (!isRecord(it)) continue;
    const offer = isRecord(it.offers) ? it.offers : null;
    const priceMinor = decimalToKurus(offer?.price);
    const title = typeof it.name === "string" ? it.name.trim() : "";
    const url = httpsUrlOn(it.url, ORIGIN, "hepsiburada.com");
    const externalId = url ? externalIdFromUrl(url) : null;
    if (!title || !url || !externalId || priceMinor === null || offer?.priceCurrency !== "TRY") {
      continue;
    }
    const images = Array.isArray(it.image) ? it.image : [it.image];
    const imageUrl = images.map((u) => httpsUrlOn(u, ORIGIN, "hepsiburada.net")).find(Boolean);
    items.push({
      externalId,
      title: title.slice(0, 500),
      // Sorgu/parca kimlige karismaz.
      url: url.split(/[?#]/)[0] as string,
      priceMinor,
      currency: "TRY",
      inStock: availabilityOf(offer?.availability),
      imageUrl: imageUrl ?? null,
      brand: brandOf(it.brand),
    });
  }
  return { items, rawCount: list.length, structureFound: true };
}
