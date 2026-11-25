import {
  adminHostPolicy,
  CollectionError,
  evaluateAdminSession,
  getCollectionSchedule,
  hasCapability,
  isAdminRequestHost,
  isFreshAuth,
  recordScheduledOutcome,
  saveCollectionSchedule,
  startScheduledRun,
  verifySessionToken,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { readSessionCookie } from "../../../../lib/session-cookie.ts";

/**
 * Zamanlanmis yonetici tarayicisi toplamasi (karar 0221). Is mantigi
 * `packages/core/src/catalog-collection/schedule.ts`; burasi ince istemci. Sunucu kaynaga
 * istek atmaz: yalniz "koşu baslatilabilir mi" sorusunu kotadan yanitlar, koşuyu acar ve
 * sonucu kaydeder.
 *
 * Savunma `../route.ts` ile ayni: yonetim ana makinesi, ayni koken, cerezli oturum +
 * `catalog.write`, yonetim oturumu suresi. Zamanlamayi DEGISTIRMEK taze giris ister;
 * zamanlanmis koşuyu acmak istemez (hedefler ve kota sunucudadir). Yetkisize 404.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 200_000;
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

const STATUS_BY_CODE: Record<string, number> = {
  unknown_source: 404,
  schedule_flag_off: 403,
  collection_disabled: 403,
  collection_quota_interval: 429,
  collection_quota_month: 429,
  collection_quota_daily_requests: 429,
  collection_quota_monthly_requests: 429,
  collection_quota_monthly_products: 429,
};

export async function POST(request: Request): Promise<Response> {
  if (!isAdminRequestHost(adminHostPolicy(), request.headers.get("host"))) {
    return json({ error: "not_found" }, 404);
  }
  if (!sameOrigin(request)) return json({ error: "not_found" }, 404);
  const token = await readSessionCookie();
  const user = token ? await verifySessionToken(getDatabase(), token) : null;
  if (!(user && hasCapability(user.role, "catalog.write"))) {
    return json({ error: "not_found" }, 404);
  }
  const session = evaluateAdminSession({
    createdAt: user.sessionCreatedAt,
    lastUsedAt: user.sessionLastUsedAt,
  });
  if (session !== "ok") return json({ error: "session_expired" }, 401);
  const actor = { userId: user.id, role: user.role };

  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  if (typeof body !== "object" || body === null) return json({ error: "bad_json" }, 400);

  const db = getDatabase();
  const source = String(body.source);
  try {
    switch (body.op) {
      case "status": {
        const { schedule } = await getCollectionSchedule(db, actor, source);
        return json({ schedule });
      }
      case "save":
        if (!isFreshAuth(user.sessionCreatedAt)) {
          return json({ error: "fresh_login_required" }, 403);
        }
        return json(
          await saveCollectionSchedule(db, actor, {
            source,
            enabled: body.enabled === true,
            targetUrls: body.targetUrls,
            paceSeconds: Number(body.paceSeconds),
          }),
        );
      case "start":
        return json(await startScheduledRun(db, actor, source));
      case "outcome":
        await recordScheduledOutcome(db, actor, {
          source,
          runId: Number(body.runId),
          outcome: String(body.outcome),
          errorCode: typeof body.errorCode === "string" ? body.errorCode : null,
        });
        return json({ ok: true });
      default:
        return json({ error: "bad_op" }, 400);
    }
  } catch (error) {
    if (error instanceof CollectionError) {
      return json({ error: error.code }, STATUS_BY_CODE[error.code] ?? 409);
    }
    console.error("[katalog-toplama/zamanlama] beklenmeyen hata");
    return json({ error: "internal" }, 500);
  }
}
