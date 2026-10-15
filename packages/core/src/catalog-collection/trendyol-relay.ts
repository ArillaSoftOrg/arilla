/**
 * Trendyol toplama: eklenti <-> yonetim sayfasi aktarimi (karar 0118). Tarayiciya paketlenir.
 *
 * Akis (ek ag istegi YOK; CORS acilmayacagi icin sunucu ve yonetim sayfasi Trendyol'u cagirmaz):
 *  1. Yonetici Trendyol sayfasini KENDISI acar. Eklentinin icerik betigi (trendyol.com) sayfada
 *     bulunan veriyi `captureTrendyolPage` ile okur ve yalnizca eklenti deposuna yazar.
 *  2. Yonetim sayfasindaki ikinci icerik betigi yakalananlari `postMessage` ile ayni sayfaya
 *     iletir. Sayfa, kimlikli yonetim API'sine (ayni koken, oturum, `catalog.write`) gonderir.
 *  3. Sunucu her kaydi yeniden dogrular; kota ve istek butcesi veritabaninda zorunludur.
 *
 * Bir acilan sayfa = bir kaynak istegi (butceden duser). Engel/dogrulama sayfasi ya da beklenen
 * yapinin yoklugu kosuyu DURDURUR; yeniden deneme ve alternatif yol yoktur.
 */
import {
  canonicalTrendyolProductUrl,
  collectTrendyolPageInputs,
  extractTrendyolPage,
  isTrendyolListingPath,
  type TrendyolExtractedPage,
  type TrendyolIntakeItem,
} from "./extract-trendyol.ts";

export const RELAY_CHANNEL = "manicepte-trendyol-collector/v1";
export const MAX_RECORDS_PER_BATCH = 500;
export const MAX_UNITS_PER_BATCH = 100;

export interface CapturedPage {
  captureId: string;
  url: string;
  capturedAt: string;
  page: TrendyolExtractedPage;
}

export type ToPageMessage =
  | { channel: typeof RELAY_CHANNEL; type: "hello"; version: string }
  | { channel: typeof RELAY_CHANNEL; type: "pages"; pages: CapturedPage[] };

export type ToExtensionMessage =
  | { channel: typeof RELAY_CHANNEL; type: "arm"; runId: number }
  | { channel: typeof RELAY_CHANNEL; type: "disarm" }
  | { channel: typeof RELAY_CHANNEL; type: "ack"; captureIds: string[] };

/** Icerik betigi: acik sayfayi okur. Ag istegi atmaz. */
export function captureTrendyolPage(
  doc: Parameters<typeof collectTrendyolPageInputs>[0],
  href: string,
  now: Date,
  captureId: string,
): CapturedPage {
  const capturedAt = now.toISOString();
  // Sorgu ve parca saklanmaz (arama terimi, takip/oturum parametreleri): yalniz koken + yol.
  const url = sanitizeCapturedUrl(href);
  return {
    captureId,
    url,
    capturedAt,
    page: extractTrendyolPage(collectTrendyolPageInputs(doc, url, capturedAt)),
  };
}

