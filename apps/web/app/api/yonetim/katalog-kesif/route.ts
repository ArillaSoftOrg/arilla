import {
  type AdminActor,
  cancelDiscoveryOperation,
  claimDiscoveryUnit,
  DiscoveryError,
  evaluateAdminSession,
  getDiscoveryStatus,
  hasCapability,
  isFreshAuth,
  pauseDiscoveryOperation,
  reportDiscoveryFailure,
  resumeDiscoveryOperation,
  startDiscoveryOperation,
  submitDiscoveryItems,
  submitDiscoveryPlan,
  verifySessionToken,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { readSessionCookie } from "../../../lib/session-cookie.ts";

/**
 * Sitemap ile urun kesfi API'si (karar 0120). Is mantigi `packages/core/src/catalog-discovery`;
 * burasi ince istemci.
 *
 * Savunma (katalog toplama API'siyle ayni): cerezli oturum + `catalog.write` + yonetim oturumu
 * suresi, ayni-kokenli istek, baslatma/surdurme taze giris ister, govde boyut siniri. Yanit
 * gizli bilgi icermez; hata yalnizca kod doner. Yetkisiz isteklere 404.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_500_000;
const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!(origin && host)) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function authenticate(
  request: Request,
): Promise<{ actor: AdminActor; fresh: boolean } | Response> {
  if (!sameOrigin(request)) return json({ error: "not_found" }, 404);
  const token = await readSessionCookie();
  const user = token ? await verifySessionToken(getDatabase(), token) : null;
  if (!(user && hasCapability(user.role, "catalog.write"))) {
    return json({ error: "not_found" }, 404);
  }
  const state = evaluateAdminSession({
    createdAt: user.sessionCreatedAt,
    lastUsedAt: user.sessionLastUsedAt,
  });
  if (state !== "ok") return json({ error: "session_expired" }, 401);
  return {
    actor: { userId: user.id, role: user.role },
    fresh: isFreshAuth(user.sessionCreatedAt),
  };
}

const STATUS_BY_CODE: Record<string, number> = {
  collection_quota_interval: 429,
  collection_quota_month: 429,
  collection_run_already_open: 409,
  discovery_disabled: 403,
  discovery_operation_active: 409,
  discovery_initial_exists: 409,
  discovery_initial_required: 409,
  lease_not_held: 409,
  lease_held_by_other: 409,
  operation_paused: 409,
  operation_blocked: 409,
  operation_closed: 409,
  blocked_cooldown: 429,
  request_budget_exceeded: 429,
  byte_budget_exceeded: 429,
  operation_not_found: 404,
};

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  if (typeof body !== "object" || body === null) return json({ error: "bad_json" }, 400);

  const db = getDatabase();
  const { actor } = auth;
  const operationId = Number(body.operationId);
  const clientId = String(body.clientId ?? "");
  try {
    switch (body.op) {
      case "status":
        return json(await getDiscoveryStatus(db, actor, String(body.source)));
      case "start":
        if (!auth.fresh) return json({ error: "fresh_login_required" }, 403);
        return json(
          await startDiscoveryOperation(db, actor, {
            source: String(body.source),
            kind: body.kind === "weekly_refresh" ? "weekly_refresh" : "initial_import",
            network: body.network as "wifi" | "wired",
            clientId,
          }),
        );
      case "resume":
        if (!auth.fresh) return json({ error: "fresh_login_required" }, 403);
        return json(await resumeDiscoveryOperation(db, actor, { operationId, clientId }));
      case "claim":
        return json(await claimDiscoveryUnit(db, actor, { operationId, clientId }));
      case "plan":
        return json(
          await submitDiscoveryPlan(db, actor, {
            operationId,
            clientId,
            files: body.files as { url: string; lastmod?: string | null }[],
            final: body.final === true,
            bytesDecoded: Number(body.bytesDecoded ?? 0),
            bytesTransferred: Number(body.bytesTransferred ?? 0),
          }),
        );
      case "items":
        return json(
          await submitDiscoveryItems(db, actor, {
            operationId,
            clientId,
            seq: Number(body.seq),
            batchIndex: Number(body.batchIndex),
            items: body.items as unknown[],
            final: body.final === true,
            stats: (body.stats ?? undefined) as {
              itemsFound?: number;
              bytesDecoded?: number;
              bytesTransferred?: number;
            },
          }),
        );
      case "fail":
        return json(
          await reportDiscoveryFailure(db, actor, {
            operationId,
            clientId,
            seq: Number(body.seq),
            outcome: body.outcome === "blocked" ? "blocked" : "failed",
            errorCode: String(body.errorCode ?? ""),
            errorDetail: typeof body.errorDetail === "string" ? body.errorDetail : null,
            bytesDecoded: Number(body.bytesDecoded ?? 0),
            bytesTransferred: Number(body.bytesTransferred ?? 0),
          }),
        );
      case "pause":
        return json(await pauseDiscoveryOperation(db, actor, { operationId }));
      case "cancel":
        return json(await cancelDiscoveryOperation(db, actor, { operationId }));
      default:
        return json({ error: "bad_op" }, 400);
    }
  } catch (error) {
    if (error instanceof DiscoveryError) {
      return json({ error: error.code, detail: error.detail }, STATUS_BY_CODE[error.code] ?? 400);
    }
    console.error("[katalog-kesif] beklenmeyen hata");
    return json({ error: "internal" }, 500);
  }
}
