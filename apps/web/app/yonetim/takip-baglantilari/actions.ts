"use server";

import {
  createTrackingLink,
  setTrackingLinkActive,
  TrackingLinkValidationError,
  updateTrackingLink,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { requireFreshCapability } from "../../lib/dal.ts";

/**
 * `/yonetim/takip-baglantilari` (karar 0115). İnce istemci: yetki (ikinci kez
 * core'da), doğrulama, satır kilidi, önbellek geçersiz kılma ve denetim kaydı
 * core'da. Her action `links.manage` + taze giriş ister: değişiklik kamuya açık
 * kısa adresleri etkiler.
 */
export type LinkActionResult =
  | { ok: true; id?: number; changed: boolean }
  | { ok: false; message: string; reauthHref?: string };

const STALE = "Güvenlik için bu işlemden önce yeniden giriş yap (son girişin 1 saatten eski).";

function refresh(): void {
  revalidatePath("/yonetim/takip-baglantilari", "layout");
}

function failure(error: unknown): LinkActionResult {
  if (error instanceof TrackingLinkValidationError) return { ok: false, message: error.message };
  throw error;
}

function done(result: Awaited<ReturnType<typeof updateTrackingLink>>): LinkActionResult {
  switch (result.status) {
    case "created":
      refresh();
      return { ok: true, id: result.id, changed: true };
    case "updated":
      refresh();
      return { ok: true, changed: true };
    case "unchanged":
      return { ok: true, changed: false };
    case "slug_taken":
      return { ok: false, message: "Bu slug zaten kullanılıyor." };
    case "not_found":
      return { ok: false, message: "Bağlantı bulunamadı." };
    case "conflict":
      return { ok: false, message: "Bağlantı bu arada değişti. Sayfayı yenileyip tekrar dene." };
  }
}

export async function createTrackingLinkAction(input: {
  name: string;
  slug: string;
  targetUrl: string;
  source: string;
  campaign: string;
}): Promise<LinkActionResult> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("links.manage");
  if (!fresh) return { ok: false, message: STALE, reauthHref };
  try {
    return done(
      await createTrackingLink(getDatabase(), actor, {
        name: input?.name,
        slug: input?.slug,
        targetUrl: input?.targetUrl,
        source: input?.source,
        campaign: input?.campaign,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}

export async function updateTrackingLinkAction(input: {
  id: number;
  expectedUpdatedAt: string;
  name: string;
  targetUrl: string;
  source: string;
  campaign: string;
}): Promise<LinkActionResult> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("links.manage");
  if (!fresh) return { ok: false, message: STALE, reauthHref };
  try {
    return done(
      await updateTrackingLink(getDatabase(), actor, {
        id: input?.id,
        expectedUpdatedAt: input?.expectedUpdatedAt,
        name: input?.name,
        targetUrl: input?.targetUrl,
        source: input?.source,
        campaign: input?.campaign,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}

export async function setTrackingLinkActiveAction(input: {
  id: number;
  active: boolean;
}): Promise<LinkActionResult> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("links.manage");
  if (!fresh) return { ok: false, message: STALE, reauthHref };
  try {
    return done(
      await setTrackingLinkActive(getDatabase(), actor, { id: input?.id, active: input?.active }),
    );
  } catch (error) {
    return failure(error);
  }
}
