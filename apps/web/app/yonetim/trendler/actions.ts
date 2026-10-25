"use server";

import {
  createTrend,
  moveTrend,
  searchTrendProducts,
  setTrendCuration,
  setTrendFeatured,
  setTrendProducts,
  setTrendStatus,
  type TrendProductsResult,
  TrendValidationError,
  updateTrendDetails,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { requireCapability, requireFreshCapability } from "../../lib/dal.ts";
import { type TrendProductCardView, toCardView } from "./card-view.ts";

/**
 * `/yonetim/trendler` (karar 0086). İnce istemci: yetki (ikinci kez), doğrulama,
 * satır kilidi ve denetim kaydı core'da (`trends-admin.ts`). Her action
 * `trends.manage` + taze giriş ister: değişiklik kamuya açık `/trendler`'i etkiler.
 */
export type TrendActionResult =
  | { ok: true; changed: boolean }
  | { ok: false; message: string; reauthHref?: string };

const STALE = "Güvenlik için bu işlemden önce yeniden giriş yap (son girişin 1 saatten eski).";

function done(result: Awaited<ReturnType<typeof setTrendStatus>>): TrendActionResult {
  switch (result.status) {
    case "updated":
      revalidatePath("/yonetim/trendler");
      revalidatePath("/trendler", "layout");
      return { ok: true, changed: true };
    case "unchanged":
      return { ok: true, changed: false };
    case "not_found":
      return { ok: false, message: "Trend bulunamadı." };
    case "conflict":
      return { ok: false, message: "Trend bu arada değişti. Sayfayı yenileyip tekrar dene." };
    case "below_threshold":
      return {
        ok: false,
        message: `Yayın için en az ${result.required} gösterilebilir ürün gerekli (şu an ${result.showable}).`,
      };
  }
}

function failure(error: unknown): TrendActionResult {
  if (error instanceof TrendValidationError) return { ok: false, message: error.message };
  throw error;
}

export async function setTrendStatusAction(input: {
  trendId: number;
  next: string;
  expectedStatus: string;
  reason: string;
}): Promise<TrendActionResult> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("trends.manage");
  if (!fresh) return { ok: false, message: STALE, reauthHref };
  try {
    return done(
      await setTrendStatus(getDatabase(), actor, {
        trendId: input?.trendId,
        next: input?.next,
        expectedStatus: input?.expectedStatus,
        reason: input?.reason,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}

export async function setTrendFeaturedAction(input: {
  trendId: number;
  featured: boolean;
  reason: string;
}): Promise<TrendActionResult> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("trends.manage");
  if (!fresh) return { ok: false, message: STALE, reauthHref };
  try {
    return done(
      await setTrendFeatured(getDatabase(), actor, {
        trendId: input?.trendId,
        featured: input?.featured,
        reason: input?.reason,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}

export async function moveTrendAction(input: {
  trendId: number;
  direction: "up" | "down";
  reason: string;
}): Promise<TrendActionResult> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("trends.manage");
  if (!fresh) return { ok: false, message: STALE, reauthHref };
  try {
    return done(
      await moveTrend(getDatabase(), actor, {
        trendId: input?.trendId,
        direction: input?.direction,
        reason: input?.reason,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}

// --- Koleksiyon yönetimi (karar 0149) ------------------------------------------------------

function trendChanged(trendId: number, slug?: string) {
  revalidatePath("/yonetim/trendler");
  revalidatePath(`/yonetim/trendler/${trendId}`);
  revalidatePath("/trendler", "layout");
  if (slug) revalidatePath(`/trendler/${slug}`);
}

export async function createTrendAction(input: {
  slug: string;
  details: Record<string, unknown>;
  curation: string;
  featured: boolean;
  reason: string;
}): Promise<TrendActionResult & { trendId?: number }> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("trends.manage");
  if (!fresh) return { ok: false, message: STALE, reauthHref };
  try {
    const result = await createTrend(getDatabase(), actor, {
      slug: input?.slug,
      details: input?.details,
      curation: input?.curation,
      featured: input?.featured,
      reason: input?.reason,
    });
    if (result.status === "slug_taken") {
      return {
        ok: false,
        message: "Bu adres başka bir trendde kullanılıyor; başka bir adres seç.",
      };
    }
    revalidatePath("/yonetim/trendler");
    return { ok: true, changed: true, trendId: result.trendId };
  } catch (error) {
    return failure(error);
  }
}

export async function updateTrendDetailsAction(input: {
  trendId: number;
  expected: Record<string, unknown>;
  next: Record<string, unknown>;
  reason: string;
}): Promise<TrendActionResult> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("trends.manage");
  if (!fresh) return { ok: false, message: STALE, reauthHref };
  try {
    const result = await updateTrendDetails(getDatabase(), actor, {
      trendId: input?.trendId,
      expected: input?.expected,
      next: input?.next,
      reason: input?.reason,
    });
    if (result.status === "updated") trendChanged(input.trendId);
    return done(result);
  } catch (error) {
    return failure(error);
  }
}

export async function setTrendCurationAction(input: {
  trendId: number;
  next: string;
  expected: string;
  reason: string;
}): Promise<TrendActionResult> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("trends.manage");
  if (!fresh) return { ok: false, message: STALE, reauthHref };
  try {
    const result = await setTrendCuration(getDatabase(), actor, {
      trendId: input?.trendId,
      next: input?.next,
      expected: input?.expected,
      reason: input?.reason,
    });
    if (result.status === "updated") trendChanged(input.trendId);
    return done(result);
  } catch (error) {
    return failure(error);
  }
}

function productsMessage(result: TrendProductsResult): TrendActionResult {
  switch (result.status) {
    case "not_manual":
      return {
        ok: false,
        message: "Otomatik koleksiyonun ürünleri curate işinindir; önce türü “Elle seçilmiş” yap.",
      };
    case "archived":
      return { ok: false, message: "Arşivdeki koleksiyonun ürünleri değişmez; önce taslağa al." };
    case "invalid_products":
      return {
        ok: false,
        message: `Yayında olmayan ya da bulunamayan ürün: ${result.productIds.join(", ")}.`,
      };
    case "below_threshold":
      return {
        ok: false,
        message: `Yayındaki koleksiyonda en az ${result.required} gösterilebilir ürün kalmalı (yeni listede ${result.showable}).`,
      };
    default:
      return done(result);
  }
}

export async function setTrendProductsAction(input: {
  trendId: number;
  productIds: number[];
  expectedProductIds: number[];
  reason: string;
}): Promise<TrendActionResult> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("trends.manage");
  if (!fresh) return { ok: false, message: STALE, reauthHref };
  try {
    const result = await setTrendProducts(getDatabase(), actor, {
      trendId: input?.trendId,
      productIds: input?.productIds,
      expectedProductIds: input?.expectedProductIds,
      reason: input?.reason,
    });
    if (result.status === "updated") trendChanged(input.trendId);
    return productsMessage(result);
  } catch (error) {
    return failure(error);
  }
}

/** Salt okunur ürün araması (taze giriş gerekmez; yine `trends.manage` + `catalog.read`). */
export async function searchTrendProductsAction(input: {
  query: string;
  before?: number;
}): Promise<
  | { ok: true; rows: TrendProductCardView[]; nextBefore: number | null }
  | { ok: false; message: string }
> {
  const { actor } = await requireCapability("trends.manage");
  try {
    const result = await searchTrendProducts(getDatabase(), actor, {
      query: input?.query,
      before: input?.before,
    });
    return { ok: true, rows: result.rows.map(toCardView), nextBefore: result.nextBefore };
  } catch (error) {
    if (error instanceof TrendValidationError) return { ok: false, message: error.message };
    throw error;
  }
}
