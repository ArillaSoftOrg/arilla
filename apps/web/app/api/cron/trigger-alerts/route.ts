import { cronAuthFailureResponse, triggerAlerts } from "@arilla/core";
import { getDatabase } from "@arilla/db";

/**
 * "Alarm tetikleme işi" (docs/backlog.md E2). Vercel Hobby planı cron
 * başına günde tek çalıştırmayla sınırlı (15 dakikada bir burada
 * yetmiyor), o yüzden bu uç artık `apps/web/vercel.json`'da değil -
 * `.github/workflows/trigger-alerts-cron.yml` GitHub Actions üzerinden
 * 15 dakikada bir buraya HTTP isteği atar. Kimlik doğrulama: `Bearer
 * ${CRON_SECRET}` (`cronAuthFailureResponse`, packages/core/src/cron).
 * İş mantığının tamamı `packages/core/src/account/trigger-alerts.ts`'te - bu route ince bir istemci (CLAUDE.md kural 6).
 */
export async function GET(request: Request): Promise<Response> {
  // Sabit zamanli karsilastirma; CRON_SECRET tanimsiz/kisa ise 500 (uc acik
  // kalmaz). Sir ve baslik loglanmaz, yanita konmaz.
  const denied = cronAuthFailureResponse(
    request.headers.get("authorization"),
    process.env.CRON_SECRET,
  );
  if (denied) return denied;

  const result = await triggerAlerts(getDatabase());
  return Response.json(result);
}
