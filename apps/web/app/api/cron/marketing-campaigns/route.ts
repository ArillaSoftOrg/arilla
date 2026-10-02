import { cronAuthFailureResponse, processMarketingCampaigns } from "@arilla/core";
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

  const result = await processMarketingCampaigns(getDatabase(), { brand: SITE_BRAND });
  return Response.json(result);
}
