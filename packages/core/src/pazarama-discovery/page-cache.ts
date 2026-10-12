/**
 * Paylasimli, KISA OMURLU sayfa onbellegi + single-flight (Faz 6: kapasite).
 *
 * Olcum (Faz 4b, 8 sorgu x 3 tur): arama basina 11,4 istek; ayni sorgu turlar arasinda BIREBIR
 * ayni urun kimliklerini ve ayni URL'leri uretti. Yani ayni urunu arayan farkli kullanicilar ayni
 * sayfalari tekrar indiriyordu. Bu onbellek, ayni URL'nin (ve ayni kesme kuralinin) yanitini kisa
 * bir sure paylastirir; ayni anda istenen ayni URL icin tek bir ag istegi yapilir.
 *
 * Dogruluk: saklanan sey, sayfanin ag istegiyle alinmis (kesilmis) GOVDESIDIR; ayristirma birebir
 * aynidir. Fiyat/stok en cok TTL kadar eskidir; her yanit `fetchedAt` tasir ve sonuc
 * `checkedAt` ile bunu bildirir. TTL'ler kisa (liste 120 sn, urun 60 sn); urun KALICI saklanmaz.
 * Yalnizca 200, 404 ve yonlendirme (3xx) saklanir; 429/403/5xx/ag hatasi SAKLANMAZ.
 *
 * Redis hatasi onbellek iskasi sayilir (onbellek bir iyilestirme; erisim korumasi kapidadir).
 * Anahtarlar: `pagecache:v1:<sha256(tur|url)>` ve kilit icin `...:lock`. Kullanici/sorgu/IP yok.
 */

import { createHash } from "node:crypto";
import type Redis from "ioredis";

export interface CachedPage {
  status: number;
  body: string;
  location: string | null;
  /** Ag isteginin tamamlandigi an (epoch ms). */
  fetchedAt: number;
}

export interface PageCache {
  get(key: string): Promise<CachedPage | null>;
  set(key: string, page: CachedPage, ttlMs: number): Promise<void>;
  /** Single-flight: true donerse bu cagiran getirir; false ise baskasi getiriyor. */
  lock(key: string, ttlMs: number): Promise<boolean>;
  unlock(key: string): Promise<void>;
}

/** Tur basina TTL (ms). 0 = saklama. */
export interface PageCacheTtl {
  list: number;
  detail: number;
  barcode: number;
  redirect: number;
  notFound: number;
}

export const DEFAULT_PAGE_CACHE_TTL: PageCacheTtl = {
  list: 120_000,
  detail: 60_000,
  barcode: 60_000,
  redirect: 60 * 60_000,
  notFound: 60_000,
};

export function pageCacheKey(kind: string, url: string, cutoff: boolean): string {
  const h = createHash("sha256")
    .update(`${kind}|${cutoff ? 1 : 0}|${url}`)
    .digest("hex");
  return `pagecache:v1:${h.slice(0, 40)}`;
}

/** Hangi yanit ne kadar saklanir (0 = saklanmaz). */
export function ttlFor(kind: string, status: number, ttl: PageCacheTtl): number {
  if (status >= 300 && status < 400) return ttl.redirect;
  if (status === 404) return ttl.notFound;
  if (status !== 200) return 0;
  if (kind === "list") return ttl.list;
  if (kind === "barcode") return ttl.barcode;
  return ttl.detail;
}

export class InMemoryPageCache implements PageCache {
  private readonly entries = new Map<string, { page: CachedPage; expiresAt: number }>();
  private readonly locks = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<CachedPage | null> {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return e.page;
  }

  async set(key: string, page: CachedPage, ttlMs: number): Promise<void> {
    if (ttlMs > 0) this.entries.set(key, { page, expiresAt: this.now() + ttlMs });
  }

  async lock(key: string, ttlMs: number): Promise<boolean> {
    const until = this.locks.get(key);
    if (until !== undefined && until > this.now()) return false;
    this.locks.set(key, this.now() + ttlMs);
    return true;
  }

  async unlock(key: string): Promise<void> {
    this.locks.delete(key);
  }

  size(): number {
    return this.entries.size;
  }
}

export type PageCacheRedisClient = Pick<Redis, "get" | "set" | "del">;

export class RedisPageCache implements PageCache {
  constructor(private readonly redis: PageCacheRedisClient) {}

  async get(key: string): Promise<CachedPage | null> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const v = JSON.parse(raw) as CachedPage;
      return typeof v.status === "number" && typeof v.body === "string" ? v : null;
    } catch {
      return null;
    }
  }

  async set(key: string, page: CachedPage, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    try {
      await this.redis.set(key, JSON.stringify(page), "PX", ttlMs);
    } catch {
      /* iska sayilir */
    }
  }

  async lock(key: string, ttlMs: number): Promise<boolean> {
    try {
      return (await this.redis.set(`${key}:lock`, "1", "PX", ttlMs, "NX")) === "OK";
    } catch {
      // Redis yoksa kilit "alinmis" sayilir: bu cagiran getirir (kapi zaten ayri karar verir).
      return true;
    }
  }

  async unlock(key: string): Promise<void> {
    try {
      await this.redis.del(`${key}:lock`);
    } catch {
      /* kilit PX ile kendiliginden duser */
    }
  }
}
