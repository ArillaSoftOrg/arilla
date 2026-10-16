import {
  type AdminActor,
  approveRunDownload,
  type BatchInput,
  CollectionError,
  closeCollectionRun,
  discoveryProgress,
  evaluateAdminSession,
  getCollectionStatus,
  hasCapability,
  isFreshAuth,
  nextDiscoveryUnits,
  planDiscoveryUnits,
  reserveRequests,
  startCollectionRun,
  submitCollectionBatch,
  submitDiscoveryBatch,
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

const MAX_BODY_BYTES = 4_000_000;
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
  collection_quota_daily_requests: 429,
  collection_quota_monthly_requests: 429,
  collection_quota_monthly_products: 429,
  request_not_reserved: 409,
  collection_disabled: 403,
  collection_run_already_open: 409,
  collection_run_not_open: 409,
  collection_run_expired: 410,
  request_budget_exceeded: 429,
  download_not_approved: 403,
  download_budget_exceeded: 429,
  request_rate_exceeded: 429,
  blocked_cooldown: 429,
  database_size_limit: 507,
};

/** Disk doluluguna karsi veritabani boyutu tavani (bayt); yoksa cekirdek varsayilani. */
function databaseCeiling(): number | undefined {
  const n = Number(process.env.CATALOG_DISCOVERY_DB_MAX_BYTES);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

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
      case "discovery_plan":
        return json(
          await planDiscoveryUnits(db, actor, {
            runId: Number(body.runId),
            kind: body.kind as "sitemap_file" | "listing_page",
            keys: body.keys as string[],
          }),
        );
      case "discovery_next":
        return json({
          units: await nextDiscoveryUnits(db, actor, {
            runId: Number(body.runId),
            limit: Number(body.limit) || 1,
          }),
        });
      case "discovery_approve": {
        // Indirme onayi tutari bagladigi icin taze giris ister.
        if (!auth.fresh) return json({ error: "fresh_login_required" }, 403);
        return json(
          await approveRunDownload(db, actor, {
            runId: Number(body.runId),
            bytes: Number(body.bytes),
            transferOrigin: body.transferOrigin as
              | "vps"
              | "admin_wifi"
              | "admin_wired"
              | "admin_mobile",
          }),
        );
      }
      case "discovery_reserve":
        // Kaynaga her HTTP isteginden ONCE cagrilir (karar 0124).
        return json(
          await reserveRequests(db, actor, {
            runId: Number(body.runId),
            count: body.count === undefined ? 1 : Number(body.count),
          }),
        );
      case "discovery_batch":
        return json(
          await submitDiscoveryBatch(
            db,
            actor,
            {
              runId: Number(body.runId),
              kind: body.kind as "sitemap_file" | "listing_page",
              unitKey: String(body.unitKey),
              status: body.status as "done" | "empty" | "failed" | "blocked",
              bytesReceived: Number(body.bytesReceived),
              requestsMade: Number(body.requestsMade),
              fetchedAt: String(body.fetchedAt),
              items: (body.items ?? []) as unknown[],
              errorCode: typeof body.errorCode === "string" ? body.errorCode : null,
              checkpoint: (body.checkpoint ?? null) as Record<string, unknown> | null,
            },
            new Date(),
            { maxDatabaseBytes: databaseCeiling() },
          ),
        );
      case "discovery_progress":
        return json(
          await discoveryProgress(db, actor, {
            source: String(body.source),
            runId: Number(body.runId),
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
