"use server";

import { randomUUID } from "node:crypto";
import {
  enqueueLinkResolution,
  getLinkResolutionStatus,
  InvalidUrlError,
  isRedisUnavailableError,
  LinkSearchLimitError,
  recordLinkSearchAndCheckLimit,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies } from "next/headers";
import { verifySession } from "../../lib/dal.ts";

const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** `ara/gorsel/actions.ts` ile aynı desen: Server Action çerez yazabilir. */
async function ensureSessionId(): Promise<string> {
  const store = await cookies();
  const existing = store.get("session_id")?.value;
  if (existing) return existing;

  const sessionId = randomUUID();
  store.set("session_id", sessionId, {
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
  });
  return sessionId;
}

export type StartLinkSearchResult =
  | { status: "queued"; requestId: string }
  | { status: "failed"; errorCode: string };

/**
 * İnce istemci (CLAUDE.md kural 6): önbellek, limit ve kuyruk kararı
 * `@arilla/core`'da. Limit yalnızca yeni bir getirme açılırken sayılır.
 */
export async function startLinkSearchAction(url: string): Promise<StartLinkSearchResult> {
  const sessionId = await ensureSessionId();
  const user = await verifySession();
  const userId = user?.id ?? null;

  try {
    const { requestId } = await enqueueLinkResolution(
      getDatabase(),
      { urlRaw: url, sessionId, userId },
      { checkLimit: () => recordLinkSearchAndCheckLimit({ userId, sessionId }) },
    );
    return { status: "queued", requestId };
  } catch (error) {
    if (error instanceof InvalidUrlError) return { status: "failed", errorCode: "invalid_url" };
    if (error instanceof LinkSearchLimitError)
      return { status: "failed", errorCode: "daily_limit" };
    if (isRedisUnavailableError(error)) {
      // Yalnızca sebep kodu; adres ya da oturum bilgisi loglanmaz.
      console.error("link search unavailable: queue");
      return { status: "failed", errorCode: "queue_unavailable" };
    }
    throw error;
  }
}

export type LinkSearchPoll =
  | { state: "pending" }
  | { state: "resolved" }
  | { state: "failed"; errorCode: string };

/**
 * İstemci yalnızca "bitti mi?" sorar. Başarıda sonucu sunucu sayfası yeniden
 * çizer (paylaşılabilir adres, önbellek); başarısızlıkta istemci mesajı
 * kendisi gösterir - geçici hatalar önbelleğe alınmadığı için sayfa yenilemesi
 * yeni bir istek açardı.
 */
export async function pollLinkSearchAction(requestId: string): Promise<LinkSearchPoll> {
  const status = await getLinkResolutionStatus(getDatabase(), requestId);
  if (!status) return { state: "failed", errorCode: "unexpected" };
  if (status.status === "queued" || status.status === "processing") return { state: "pending" };
  if (status.status === "resolved") return { state: "resolved" };
  return { state: "failed", errorCode: status.errorCode ?? "unexpected" };
}
