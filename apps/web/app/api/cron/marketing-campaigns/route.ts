import { cronAuthFailureResponse, processMarketingCampaigns, withJobRun } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { SITE_BRAND } from "../../../site-config.ts";

/**
 * Pazarlama kampanyası teslim işlemcisi (docs/decisions/0048). Her çağrı
 * `sending` durumundaki kampanyalardan SINIRLI bir parti işler
 * (`MARKETING_EMAIL_BATCH_SIZE`, `MARKETING_EMAIL_TIME_BUDGET_MS`) ve döner;
 * gönderen kampanya yoksa hiçbir şey yapmaz. Çağıran:
 * `.github/workflows/trigger-alerts-cron.yml` (15 dakikada bir, alarm işiyle
 * aynı iş akışı). Kimlik doğrulama: `Bearer ${CRON_SECRET}`, diğer cron
 * uçlarıyla aynı (`cronAuthFailureResponse`). Yanıt yalnızca sayılardır.
 */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const denied = cronAuthFailureResponse(
    request.headers.get("authorization"),
    process.env.CRON_SECRET,
  );
  if (denied) return denied;

  // Koşu `job_run`'a yazılır (`marketing_campaigns`, karar 0055); teslim
  // hatası olan parti kısmidir.
  const db = getDatabase();
  const result = await withJobRun(
    db,
    "marketing_campaigns",
    "cron",
    () => processMarketingCampaigns(db, { brand: SITE_BRAND }),
    (r) => ({ status: r.failed > 0 ? "partial" : "success" }),
  );
  return Response.json(result);
}
