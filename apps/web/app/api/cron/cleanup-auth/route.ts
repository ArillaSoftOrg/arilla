import { cleanupExpiredAuthRecords, cronAuthFailureResponse } from "@arilla/core";
import { getDatabase } from "@arilla/db";

/**
 * Süresi dolmuş giriş bağlantısı, telefon kodu ve oturumların günlük
 * temizliği. Vercel Cron burayı `apps/web/vercel.json`'daki tarifeye göre
 * çağırır. İş mantığı `packages/core/src/auth/cleanup.ts`'te - bu route ince
 * bir istemci (CLAUDE.md kural 6). Yanıt yalnızca sayılardır.
 */
export async function GET(request: Request): Promise<Response> {
  // Sabit zamanli karsilastirma; CRON_SECRET tanimsiz/kisa ise 500 (uc acik
  // kalmaz). Sir ve baslik loglanmaz, yanita konmaz.
  const denied = cronAuthFailureResponse(
    request.headers.get("authorization"),
    process.env.CRON_SECRET,
  );
  if (denied) return denied;

  const result = await cleanupExpiredAuthRecords(getDatabase());
  return Response.json(result);
}
