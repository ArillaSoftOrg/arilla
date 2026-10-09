/**
 * Hak harcayan iki arama (docs/decisions/0047): fotograf ve link. Is kurali
 * burada (CLAUDE.md kural 6); `apps/web` action'lari yalnizca oturum, form
 * ve yanit eslemesi yapar.
 *
 * Sira: oran siniri (Redis, fail-closed) -> hak ayirma (PG) -> saglayici /
 * kuyruk -> kesinlestir | iade. Oran siniri reddi ve dogrulama hatasi hak
 * harcamaz. Redis erisilemezse `RedisUnavailableError` cagirana gecer ve
 * pahali islem yapilmaz.
 */
import type { Database } from "@arilla/db";
import { enqueueLinkResolution, findReusableLinkRequest } from "../discovery/link-resolution.ts";
import { checkLinkSearchUrl } from "../discovery/link-search-input.ts";
import { InvalidUrlError } from "../discovery/normalize-url.ts";
import { type EmbeddingClient, EmbeddingUnavailableError } from "../embedding/client.ts";
import { EmbeddingProviderError, embedUploadedImage } from "../embedding/embed-uploaded-image.ts";
import type { PreparedImage } from "../embedding/preprocess-image.ts";
import type { QuotaWindow } from "../quota/policy.ts";
import { isRedisUnavailableError } from "../redis/client.ts";
import {
  attachImageUpload,
  attachLinkRequest,
  type ChargeRecord,
  type RefundReason,
  refundCharge,
  settleCharge,
} from "./charge.ts";
import { checkAiSearchRateLimit } from "./rate-limit.ts";
import { reserveSearchReconciling } from "./reconcile.ts";

/** Hak harcamayan redler: arayuz her birine ayri metin gosterir. */
export type ChargeBlocked =
  | { status: "rate_limited" }
  /** Hak yok; `window` hangi pencerenin doldugunu soyler (arayuz metni). */
  | { status: "no_rights"; window: QuotaWindow }
  | { status: "busy" }
  /** Ayni istek anahtariyla onceki deneme iade edildi; istemci yeni anahtarla dener. */
  | { status: "retry" };

export type ChargedVisualSearchResult =
  | { status: "ok"; imageUploadId: number; chargedFromBonus: boolean }
  | ChargeBlocked;

function refundReasonFor(error: unknown): RefundReason {
  if (error instanceof EmbeddingProviderError) return "provider_error";
  if (error instanceof EmbeddingUnavailableError) return "provider_unavailable";
  return "internal_error";
}

async function reserveOrBlock(
  db: Database,
  input: { userId: number; operation: "visual_search" | "link_search"; requestKey: string },
): Promise<
  | { kind: "reserved"; charge: ChargeRecord }
  | { kind: "replay"; charge: ChargeRecord }
  | ChargeBlocked
> {
  const rate = await checkAiSearchRateLimit(input.userId);
  if (!rate.allowed) return { status: "rate_limited" };
  const reserved = await reserveSearchReconciling(db, input);
  switch (reserved.status) {
    case "reserved":
      return { kind: "reserved", charge: reserved.charge };
    case "replay":
      return { kind: "replay", charge: reserved.charge };
    case "exhausted":
      return { status: "no_rights", window: reserved.window };
    case "busy":
      return { status: "busy" };
  }
}

/**
 * Fotografla arama: basarili saglayici cagrisi (sifir sonuc ve embedding
 * onbellek isabeti dahil) bir hak harcar; saglayici/ic hata tam bir kez iade
 * eder. `prepared` cagiranin zaten dogruladigi/on isledigi gorseldir -
 * gecersiz gorsel hak harcamadan once reddedilmistir.
 */
