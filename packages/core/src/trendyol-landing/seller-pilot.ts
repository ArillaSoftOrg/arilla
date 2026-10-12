/**
 * Yetkili satici pilotu: guvenli, salt okunur, kota dostu sorgu katmani (arastirma).
 *
 * - Anahtar YALNIZCA sunucuda bir sir cozucuden okunur (`SecretResolver`); loglanmaz,
 *   istemciye gitmez, bu modulde saklanmaz. Gercek kimlik bilgisi uretilmez/istenmez.
 * - Yalnizca okuma uc noktalari: Stok-Fiyat (`inventory-and-price`, Read grubu, 50 barkod),
 *   Onayli Urun V2 (Read grubu), Buybox (Write grubu, 10 barkod; YALNIZCA saticinin kendi barkodlari).
 *   Fiyat/stok guncelleme gibi yazma islemleri CAGRILMAZ.
 * - Kota (developers.trendyol.com, 14 Eyl 2026 sonrasi): satici bazinda ortak grup limitleri;
 *   ManiCepte bunun kucuk bir payini kullanir. Genel kural: ayni uc noktaya 10 sn'de <= 50 istek.
 */

import { priceTextToKurus } from "./listing.ts";
import type { PriceObservation } from "./price-observation.ts";

export interface SellerSecret {
  apiKey: string;
  apiSecret: string;
}

/** Sunucu tarafi sir deposu (ortam degiskeni, secret manager). Asla istemciye verilmez. */
export interface SecretResolver {
  get(sellerId: string): Promise<SellerSecret | null>;
}

export type ListingTier = 50_000 | 75_000 | 150_000 | 500_000 | "unlimited";

/** Belgedeki kademe tablolari (req/dk). */
export const GROUP_LIMITS: Record<"read" | "write", Record<string, number>> = {
  read: { "50000": 1000, "75000": 1250, "150000": 1500, "500000": 1750, unlimited: 2000 },
  write: { "50000": 200, "75000": 300, "150000": 400, "500000": 500, unlimited: 600 },
};

export type Endpoint = "inventory-and-price" | "approved" | "buybox";
const GROUP: Record<Endpoint, "read" | "write"> = {
  "inventory-and-price": "read",
  approved: "read",
  buybox: "write",
};
const BATCH: Record<Endpoint, number> = { "inventory-and-price": 50, approved: 50, buybox: 10 };

export interface QuotaOptions {
  tier: ListingTier;
  /** ManiCepte'nin kullanacagi pay (varsayilan okuma %10, yazma %5). */
  share?: { read: number; write: number };
  now?: () => number;
}

/** Satici basina dakikalik grup butcesi + uc nokta basina 10 sn / 50 istek penceresi. */
export class SellerQuota {
  private readonly perMinute: Record<"read" | "write", number>;
  private readonly used = { read: [] as number[], write: [] as number[] };
  private readonly perEndpoint = new Map<Endpoint, number[]>();
  private readonly now: () => number;

  constructor(opts: QuotaOptions) {
    const share = opts.share ?? { read: 0.1, write: 0.05 };
    const key = String(opts.tier);
    this.perMinute = {
      read: Math.floor((GROUP_LIMITS.read[key] ?? 1000) * share.read),
      write: Math.floor((GROUP_LIMITS.write[key] ?? 200) * share.write),
    };
    this.now = opts.now ?? Date.now;
  }

  limitPerMinute(group: "read" | "write"): number {
    return this.perMinute[group];
  }

  /** Istek atilabilirse kaydeder ve true doner; aksi halde false (istek atilmaz). */
  tryAcquire(endpoint: Endpoint): boolean {
    const t = this.now();
    const group = GROUP[endpoint];
    const g = this.used[group].filter((x) => t - x < 60_000);
    const e = (this.perEndpoint.get(endpoint) ?? []).filter((x) => t - x < 10_000);
    if (g.length >= this.perMinute[group] || e.length >= 50) {
      this.used[group] = g;
      this.perEndpoint.set(endpoint, e);
      return false;
    }
    g.push(t);
    e.push(t);
    this.used[group] = g;
    this.perEndpoint.set(endpoint, e);
    return true;
  }
}

export interface PlannedCall {
  endpoint: Endpoint;
  barcodes: string[];
}

/**
 * Fiyat yenileme plani: fiyat icin once Read grubundaki Stok-Fiyat (50'li);
 * Buybox yalnizca istenirse ve Write payi yetiyorsa (10'lu). Butceye sigmayanlar ertelenir.
 */
export function planRefresh(
  quota: SellerQuota,
  req: { barcodes: readonly string[]; buyboxFor?: readonly string[] },
): { calls: PlannedCall[]; deferred: { endpoint: Endpoint; barcodes: string[] }[] } {
  const calls: PlannedCall[] = [];
  const deferred: { endpoint: Endpoint; barcodes: string[] }[] = [];
  const chunk = (xs: readonly string[], n: number) =>
    Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  for (const [endpoint, list] of [
    ["inventory-and-price", req.barcodes],
    ["buybox", req.buyboxFor ?? []],
  ] as const) {
    for (const batch of chunk(list, BATCH[endpoint])) {
      if (quota.tryAcquire(endpoint)) calls.push({ endpoint, barcodes: batch });
      else deferred.push({ endpoint, barcodes: batch });
    }
  }
  return { calls, deferred };
}

type Json = Record<string, unknown>;

/** Stok-Fiyat yaniti -> satici fiyat gozlemleri (belgedeki duz `salePrice`, `listPrice`). */
export function observationsFromInventoryAndPrice(
  body: unknown,
  sellerId: string,
  observedAt: string,
): PriceObservation[] {
  const out: PriceObservation[] = [];
  for (const c of ((body as Json)?.content as Json[] | undefined) ?? []) {
    const contentId = c.contentId != null ? String(c.contentId) : null;
    if (!contentId) continue;
    for (const v of (c.variants as Json[] | undefined) ?? []) {
      const barcode = typeof v.barcode === "string" ? v.barcode : null;
      for (const [kind, field] of [
        ["seller.salePrice", "salePrice"],
        ["seller.listPrice", "listPrice"],
      ] as const) {
        const raw = v[field];
        const kurus =
          typeof raw === "number" || typeof raw === "string" ? priceTextToKurus(String(raw)) : null;
        if (kurus == null) continue;
        out.push({
          kind,
          contentId,
          barcode,
          variant: null,
          supplierId: sellerId,
          priceKurus: kurus,
          currency: "TRY",
          observedAt,
          source: "seller-api",
        });
      }
    }
  }
  return out;
}

/** Log icin: anahtar/sir iceren degerleri gizler. */
export function redact(text: string, secret: SellerSecret): string {
  let s = text;
  for (const v of [secret.apiKey, secret.apiSecret]) if (v) s = s.split(v).join("***");
  return s.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic ***");
}
