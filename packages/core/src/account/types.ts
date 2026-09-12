/**
 * E2/E3 icin disari acik tipler. `attribution/types.ts` deseniyle ayni: DB
 * satir sekli degil, cagiran kodun gordugu sozlesme.
 */
import type { alert, userConsent } from "@arilla/db";

export type AlertKind = (typeof alert.$inferSelect)["kind"];
export type ConsentKind = (typeof userConsent.$inferSelect)["kind"];

export interface ProductSummary {
  productId: number;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  minPrice: number | null;
  offerCount: number;
}

export interface SavedItemView extends ProductSummary {
  savedAt: Date;
}

export interface AlertView extends ProductSummary {
  alertId: number;
  kind: AlertKind;
  /** Kurus cinsinden. Yalnizca `kind === 'price_drop'` icin dolu. */
  targetPrice: number | null;
  /** Yalnizca `kind === 'size_restock'` icin dolu. */
  sizeNorm: string | null;
  isActive: boolean;
  triggeredAt: Date | null;
  createdAt: Date;
}

export interface HistoryItemView extends ProductSummary {
  viewedAt: Date;
}

export interface CreateAlertInput {
  userId: number;
  productId: number;
  kind: AlertKind;
  targetPrice?: number | null;
  sizeNorm?: string | null;
}
