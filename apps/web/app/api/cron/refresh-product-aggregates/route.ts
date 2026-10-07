import { cronAuthFailureResponse, runProductAggregateRepair } from "@arilla/core";
import { getDatabase } from "@arilla/db";

/**
 * Ürün fiyat özetinin günlük onarımı (`apps/web/vercel.json`, `45 23 * * *`
 * = 23:45 UTC; keşfet slotlarından önce). Özet olağan olarak teklifi yazan
 * işlemde yenilenir; bu uç atlanmış yolları düzeltir. İş mantığı
 * `packages/core/src/product/refresh-aggregates.ts`'te (CLAUDE.md kural 6).
 * Koşu `job_run`'a yazılır (`product_aggregates`). Yanıt yalnızca sayıdır.
 */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const denied = cronAuthFailureResponse(
    request.headers.get("authorization"),
    process.env.CRON_SECRET,
  );
  if (denied) return denied;

  try {
    return Response.json(await runProductAggregateRepair(getDatabase()));
  } catch {
    // Ayrıntı `job_run.error_summary`'de (sırsız); yanıta hiçbir şey konmaz.
    return Response.json({ status: "failed" }, { status: 500 });
  }
}
