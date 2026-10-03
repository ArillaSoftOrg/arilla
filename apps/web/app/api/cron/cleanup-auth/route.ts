import {
  cleanupExpiredAuthRecords,
  cronAuthFailureResponse,
  purgeExpiredActivity,
  purgeJobRuns,
  reconcileStaleCharges,
  withJobRun,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";

/**
 * Süresi dolmuş giriş bağlantısı, telefon kodu ve oturumların günlük
 * temizliği. Vercel Cron burayı `apps/web/vercel.json`'daki tarifeye göre
 * çağırır. İş mantığı `packages/core/src/auth/cleanup.ts`'te - bu route ince
 * bir istemci (CLAUDE.md kural 6). Yanıt yalnızca sayılardır.
 *
 * 0047: askıda kalan arama hakkı ayırmalarının güvenlik ağı da burada
 * (Vercel cron'ları günlük). Uzlaşma durum bilgilidir: bağlı link/görsel
 * kaydına bakar, yaşa göre körlemesine iade etmez.
 *
 * 0049: kişisel veri saklama süreleri de burada (yeni cron açılmaz):
 * analitik olayları 180 gün, sorgu metni 90 gün, giriş/çıkış geçmişi 1 yıl,
 * eski rıza satırlarındaki IP 1 yıl (`packages/core/src/activity/retention.ts`).
 *
 * 0055: koşu `job_run`'a yazılır (`cleanup_auth`) ve 180 günden eski iş
 * koşuları da burada silinir (`purgeJobRuns`).
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
  const body = await withJobRun(
    db,
    "cleanup_auth",
    "cron",
    async () => {
      const result = await cleanupExpiredAuthRecords(db);
      const searchCharges = await reconcileStaleCharges(db);
      const retention = await purgeExpiredActivity(db);
      const jobRuns = await purgeJobRuns(db);
      return { ...result, searchCharges, retention, jobRuns };
    },
    // Parti tavanına takılan temizlik yarımdır: kalan bir sonraki çalıştırmaya.
    (r) => ({ status: r.truncated || r.jobRuns.truncated ? "partial" : "success" }),
  );
  return Response.json(body);
}
