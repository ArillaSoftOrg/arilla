import { triggerAlerts } from "@arilla/core";
import { getDatabase } from "@arilla/db";

/**
 * "Alarm tetikleme işi" (docs/backlog.md E2). Vercel Hobby planı cron
 * başına günde tek çalıştırmayla sınırlı (15 dakikada bir burada
 * yetmiyor), o yüzden bu uç artık `apps/web/vercel.json`'da değil -
 * `.github/workflows/trigger-alerts-cron.yml` GitHub Actions üzerinden
 * 15 dakikada bir buraya HTTP isteği atar. Kimlik doğrulama aynı: `Bearer
 * ${CRON_SECRET}`. İş mantığının tamamı `packages/core/src/account/
 * trigger-alerts.ts`'te - bu route ince bir istemci (CLAUDE.md kural 6).
 */
export async function GET(request: Request): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await triggerAlerts(getDatabase());
  return Response.json(result);
}
