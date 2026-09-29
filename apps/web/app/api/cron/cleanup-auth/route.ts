import {
  cleanupExpiredAuthRecords,
  cronAuthFailureResponse,
  reconcileStaleCharges,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";

/**
 * Süresi dolmuş giriş bağlantısı, telefon kodu ve oturumların günlük
 * temizliği. Vercel Cron burayı `apps/web/vercel.json`'daki tarifeye göre
 * çağırır. İş mantığı `packages/core/src/auth/cleanup.ts`'te - bu route ince
 * bir istemci (CLAUDE.md kural 6). Yanıt yalnızca sayılardır.
 *
 * 0046: askıda kalan arama hakkı ayırmalarının güvenlik ağı da burada
 * (Vercel cron'ları günlük). Uzlaşma durum bilgilidir: bağlı link/görsel
 * kaydına bakar, yaşa göre körlemesine iade etmez.
 */
export async function GET(request: Request): Promise<Response> {
  // Sabit zamanli karsilastirma; CRON_SECRET tanimsiz/kisa ise 500 (uc acik
  // kalmaz). Sir ve baslik loglanmaz, yanita konmaz.
  const denied = cronAuthFailureResponse(
    request.headers.get("authorization"),
    process.env.CRON_SECRET,
  );
  if (denied) return denied;

  const db = getDatabase();
  const result = await cleanupExpiredAuthRecords(db);
  const searchCharges = await reconcileStaleCharges(db);
  return Response.json({ ...result, searchCharges });
}
