import { probeReadiness } from "@arilla/core";

/**
 * Hazirlik (readiness) ucu (docs/decisions/0109): veritabani `SELECT 1` ve
 * Redis `PING`. Dagitim betigi yeni surumu bununla dogrular; reverse proxy
 * bu yolu disariya ACMAZ (yalnizca Docker ic agindan cagrilir). Yanit yalnizca
 * bilesen adi ve ok/fail icerir. Is mantigi `packages/core/src/health`.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const report = await probeReadiness();
  return Response.json(
    { status: report.ready ? "ready" : "unavailable", checks: report.checks },
    { status: report.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
