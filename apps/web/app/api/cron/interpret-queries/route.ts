import { cronAuthFailureResponse, runQueryInterpretationJob } from "@arilla/core";
import { getDatabase } from "@arilla/db";

/**
 * Çevrimdışı model sorgu yorumlama (docs/decisions/0059). Zamanlanmış DEĞİL:
 * ne `vercel.json`'da ne GitHub Actions'ta; yalnızca elle çağrılır. Kimlik
 * doğrulama diğer cron uçlarıyla aynı: `Bearer ${CRON_SECRET}`
 * (`cronAuthFailureResponse`). Kullanıcı oturumu kullanılmaz.
 *
 * `GEMINI_API_KEY` yoksa sağlayıcı çağrılmaz, koşu "atlandı" yazılır. İş
 * mantığının tamamı `packages/core/src/search/query-interpretation.ts`'te
 * (CLAUDE.md kural 6). Yanıt yalnızca sayılardır; sorgu metni, model çıktısı
 * ya da sır içermez. `/ara` bu ucu çağırmaz (kural 1).
 */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const denied = cronAuthFailureResponse(
    request.headers.get("authorization"),
    process.env.CRON_SECRET,
  );
  if (denied) return denied;

  try {
    const result = await runQueryInterpretationJob(getDatabase());
    return Response.json(result);
  } catch {
    // Ayrıntı `job_run.error_summary`'de (sırsız); yanıta hiçbir şey konmaz.
    return Response.json({ status: "failed" }, { status: 500 });
  }
}
