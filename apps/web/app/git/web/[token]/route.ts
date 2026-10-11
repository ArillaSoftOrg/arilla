import {
  classifyClickRequest,
  isWebSearchEnabled,
  recordWebExit,
  verifyWebExit,
} from "@arilla/core";
import {
  ANONYMOUS_SESSION_COOKIE,
  anonymousSessionCookieOptions,
  newAnonymousSessionId,
  validAnonymousSessionId,
} from "@arilla/core/anonymous-session";
import { getDatabase } from "@arilla/db";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { requireProductAccess } from "../../../lib/dal.ts";

/**
 * Internet arama sonucundan magaza cikisi (karar 0101, CLAUDE.md kural 8).
 * Katalogda `offer` satiri olmayan sonuclar `/git/[offerId]` yerine buradan
 * gecer: imzali token -> `web_exit_click` kaydi -> yonlendirme. Imzasiz,
 * suresi dolmus ya da guvensiz adresli token 404 verir; serbest `?url=`
 * parametresi YOKTUR (acik yonlendirme olamaz). Affiliate degildir.
 *
 * Ozellik kapaliyken (bayrak) rota 404 verir. Onceden verilmis token'lar da
 * bayrak kapaninca calismaz: kapali sistem davranisi degismez.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const user = await requireProductAccess();
  if (!isWebSearchEnabled()) notFound();

  const { token } = await params;
  const payload = verifyWebExit(token);
  if (payload === null) notFound();

  // Onyukleme, HEAD ve botlar gercek tiklama degildir: kayit ve yonlendirme yok.
  if (classifyClickRequest(request) !== "human") {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  const store = await cookies();
  const existingSessionId = validAnonymousSessionId(store.get(ANONYMOUS_SESSION_COOKIE)?.value);
  const sessionId = existingSessionId ?? newAnonymousSessionId();
  if (!existingSessionId) {
    store.set(ANONYMOUS_SESSION_COOKIE, sessionId, anonymousSessionCookieOptions());
  }

  const db = getDatabase();
  // Kural 8: kayit yazilamazsa yonlendirme yok.
  await recordWebExit(db, { payload, sessionId, userId: user?.id ?? null });

  // Davranissal analitik olayi yok: docs/events.md tanimsiz olay gonderilmez (kural 13).
  redirect(payload.url);
}
