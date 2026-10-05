import {
  cleanupExpiredAuthRecords,
  cronAuthFailureResponse,
  purgeExpiredActivity,
  purgeExpiredQueryInterpretationsSafely,
  purgeJobRuns,
  purgeSearchQueryDays,
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
 *
 * 0054: 90 günden eski arama kalitesi özeti (`search_query_day`) da burada
 * silinir (`purgeSearchQueryDays`).
 *
 * 0059: 90 günden eski model sorgu yorumları (`query_interpretation`) da burada
 * silinir. Diğer saklama işlerinden yalıtılmıştır: hata verirse onlar yine
 * çalışır, koşu `partial` yazılır.
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
      // Karar 0054: kimliksiz arama kalitesi özeti 90 gün saklanır.
      const searchQueryDays = await purgeSearchQueryDays(db);
      // Karar 0059: model sorgu yorumları 90 gün saklanır (yalıtılmış adım).
      const queryInterpretations = await purgeExpiredQueryInterpretationsSafely(db);
      return {
        ...result,
        searchCharges,
        retention,
        jobRuns,
        searchQueryDays,
        queryInterpretations,
      };
    },
    // Parti tavanına takılan ya da yalıtılmış adımı başarısız olan temizlik yarımdır.
    (r) => ({
      status:
        r.truncated ||
        r.jobRuns.truncated ||
        r.queryInterpretations.truncated ||
        r.queryInterpretations.failed !== null
          ? "partial"
          : "success",
    }),
  );
  return Response.json(body);
}
