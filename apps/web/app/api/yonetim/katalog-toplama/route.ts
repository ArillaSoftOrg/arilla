import {
  type AdminActor,
  type BatchInput,
  CollectionError,
  closeCollectionRun,
  evaluateAdminSession,
  getCollectionStatus,
  hasCapability,
  isFreshAuth,
  startCollectionRun,
  submitCollectionBatch,
  verifySessionToken,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { readSessionCookie } from "../../../lib/session-cookie.ts";

/**
 * Yonetici tarayicisindan katalog toplama API'si (karar 0117). Is mantigi
 * `packages/core/src/catalog-collection`; burasi ince istemci.
 *
 * Savunma: (1) cerezli oturum + `catalog.write` (yalniz yonetici) + yonetim
 * oturumu suresi, (2) ayni-kokenli istek (Origin), (3) kosu baslatmak taze
 * giris ister, (4) govde boyut siniri. Yanit gizli bilgi icermez; hata
 * yalnizca kod doner. Yetkisiz isteklere 404 (yonetim alaninin varligi sezdirilmez).
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
  if (!(user && hasCapability(user.role, "catalog.write")))
    return json({ error: "not_found" }, 404);
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
  // Bilinmeyen ya da bayragi kapali kaynak (Trendyol, karar 0118): varligi sezdirilmez.
  unknown_source: 404,
  collection_quota_interval: 429,
  collection_quota_month: 429,
  collection_disabled: 403,
  collection_run_already_open: 409,
  collection_run_not_open: 409,
  collection_run_expired: 410,
  request_budget_exceeded: 429,
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
  try {
    switch (body.op) {
      case "status":
        return json(await getCollectionStatus(db, actor, String(body.source)));
      case "start": {
        if (!auth.fresh) return json({ error: "fresh_login_required" }, 403);
        const options = (body.options ?? {}) as { queries?: number; maxPages?: number };
        return json(await startCollectionRun(db, actor, { source: String(body.source), options }));
      }
      case "batch":
        return json(
          await submitCollectionBatch(db, actor, {
            runId: Number(body.runId),
            records: body.records as unknown[],
            units: body.units as BatchInput["units"],
            requestsMade: Number(body.requestsMade),
            checkpoint: (body.checkpoint ?? null) as Record<string, unknown> | null,
          }),
        );
      case "close":
        return json(
          await closeCollectionRun(db, actor, {
            runId: Number(body.runId),
            outcome: body.outcome === "aborted" ? "aborted" : "completed",
          }),
        );
      default:
        return json({ error: "bad_op" }, 400);
    }
  } catch (error) {
    if (error instanceof CollectionError) {
      return json({ error: error.code, detail: error.detail }, STATUS_BY_CODE[error.code] ?? 400);
    }
    console.error("[katalog-toplama] beklenmeyen hata");
    return json({ error: "internal" }, 500);
  }
}
