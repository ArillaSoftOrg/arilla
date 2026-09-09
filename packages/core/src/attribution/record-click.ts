/**
 * docs/architecture.md SS6 adim 1-4'un TypeScript karsiligi (302'nin kendisi
 * haric - o `apps/web`'in ileride yazacagi bir route handler'in isi). Her
 * cagri tam olarak bir `click` satiri uretir (CLAUDE.md kural 8).
 */
import { click, type Database, merchant, offer } from "@arilla/db";
import { eq } from "drizzle-orm";
import { buildDeeplink } from "./build-deeplink.ts";
import { findActiveTrackingId } from "./creator-affiliate-account.ts";
import type { RecordClickInput, RecordClickResult } from "./types.ts";

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

  const inserted = await db
    .insert(click)
    .values({
      userId: input.userId ?? null,
      sessionId: input.sessionId,
      creatorId: input.creatorId ?? null,
      offerId: input.offerId,
      channel: input.channel,
      surface: input.surface ?? null,
      priceAtClick: offerRow.offerPrice,
      sourceSimilarityKind: input.sourceSimilarityKind ?? null,
      resultPosition: input.resultPosition ?? null,
    })
    .returning({ id: click.id });

  const clickId = inserted[0]?.id;
  if (!clickId) {
    throw new Error("click insert bos sonuc dondurdu");
  }

  const redirectUrl = buildDeeplink({
    affiliateStatus: offerRow.affiliateStatus,
    deeplinkTemplate: offerRow.deeplinkTemplate,
    offerUrl: offerRow.offerUrl,
    clickId,
    trackingId,
  });

  return { clickId, redirectUrl };
}
