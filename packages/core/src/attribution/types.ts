/**
 * Attribution icin disari acik tipler. `search/result-types.ts` deseniyle
 * ayni: DB satir sekli degil, cagiran kodun gordugu sozlesme.
 */
import type { click } from "@arilla/db";

export type Channel = (typeof click.$inferSelect)["channel"];
export type SimilarityKind = "same" | "visual" | "semantic" | "substitute";

export interface RecordClickInput {
  offerId: number;
  sessionId: string;
  channel: Channel;
  userId?: number | null;
  creatorId?: number | null;
  surface?: string | null;
  /** decision 0013 / migration 0011: yalnizca alternatif listesinden gelen tiklamalar icin dolu. */
  sourceSimilarityKind?: SimilarityKind | null;
  resultPosition?: number | null;
}

export interface RecordClickResult {
  clickId: string;
  redirectUrl: string;
}
