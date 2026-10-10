/**
 * Sohbetteki link mesajının okuma tarafı (karar 0090). Yalnızca OKUR (+ hak
 * uzlaşması, `/ara/link` ile aynı koşullarda); model yok.
 *
 * Durum, `/ara/link`ün adres penceresiyle (24 sa önbellek) değil, mesajın
 * sakladığı `requestId` ile okunur: sayfa yenilemek başka bir isteğe takılmaz.
 */
import { type Database, linkResolutionRequest } from "@arilla/db";
import { eq } from "drizzle-orm";
import {
  findLinkSearchResults,
  IN_FLIGHT_TTL_MS,
  type LinkSearchResults,
  type LinkSearchState,
  parseLinkSource,
} from "../discovery/index.ts";
import { reconcileLinkRequestCharge } from "../entitlement/reconcile.ts";
import type { ChatLinkPayload } from "./link.ts";

export type ResolvedLinkState = Extract<LinkSearchState, { kind: "resolved" }>;

export type ChatLinkView =
  /** Worker henüz bitirmedi (2 dakikadan genç). */
  | { state: "pending" }
  /** `queued`/`processing` ve 2 dakikadan eski: worker yanıt vermedi. */
  | { state: "stale" }
  | { state: "failed"; errorCode: string }
  | {
      state: "resolved";
      linkState: ResolvedLinkState;
      /** Kaynak görseli embedding'e dönüşmedi: arama metinle yürüdü. */
      textOnly: boolean;
    };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `link.requestId` için güncel durum. Sorgu hiç açılmadıysa (`errorCode` var)
 * veritabanına gidilmez. Biten (resolved/failed) istekte bağlı arama hakkı,
 * `pollLinkSearchAction` ile AYNI koşulda (`reconcileLinkRequestCharge`, hata
 * yutulur) kesinleştirilir ya da iade edilir; takılı kalan iş için ayrı
 * bir iade çağrısı yoktur (günlük süpürme `reconcileStaleCharges` tamamlar).
 */
export async function getChatLinkView(
  db: Database,
  link: Pick<ChatLinkPayload, "requestId" | "errorCode">,
  now: Date = new Date(),
): Promise<ChatLinkView> {
  if (link.requestId === null)
    return { state: "failed", errorCode: link.errorCode ?? "unexpected" };
  if (!UUID_RE.test(link.requestId)) return { state: "failed", errorCode: "unexpected" };

  const [row] = await db
    .select({
      id: linkResolutionRequest.id,
      status: linkResolutionRequest.status,
      errorCode: linkResolutionRequest.errorCode,
      createdAt: linkResolutionRequest.createdAt,
      source: linkResolutionRequest.source,
      offerId: linkResolutionRequest.offerId,
      imageEmbeddingId: linkResolutionRequest.imageEmbeddingId,
    })
    .from(linkResolutionRequest)
    .where(eq(linkResolutionRequest.id, link.requestId))
    .limit(1);
  if (!row) return { state: "failed", errorCode: "unexpected" };

  if (row.status === "resolved" || row.status === "failed") {
    await reconcileLinkRequestCharge(db, row.id).catch((error: unknown) => {
      console.error(
        "chat link charge reconcile failed",
        error instanceof Error ? error.name : "unknown",
      );
    });
  }

  if (row.status === "failed") {
    return { state: "failed", errorCode: row.errorCode ?? "unexpected" };
  }
  if (row.status === "queued" || row.status === "processing") {
    return now.getTime() - row.createdAt.getTime() > IN_FLIGHT_TTL_MS
      ? { state: "stale" }
      : { state: "pending" };
  }
  const source = parseLinkSource(row.source);
  if (!source) {
    // Eski worker'ın çözdüğü satır: sinyal yok, arama yapılamaz (`getLinkSearchState` ile aynı).
    return { state: "failed", errorCode: "no_product" };
  }
  return {
    state: "resolved",
    linkState: {
      kind: "resolved",
      requestId: row.id,
      offerId: row.offerId,
      imageEmbeddingId: row.imageEmbeddingId,
      source,
    },
    textOnly: source.imageStatus !== "embedded",
  };
}

/**
 * Çözülmüşse sonuçları, mesajın tercihleriyle okur (`findLinkSearchResults`);
 * değilse `null`. `view` verilirse ikinci kez sorgulanmaz.
 */
export async function loadChatLinkResults(
  db: Database,
  link: Pick<ChatLinkPayload, "requestId" | "errorCode" | "preferences">,
  view?: ChatLinkView,
): Promise<LinkSearchResults | null> {
  const current = view ?? (await getChatLinkView(db, link));
  if (current.state !== "resolved") return null;
  return findLinkSearchResults(db, current.linkState, link.preferences);
}
