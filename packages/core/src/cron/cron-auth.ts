/**
 * Cron uclarinin (`apps/web/app/api/cron/**`) kimlik dogrulamasi.
 *
 * Eski kontrol `authHeader !== \`Bearer ${process.env.CRON_SECRET}\`` idi:
 * CRON_SECRET tanimsizken "Bearer undefined" basliginin gecmesine izin
 * veriyordu ve karsilastirma sabit zamanli degildi. Bu modul saf bir fonksiyon
 * sunar; route yalnizca sonucu HTTP durum koduna cevirir.
 *
 * - Sir tanimsiz, bos ya da `MIN_CRON_SECRET_LENGTH`'ten kisaysa istek her
 *   zaman reddedilir (`misconfigured`) — sir yoksa uc acik kalmaz.
 * - Karsilastirma iki tarafin SHA-256 ozeti uzerinden `timingSafeEqual` ile
 *   yapilir: esit uzunlukta tamponlar, uzunluk bilgisi de sizmaz.
 * - Yalnizca `Bearer <sir>` bicimi kabul edilir.
 *
 * Sir ve baslik hicbir zaman loglanmaz, donus degerine konmaz.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_CRON_SECRET_LENGTH = 16;

export type CronAuthResult = "authorized" | "unauthorized" | "misconfigured";

const BEARER_PREFIX = "Bearer ";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function checkCronAuthorization(
  authHeader: string | null | undefined,
  secret: string | null | undefined,
): CronAuthResult {
  if (typeof secret !== "string" || secret.trim().length < MIN_CRON_SECRET_LENGTH) {
    return "misconfigured";
  }
  if (typeof authHeader !== "string" || !authHeader.startsWith(BEARER_PREFIX)) {
    return "unauthorized";
  }
  const token = authHeader.slice(BEARER_PREFIX.length);
  // Ortam degiskenine yapistirilirken eklenen sondaki satir sonu/bosluk
  // (orn. `vercel env add` ile boru) gecerli istekleri reddettirmesin; uzunluk
  // kontrolu de kirpilmis deger uzerinden. Gelen token kirpilmaz.
  return timingSafeEqual(digest(token), digest(secret.trim())) ? "authorized" : "unauthorized";
}

export function isCronRequestAuthorized(
  authHeader: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  return checkCronAuthorization(authHeader, secret) === "authorized";
}

/**
 * Route'larin ortak kapisi: yetkiliyse `null`, degilse dondurulecek yanit.
 * Yanit govdesi sabit metindir; sir ya da gelen baslik icermez.
 */
export function cronAuthFailureResponse(
  authHeader: string | null | undefined,
  secret: string | null | undefined,
): Response | null {
  const result = checkCronAuthorization(authHeader, secret);
  if (result === "authorized") return null;
  if (result === "misconfigured") {
    return new Response("Server misconfigured", { status: 500 });
  }
  return new Response("Unauthorized", { status: 401 });
}