export async function runChargedVisualSearch(
  db: Database,
  input: {
    userId: number;
    sessionId: string;
    requestKey: string;
    prepared: PreparedImage;
  },
  client: EmbeddingClient,
): Promise<ChargedVisualSearchResult> {
  const reservation = await reserveOrBlock(db, {
    userId: input.userId,
    operation: "visual_search",
    requestKey: input.requestKey,
  });
  if ("status" in reservation) return reservation;
  const { charge } = reservation;

  if (reservation.kind === "replay") {
    if (charge.state === "settled" && charge.imageUploadId !== null) {
      return {
        status: "ok",
        imageUploadId: charge.imageUploadId,
        chargedFromBonus: charge.fromBonus > 0,
      };
    }
    return charge.state === "reserved" ? { status: "busy" } : { status: "retry" };
  }

  let imageUploadId: number;
  try {
    const result = await embedUploadedImage(
      db,
      {
        bytes: input.prepared.bytes,
        prepared: input.prepared,
        mimeType: input.prepared.mimeType,
        sessionId: input.sessionId,
        userId: input.userId,
        onUploadCreated: (id) => attachImageUpload(db, charge.id, id),
      },
      client,
    );
    imageUploadId = result.imageUploadId;
  } catch (error) {
    // Sonuc yok: ayrilan hak geri verilir. Iade de basarisiz olursa gunluk
    // supurme `image_upload` durumuna bakip iade eder.
    await refundCharge(db, charge.id, refundReasonFor(error)).catch(() => undefined);
    throw error;
  }

  // Embedding yazildi. Kesinlestirme hata verirse IADE EDILMEZ: uzlasma
  // `image_upload.status = 'embedded'` gorup kesinlestirir.
  await settleCharge(db, charge.id, { imageUploadId });
  return { status: "ok", imageUploadId, chargedFromBonus: charge.fromBonus > 0 };
}

export type ChargedLinkSearchResult =
  | { status: "queued"; requestId: string; reused: boolean; chargedFromBonus: boolean }
  | ChargeBlocked;

/**
 * Link aramasi: yalnizca YENI cozumleme isi hak harcar. Onbellekteki ya da
 * hala islenen ayni link ucretsizdir (0035) ve oran sinirina da takilmaz.
 * Kuyruga yazilamazsa hemen iade. Sonuc (resolved/failed) durum
 * sorgusunda `reconcileLinkRequestCharge` ile kesinlesir/iade edilir.
 *
 * Gecersiz adres `InvalidUrlError` firlatir (hak harcanmaz).
 */
export async function runChargedLinkSearch(
  db: Database,
  input: { userId: number; sessionId: string; requestKey: string; urlRaw: string; now?: Date },
): Promise<ChargedLinkSearchResult> {
  const checked = checkLinkSearchUrl(input.urlRaw);
  if (!checked.ok) throw new InvalidUrlError(`link aramasına uygun değil: ${checked.reason}`);

  const existing = await findReusableLinkRequest(db, checked.normalized.url, input.now);
  if (existing) {
    return { status: "queued", requestId: existing.id, reused: true, chargedFromBonus: false };
  }

  const reservation = await reserveOrBlock(db, {
    userId: input.userId,
    operation: "link_search",
    requestKey: input.requestKey,
  });
  if ("status" in reservation) return reservation;
  const { charge } = reservation;

  if (reservation.kind === "replay") {
    if (charge.state !== "refunded" && charge.linkRequestId !== null) {
      return {
        status: "queued",
        requestId: charge.linkRequestId,
        reused: false,
        chargedFromBonus: charge.fromBonus > 0,
      };
    }
    return charge.state === "reserved" ? { status: "busy" } : { status: "retry" };
  }

  let enqueued: { requestId: string; reused: boolean };
  try {
    enqueued = await enqueueLinkResolution(
      db,
      { urlRaw: input.urlRaw, sessionId: input.sessionId, userId: input.userId },
      {
        now: input.now,
        onRequestCreated: (requestId) => attachLinkRequest(db, charge.id, requestId),
      },
    );
  } catch (error) {
    await refundCharge(
      db,
      charge.id,
      isRedisUnavailableError(error) ? "queue_unavailable" : "internal_error",
    ).catch(() => undefined);
    throw error;
  }

  if (enqueued.reused) {
    // Ayirma ile kuyruk arasinda baska biri ayni linki acti: yeni is yok,
    // hak geri verilir.
    await refundCharge(db, charge.id, "link_reused");
    return {
      status: "queued",
      requestId: enqueued.requestId,
      reused: true,
      chargedFromBonus: false,
    };
  }
  return {
    status: "queued",
    requestId: enqueued.requestId,
    reused: false,
    chargedFromBonus: charge.fromBonus > 0,
  };
}
