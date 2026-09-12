import { generateDiscoverySlots, todaySlotDate } from "@arilla/core";
import { getDatabase } from "@arilla/db";

/**
 * `discovery_slot` günlük üretimi (docs/backlog.md E4). Vercel Cron burayı
 * `apps/web/vercel.json`'daki tarifeye göre (gece yarısı UTC) çağırır.
 * İş mantığı `packages/core/src/discovery-feed/generate-discovery-slots.ts`'te
 * - bu route ince bir istemci (CLAUDE.md kural 6).
 */
export async function GET(request: Request): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await generateDiscoverySlots(getDatabase(), todaySlotDate());
  return Response.json(result);
}
