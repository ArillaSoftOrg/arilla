/**
 * Takip bağlantısı yönlendirme yolu (docs/decisions/0115): slug → Redis önbelleği
 * → veritabanı → doğrulanmış yönlendirme adresi. Sayaç yazımı da burada.
 *
 * Hata politikası: Redis önbelleği ve sayaç ASLA yönlendirmeyi düşürmez. Önbellek
 * hatasında veritabanına, sayaç hatasında sessizce sayaçsız yönlendirmeye düşülür.
 * Veritabanı hatası fırlatılır (500): yanlış hedefe yönlendirmekten iyidir.
 */
import { type Database, trackingLink } from "@arilla/db";
import { eq, sql } from "drizzle-orm";
import { pseudonymize } from "../auth/token.ts";
import { getRedis } from "../redis/client.ts";
import { incrementFixedWindow } from "../redis/counter.ts";
import { buildRedirectLocation, SLUG_PATTERN, type TargetPolicy } from "./policy.ts";

/** Önbellek sunucuyla yazılan/okunan en küçük kümeye indirilmiştir. */
export interface CachedTrackingLink {
  id: number;
  targetUrl: string;
  source: string | null;
  campaign: string | null;
  isActive: boolean;
}

export const CACHE_TTL_SECONDS = 60;
export const NEGATIVE_CACHE_TTL_SECONDS = 30;
const NEGATIVE = "-";

export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export function cacheKey(slug: string): string {
  return `tracking-link:v1:${slug}`;
}

function defaultCache(): CacheClient {
  return getRedis() as unknown as CacheClient;
}

/** Önbellekten gelen JSON'u biçim olarak doğrular; bozuksa `undefined` (veritabanına düş). */
export function parseCached(raw: string): CachedTrackingLink | typeof NEGATIVE | undefined {
  if (raw === NEGATIVE) return NEGATIVE;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.id === "number" &&
      Number.isSafeInteger(value.id) &&
      typeof value.targetUrl === "string" &&
      (value.source === null || typeof value.source === "string") &&
      (value.campaign === null || typeof value.campaign === "string") &&
      typeof value.isActive === "boolean"
    ) {
      return {
        id: value.id,
        targetUrl: value.targetUrl,
        source: value.source as string | null,
        campaign: value.campaign as string | null,
        isActive: value.isActive,
      };
    }
  } catch {
    // bozuk önbellek değeri: yok say
  }
  return undefined;
}

/** Yönetimde her değişiklikte çağrılır; Redis hatası yutulur (TTL zaten kısa). */
export async function invalidateTrackingLinkCache(
  slug: string,
  cache?: CacheClient,
): Promise<void> {
  try {
    await (cache ?? defaultCache()).del(cacheKey(slug));
  } catch {
    // önbellek 60 sn içinde kendiliğinden düşer
  }
}

export type ResolvedTrackingLink = { id: number; location: string };

async function loadFromDatabase(
  db: Database,
  slug: string,
): Promise<CachedTrackingLink | undefined> {
  const rows = await db
    .select({
      id: trackingLink.id,
      targetUrl: trackingLink.targetUrl,
      source: trackingLink.source,
      campaign: trackingLink.campaign,
      isActive: trackingLink.isActive,
    })
    .from(trackingLink)
    .where(eq(trackingLink.slug, slug))
    .limit(1);
  return rows[0];
}

/**
 * Slug'ı yönlendirme adresine çözer. Şekle uymayan slug veritabanına/Redis'e hiç
 * gitmez (`/wp-login.php`, `/%2e%2e` gibi tarama trafiği). Pasif, yok ya da hedefi
 * doğrulamadan geçemeyen kayıt → `null` (404).
 */
export async function resolveTrackingLink(
  db: Database,
  rawSlug: string,
  policy: TargetPolicy,
  cache?: CacheClient,
): Promise<ResolvedTrackingLink | null> {
  const slug = rawSlug.toLowerCase();
  if (!SLUG_PATTERN.test(slug)) return null;

  let entry: CachedTrackingLink | typeof NEGATIVE | undefined;
  let client: CacheClient | undefined;
  try {
    client = cache ?? defaultCache();
    const raw = await client.get(cacheKey(slug));
    if (raw !== null) entry = parseCached(raw);
  } catch {
    client = undefined; // Redis yok: doğrudan veritabanı
  }

  if (entry === undefined) {
    entry = await loadFromDatabase(db, slug);
    if (client) {
      try {
        await client.set(
          cacheKey(slug),
          entry ? JSON.stringify(entry) : NEGATIVE,
          "EX",
          entry ? CACHE_TTL_SECONDS : NEGATIVE_CACHE_TTL_SECONDS,
        );
      } catch {
        // önbellek yazılamadı: sorun değil
      }
    }
  }

  if (entry === undefined || entry === NEGATIVE || !entry.isActive) return null;
  // Önbellekten gelse bile hedef yeniden doğrulanır (zehirlenmiş önbellek açık yönlendirme olmaz).
  const location = buildRedirectLocation(entry, policy);
  return location ? { id: entry.id, location } : null;
}

/** IP başına, bağlantı başına dakikalık sayılan tıklama tavanı. */
export const CLICK_RATE_LIMIT_PER_MINUTE = 20;
const RATE_WINDOW_SECONDS = 60;

export async function withinClickRateLimit(
  linkId: number,
  ip: string | null,
  counter: (key: string, windowSeconds: number) => Promise<number> = incrementFixedWindow,
): Promise<boolean> {
  if (!ip) return true;
  try {
    // IP düz yazılmaz: HMAC takma adı, 60 sn ömürlü Redis anahtarı (veritabanına girmez).
    const key = `ratelimit:tracking-link:${linkId}:${pseudonymize("tracklink", ip)}`;
    return (await counter(key, RATE_WINDOW_SECONDS)) <= CLICK_RATE_LIMIT_PER_MINUTE;
  } catch {
    return true; // Redis yok: yönlendirme sürer, sayaç yine artar
  }
}

/**
 * Saat başına tek satır, atomik artış. IP, User-Agent, oturum, çerez YAZILMAZ.
 * Saat sınırı UTC'dir (oturum saat diliminden bağımsız).
 */
export async function recordTrackingClick(db: Database, linkId: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO tracking_link_click_hour (link_id, hour, clicks)
    VALUES (${linkId}, date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', 1)
    ON CONFLICT (link_id, hour)
    DO UPDATE SET clicks = tracking_link_click_hour.clicks + 1
  `);
}
