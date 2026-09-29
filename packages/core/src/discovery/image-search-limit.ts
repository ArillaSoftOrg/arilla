/**
 * D4 "kullanıcı başına günlük limit". `auth/search-wall.ts` ile aynı sabit
 * pencereli sayaç (`redis/counter.ts`), ama bu bir sürtünme değil sert bir
 * duraktır - embedding çağrısı gerçek para maliyeti taşır
 * (`docs/decisions/0015`), metin aramasının aksine. Anahtar girişliyse
 * `user_id`, değilse `session_id` üzerinden tutulur - görsel arama anonim de
 * çalışır (`PRODUCT_ACCESS=open` iken).
 *
 * Anonim oturum sayacı tek başına yetmez: `session_id` çerezini silen her
 * istek yeni bir günlük hak alır. Bu yüzden anonim istek ek olarak IP başına
 * bir üst tavandan geçer. IP `auth/client-ip.ts`'in güvenilir kuralıyla
 * çözülür ve anahtara özetlenerek yazılır (`auth/rate-limit.ts` ile aynı).
 * Tavan oturum limitinden bilerek yüksektir: mobil operatörlerde çok sayıda
 * kullanıcı aynı IP'yi (CGNAT) paylaşır. Girişli kullanıcı IP tavanına
 * sayılmaz; hesabı zaten `user_id` limitine bağlı.
 *
 * Redis erişilemezse `RedisUnavailableError` fırlatır; limit
 * doğrulanamadığı için embedding çağrısı yapılmamalıdır (fail-closed).
 */
import { createHash } from "node:crypto";
import { incrementFixedWindow } from "../redis/counter.ts";

const WINDOW_SECONDS = 60 * 60 * 24;

type Env = Readonly<Record<string, string | undefined>>;

function dailyLimit(env: Env): number {
  return Number(env.VISUAL_SEARCH_DAILY_LIMIT_PER_USER ?? 20);
}

function ipDailyLimit(env: Env): number {
  return Number(env.VISUAL_SEARCH_DAILY_LIMIT_PER_IP ?? 100);
}

export interface ImageSearchLimitResult {
  allowed: boolean;
}

export function imageSearchLimitKey(key: { userId: number | null; sessionId: string }): string {
  const scope = key.userId !== null ? `user:${key.userId}` : `session:${key.sessionId}`;
  return `image-search-limit:${scope}`;
}

/** IP anahtara düz yazılmaz (kişisel veri). */
export function imageSearchIpLimitKey(ip: string): string {
  return `image-search-limit:ip:${createHash("sha256").update(ip.trim()).digest("hex")}`;
}

/** Testte Redis'siz sayaç enjekte edilebilsin diye; varsayılan `incrementFixedWindow`. */
type Counter = (key: string, windowSeconds: number) => Promise<number>;

export async function recordImageSearchAndCheckLimit(
  key: {
    userId: number | null;
    sessionId: string;
    /** `resolveClientIp` çıktısı; çözülemediyse `null` (IP tavanı uygulanamaz). */
    ip?: string | null;
  },
  increment: Counter = incrementFixedWindow,
  env: Env = process.env,
): Promise<ImageSearchLimitResult> {
  const count = await increment(imageSearchLimitKey(key), WINDOW_SECONDS);
  if (count > dailyLimit(env)) return { allowed: false };

  // Oturum limitine takılan istek IP sayacını şişirmez: tavan yalnızca
  // gerçekten sağlayıcıya gidebilecek anonim istekleri sayar.
  if (key.userId === null && key.ip) {
    const ipCount = await increment(imageSearchIpLimitKey(key.ip), WINDOW_SECONDS);
    if (ipCount > ipDailyLimit(env)) return { allowed: false };
  }
  return { allowed: true };
}
