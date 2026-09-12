/**
 * E4 icin disari acik tipler. Modul adi bilerek `discovery-feed` -
 * `packages/core/src/discovery/` (kok catch-all link cozumleme, D4) ile
 * karismasin diye ayri tutuldu; ikisi de "discovery" kelimesini farkli
 * anlamlarda kullaniyor.
 */
import type { publicFind } from "@arilla/db";

export type PublicFindSource = (typeof publicFind.$inferSelect)["source"];

export interface DiscoveryFeedItem {
  productId: number;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  minPrice: number | null;
  offerCount: number;
  source: PublicFindSource;
  /** Yalnizca organic icin dolu - "bu hafta" gibi bulaniklastirilmis. */
  foundLabel: string | null;
}

export interface DealItem {
  productId: number;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  currentPrice: number;
  /** `median_90d` referans alinir - bkz. get-deals.ts basligi. */
  baselinePrice: number;
  savingsKurus: number;
  savingsPercent: number;
}