/** `https://www.trendyol.com/a/b-p-1?merchantId=2#x` -> `https://www.trendyol.com/a/b-p-1`. */
export function sanitizeCapturedUrl(href: string): string {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Yonetim sayfasi: yalniz bu kanaldan, beklenen bicimdeki mesaj kabul edilir. */
export function parseToPageMessage(data: unknown): ToPageMessage | null {
  if (!isObj(data) || data.channel !== RELAY_CHANNEL) return null;
  if (data.type === "hello" && typeof data.version === "string") {
    return { channel: RELAY_CHANNEL, type: "hello", version: data.version.slice(0, 20) };
  }
  if (data.type === "pages" && Array.isArray(data.pages) && data.pages.length <= 200) {
    const pages = data.pages.filter(
      (p): p is CapturedPage =>
        isObj(p) &&
        typeof p.captureId === "string" &&
        /^[A-Za-z0-9_-]{8,64}$/.test(p.captureId) &&
        typeof p.url === "string" &&
        typeof p.capturedAt === "string" &&
        isObj(p.page) &&
        Array.isArray((p.page as Record<string, unknown>).items),
    );
    return { channel: RELAY_CHANNEL, type: "pages", pages };
  }
  return null;
}

export function parseToExtensionMessage(data: unknown): ToExtensionMessage | null {
  if (!isObj(data) || data.channel !== RELAY_CHANNEL) return null;
  if (data.type === "arm" && Number.isSafeInteger(data.runId) && (data.runId as number) > 0) {
    return { channel: RELAY_CHANNEL, type: "arm", runId: data.runId as number };
  }
  if (data.type === "disarm") return { channel: RELAY_CHANNEL, type: "disarm" };
  if (data.type === "ack" && Array.isArray(data.captureIds)) {
    return {
      channel: RELAY_CHANNEL,
      type: "ack",
      captureIds: data.captureIds.filter((x): x is string => typeof x === "string").slice(0, 500),
    };
  }
  return null;
}

export interface RelayState {
  runId: number;
  requestsMade: number;
  maxRequests: number;
  /** Bu kosuda islenmis yakalamalar (ayni yakalama iki kez sayilmaz). */
  processedCaptures: Set<string>;
  /** Bu kosuda gonderilmis urun kimlikleri (sunucu da (run, external_id) ile tekillestirir). */
  sentProducts: Set<string>;
  /**
   * Liste kartindan okunan, henuz gonderilmemis kayitlar. Ayni urunun urun sayfasi gelirse
   * (ana satici adi, kazanan beden) liste kaydi dusulur; kosu kapanirken `flushPendingListings`.
   */
  pendingListings?: Map<string, Record<string, unknown>>;
}

export type RelayStop = "budget" | "blocked" | null;

export interface BatchBody {
  op: "batch";
  runId: number;
  records: Record<string, unknown>[];
  units: {
    kind: "product_page" | "listing_page";
    query: string;
    page: 1;
    status: "done" | "empty" | "blocked";
    itemsFound: number;
    itemsNew: number;
    errorCode: string | null;
    fetchedAt: string;
  }[];
  requestsMade: number;
  checkpoint: Record<string, unknown>;
}

export interface RelayPlan {
  /** Gonderilecek parti (yoksa null). */
  batch: BatchBody | null;
  /** Bu partiyle islenen yakalamalar: sunucu kabul edince eklentiye `ack` edilir. */
  captureIds: string[];
  stop: RelayStop;
  /** Sayfa basina sayim (kapsam/rapor icin). */
  skipped: { duplicateCaptures: number; duplicateProducts: number; notTrendyol: number };
}

function toRecord(item: TrendyolIntakeItem): Record<string, unknown> {
  return {
    externalId: item.externalId,
    title: item.title,
    url: item.url,
    priceMinor: item.priceMinor,
    listPriceMinor: item.listPriceMinor,
    basketPriceMinor: item.basketPriceMinor,
    currency: item.currency,
    imageUrl: item.imageUrl,
    imageUrls: item.imageUrls.length > 0 ? item.imageUrls : null,
    brand: item.brand,
    categoryRaw: item.categoryRaw,
    sellerExternalId: item.sellerExternalId,
    sellerName: item.sellerName,
    groupExternalId: item.groupExternalId,
    variantExternalId: item.variantExternalId,
    variantLabel: item.variantLabel,
    sourcePage: item.sourcePage,
    sourceObservedAt: item.sourceObservedAt,
  };
}

function unitKeyOf(c: CapturedPage): string {
  if (c.page.unitKey) return c.page.unitKey.slice(0, 200);
  try {
    return new URL(c.url).pathname.slice(0, 200) || "/";
  } catch {
    return "unknown";
  }
}

/**
 * Yakalanan sayfalardan bir parti planlar. Durumu YERINDE gunceller (gonderim basarisizsa
 * cagiran bu kosuyu durdurur; sunucu tarafi butce/tekillik yine son karardir).
 */
export function planRelayBatch(state: RelayState, captured: readonly CapturedPage[]): RelayPlan {
  const records: Record<string, unknown>[] = [];
  const units: BatchBody["units"] = [];
  const captureIds: string[] = [];
  const skipped = { duplicateCaptures: 0, duplicateProducts: 0, notTrendyol: 0 };
  let stop: RelayStop = null;
  for (const c of captured) {
    if (state.processedCaptures.has(c.captureId)) {
      skipped.duplicateCaptures += 1;
      continue;
    }
    if (c.page.kind === "unknown") {
      // Urun/liste sayfasi olmayan (ana sayfa, trendyol.com disi): toplama birimi degildir;
      // butceden dusmez, kosuyu durdurmaz. Urun adresinde yapi yoksa tur "product_page" gelir.
      state.processedCaptures.add(c.captureId);
      captureIds.push(c.captureId);
      skipped.notTrendyol += 1;
      continue;
    }
    if (state.requestsMade + 1 > state.maxRequests) {
      stop = "budget";
      break;
    }
    if (units.length >= MAX_UNITS_PER_BATCH) break;
    const fresh = c.page.items.filter(
      (i) =>
        !state.sentProducts.has(i.externalId) &&
        !(i.sourcePage === "listing_page" && state.pendingListings?.has(i.externalId)),
    );
    if (records.length + fresh.length > MAX_RECORDS_PER_BATCH) break;
    state.processedCaptures.add(c.captureId);
    captureIds.push(c.captureId);
    state.requestsMade += 1;
    const blocked = !c.page.structureFound;
    units.push({
      kind: c.page.kind === "listing_page" ? "listing_page" : "product_page",
      query: unitKeyOf(c),
      page: 1,
      status: blocked ? "blocked" : c.page.items.length > 0 ? "done" : "empty",
      itemsFound: c.page.items.length,
      itemsNew: fresh.length,
      errorCode: blocked ? "structure_missing" : null,
      fetchedAt: c.capturedAt,
    });
    if (blocked) {
      stop = "blocked";
      break;
    }
    skipped.duplicateProducts += c.page.items.length - fresh.length;
    const pending = (state.pendingListings ??= new Map());
    for (const item of fresh) {
      if (item.sourcePage === "listing_page") {
        // Urun sayfasi gelene ya da kosu kapanana dek bekler (ayni kosuda ilk gelen kazanir).
        if (!pending.has(item.externalId)) pending.set(item.externalId, toRecord(item));
        continue;
      }
      pending.delete(item.externalId);
      state.sentProducts.add(item.externalId);
      records.push(toRecord(item));
    }
  }
  const batch: BatchBody | null =
    units.length > 0
      ? {
          op: "batch",
          runId: state.runId,
          records,
          units,
          requestsMade: state.requestsMade,
          checkpoint: {
            source: "trendyol",
            pages: state.processedCaptures.size,
            products: state.sentProducts.size,
          },
        }
      : null;
  return { batch, captureIds, stop, skipped };
}

/** Eklenti deposundaki bekleyen yakalama tavani (eski olanlar atilir, sayilir). */
export const MAX_QUEUED_CAPTURES = 300;

/** Yeni yakalamayi kuyruga ekler; ayni adres + ayni kosu icin son yakalama tutulur. */
export function enqueueCapture(
  queue: readonly CapturedPage[],
  capture: CapturedPage,
): { queue: CapturedPage[]; dropped: number } {
  const next = [...queue.filter((c) => c.url !== capture.url), capture];
  const dropped = Math.max(0, next.length - MAX_QUEUED_CAPTURES);
  return { queue: dropped > 0 ? next.slice(dropped) : next, dropped };
}

/** Sunucunun kabul ettigi (ya da yok saydigi) yakalamalar kuyruktan cikar. */
export function ackCaptures(
  queue: readonly CapturedPage[],
  ids: readonly string[],
): CapturedPage[] {
  const done = new Set(ids);
  return queue.filter((c) => !done.has(c.captureId));
}

/** Icerik betigi yalnizca bu sayfalarda okur (urun / liste); digerlerinde hicbir sey yapmaz. */
export function isCollectibleTrendyolUrl(href: string): boolean {
  return canonicalTrendyolProductUrl(href) != null || isTrendyolListingPath(href) != null;
}

/**
 * Bekleyen liste kayitlarini gonderir (kosu kapanmadan once ya da birikince). Istek sayilmaz:
 * sayfalar zaten acildi ve butceden dustu.
 */
export function flushPendingListings(
  state: RelayState,
  limit = MAX_RECORDS_PER_BATCH,
): BatchBody | null {
  const pending = state.pendingListings;
  if (!pending || pending.size === 0) return null;
  const records: Record<string, unknown>[] = [];
  for (const [id, record] of pending) {
    if (records.length >= limit) break;
    pending.delete(id);
    if (state.sentProducts.has(id)) continue;
    state.sentProducts.add(id);
    records.push(record);
  }
  return records.length > 0
    ? {
        op: "batch",
        runId: state.runId,
        records,
        units: [],
        requestsMade: state.requestsMade,
        checkpoint: {
          source: "trendyol",
          pages: state.processedCaptures.size,
          products: state.sentProducts.size,
        },
      }
    : null;
}
