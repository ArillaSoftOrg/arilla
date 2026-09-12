import { triggerAlerts } from "@arilla/core";
import { getDatabase } from "@arilla/db";

/**
 * "Alarm tetikleme işi" (docs/backlog.md E2). Vercel Cron burayı `apps/web/
 * vercel.json`'daki tarifeye göre çağırır (15 dakikada bir). İş mantığının
 * tamamı `packages/core/src/account/trigger-alerts.ts`'te - bu route ince
 * bir istemci (CLAUDE.md kural 6).
 */
export async function GET(request: Request): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await triggerAlerts(getDatabase());
  return Response.json(result);
}
