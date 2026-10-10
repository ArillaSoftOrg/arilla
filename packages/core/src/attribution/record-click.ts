/**
 * docs/architecture.md SS6 adim 1-4'un TypeScript karsiligi (302'nin kendisi
 * haric - o `apps/web`'in ileride yazacagi bir route handler'in isi). Her
 * cagri tam olarak bir `click` satiri uretir (CLAUDE.md kural 8).
 */
import { click, type Database, merchant, offer } from "@arilla/db";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { buildDeeplink } from "./build-deeplink.ts";
import { MAX_RESULT_POSITION } from "./click-request.ts";
import { findActiveTrackingId } from "./creator-affiliate-account.ts";
import type { RecordClickInput, RecordClickResult } from "./types.ts";

/**
 * `click.surface` serbest metin degildir: adres satirindan gelen deger
 * (`/git/:offerId?surface=`) yalnizca bu listedeyse yazilir, aksi halde NULL.
 * Attribution kaydina istemcinin sectigi keyfi metin girmez.
 */
export const CLICK_SURFACES = [
  "search",
  "collection",
  "alert",
  "compare",
  "product_primary",
  "structured_data",
] as const;
export type ClickSurface = (typeof CLICK_SURFACES)[number];

export function normalizeClickSurface(value: string | null | undefined): ClickSurface | null {
  return typeof value === "string" && (CLICK_SURFACES as readonly string[]).includes(value)
    ? (value as ClickSurface)
    : null;
}

/**
 * Ayni oturum ayni teklife bu sure icinde tekrar basarsa (cift tik, tarayici
 * yeniden denemesi, geri-ileri) yeni `click` satiri uretilmez; ilk satir
 * yeniden kullanilir. Bilincli ikinci tiklama (pencere disinda) yine sayilir.
 */
export const CLICK_DEDUPE_WINDOW_MS = 5_000;

export class OfferNotFoundError extends Error {
  constructor(offerId: number) {
    super(`offer bulunamadi: ${offerId}`);
    this.name = "OfferNotFoundError";
  }
}

export async function recordClick(
  db: Database,
  input: RecordClickInput,
): Promise<RecordClickResult> {
  const rows = await db
    .select({
      offerUrl: offer.url,
      offerPrice: offer.currentPrice,
      productId: offer.productId,
      merchantId: merchant.id,
      affiliateStatus: merchant.affiliateStatus,
      deeplinkTemplate: merchant.deeplinkTemplate,
    })
    .from(offer)
    .innerJoin(merchant, eq(merchant.id, offer.merchantId))
    .where(eq(offer.id, input.offerId))
    .limit(1);

  const offerRow = rows[0];
  if (!offerRow) {
    throw new OfferNotFoundError(input.offerId);
  }

  const trackingId = input.creatorId
    ? await findActiveTrackingId(db, input.creatorId, offerRow.merchantId)
    : null;

  // Idempotency: yakin zamanda ayni oturum+teklif(+creator) icin satir varsa onu kullan.
  // Es zamanli iki istek ayni anahtarda advisory lock ile siralanir (sema degisikligi
  // yok); lock islem sonunda otomatik birakilir, ikinci istek ilk satiri gorur.
  const since = new Date(Date.now() - CLICK_DEDUPE_WINDOW_MS);
  const { id: clickId, reused } = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`click:${input.sessionId}:${input.offerId}`}, 0))`,
    );
    const recent = await tx
      .select({ id: click.id })
      .from(click)
      .where(
        and(
          eq(click.sessionId, input.sessionId),
          eq(click.offerId, input.offerId),
          input.creatorId ? eq(click.creatorId, input.creatorId) : isNull(click.creatorId),
          gte(click.createdAt, since),
        ),
      )
      .orderBy(desc(click.createdAt))
      .limit(1);
    const existing = recent[0]?.id;
    if (existing) return { id: existing, reused: true };

    const inserted = await tx
      .insert(click)
      .values({
        userId: input.userId ?? null,
        sessionId: input.sessionId,
        creatorId: input.creatorId ?? null,
        offerId: input.offerId,
        // Guvenilir kaynak: teklifin kendi urunu; adres satirindan gelmez.
        productId: offerRow.productId ?? null,
        channel: input.channel,
        surface: normalizeClickSurface(input.surface),
        priceAtClick: offerRow.offerPrice,
        sourceSimilarityKind: input.sourceSimilarityKind ?? null,
        resultPosition: sanitizePosition(input.resultPosition),
      })
      .returning({ id: click.id });
    const id = inserted[0]?.id;
    if (!id) throw new Error("click insert bos sonuc dondurdu");
    return { id, reused: false };
  });

  const redirectUrl = buildDeeplink({
    affiliateStatus: offerRow.affiliateStatus,
    deeplinkTemplate: offerRow.deeplinkTemplate,
    offerUrl: offerRow.offerUrl,
    clickId,
    trackingId,
  });

  return { clickId, redirectUrl, deduplicated: reused };
}

function sanitizePosition(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isInteger(value) && value >= 1 && value <= MAX_RESULT_POSITION ? value : null;
}
