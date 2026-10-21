import { isBlocked, safeReturnPath } from "@arilla/core/maintenance";
import { readSystemStatus } from "@arilla/core/maintenance-service";

export async function GET(request: Request) {
  const status = await readSystemStatus();
  const headers = { "cache-control": "no-store, max-age=0" };
  if (!status) return Response.json({ error: "unavailable" }, { status: 503, headers });
  const path = safeReturnPath(new URL(request.url).searchParams.get("path"));
  return Response.json({ ...status, blocked: isBlocked(status, path) }, { headers });
}
