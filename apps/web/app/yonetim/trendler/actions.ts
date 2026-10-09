"use server";

import { moveTrend, setTrendFeatured, setTrendStatus, TrendValidationError } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { requireFreshCapability } from "../../lib/dal.ts";

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
