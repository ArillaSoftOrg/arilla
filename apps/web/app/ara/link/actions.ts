"use server";

import {
  getLinkResolutionStatus,
  InvalidUrlError,
  isRedisUnavailableError,
  isValidRequestKey,
  reconcileLinkRequestCharge,
  runChargedLinkSearch,
} from "@arilla/core";
import {
  ANONYMOUS_SESSION_COOKIE,
  anonymousSessionCookieOptions,
  newAnonymousSessionId,
  validAnonymousSessionId,
} from "@arilla/core/anonymous-session";
import { getDatabase } from "@arilla/db";
import { cookies } from "next/headers";
import { requireProductAccess } from "../../lib/dal.ts";

/** `ara/gorsel/actions.ts` ile aynı desen: Server Action çerez yazabilir. */
async function ensureSessionId(): Promise<string> {
  const store = await cookies();
  // Kanonik UUID olmayan değer (istemci elle yazmış olabilir) yok sayılır.
  const existing = validAnonymousSessionId(store.get(ANONYMOUS_SESSION_COOKIE)?.value);
  if (existing) return existing;

  const sessionId = newAnonymousSessionId();
  store.set(ANONYMOUS_SESSION_COOKIE, sessionId, anonymousSessionCookieOptions());
  return sessionId;
}

export type StartLinkSearchResult =
  | { status: "queued"; requestId: string }
  | { status: "failed"; errorCode: string };

/**
 * İnce istemci (CLAUDE.md kural 6): önbellek, oran sınırı, hak ayırma ve
 * kuyruk kararı `@arilla/core`'da (`runChargedLinkSearch`, 0047). Hak
 * yalnızca yeni bir getirme açılırken harcanır; önbellekteki ya da hâlâ
 * işlenen aynı link ücretsizdir. `requestKey` istemcinin bu deneme için
 * ürettiği anahtardır: aynı deneme iki kez gelirse ikinci kez hak alınmaz.
 */
export async function startLinkSearchAction(
  url: string,
  requestKey: string,
): Promise<StartLinkSearchResult> {
  const user = await requireProductAccess();
  // 0047: link araması hesap ister.
  if (!user) return { status: "failed", errorCode: "login_required" };
  if (!isValidRequestKey(requestKey)) return { status: "failed", errorCode: "unexpected" };
  const sessionId = await ensureSessionId();

  try {
    const result = await runChargedLinkSearch(getDatabase(), {
      userId: user.id,
      sessionId,
      requestKey,
      urlRaw: url,
    });
    if (result.status === "queued") return { status: "queued", requestId: result.requestId };
    // Sitenin 429'u zaten `rate_limited` kodunu tasir; kullanici hizi ayri kod.
    return {
      status: "failed",
      errorCode: result.status === "rate_limited" ? "search_rate_limited" : result.status,
    };
  } catch (error) {
    if (error instanceof InvalidUrlError) return { status: "failed", errorCode: "invalid_url" };
    if (isRedisUnavailableError(error)) {
      // Yalnızca sebep kodu; adres ya da oturum bilgisi loglanmaz. Ayrılan hak
      // (varsa) iade edildi.
      console.error("link search unavailable: queue or limit store");
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
  await requireProductAccess();
  const db = getDatabase();
  const status = await getLinkResolutionStatus(db, requestId);
  if (!status) return { state: "failed", errorCode: "unexpected" };
  // 0047: isin durumuna gore bagli hakki kesinlestir/iade et (tam bir kez).
  // Hak kaydi okunamasa da kullanici sonucu gorur; gunluk supurme tamamlar.
  if (status.status === "resolved" || status.status === "failed") {
    await reconcileLinkRequestCharge(db, requestId).catch((error: unknown) => {
      console.error(
        "link search charge reconcile failed",
        error instanceof Error ? error.name : "unknown",
      );
    });
  }
  if (status.status === "queued" || status.status === "processing") return { state: "pending" };
  if (status.status === "resolved") return { state: "resolved" };
  return { state: "failed", errorCode: status.errorCode ?? "unexpected" };
}
