"use server";

import {
  CampaignValidationError,
  campaignIdForProcessing,
  cancelCampaign,
  createCampaignDraft,
  processMarketingCampaigns,
  sendCampaignTest,
  startCampaignSend,
  TEST_SENDS_PER_HOUR,
  updateCampaignDraft,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { requireCapability, requireFreshCapability } from "../../lib/dal.ts";
import { SITE_BRAND } from "../../site-config.ts";

/**
 * `/yonetim/kampanyalar` (docs/decisions/0048). İnce istemci: doğrulama,
 * yetki (ikinci kez), durum geçişleri ve denetim kaydı core'da
 * (`packages/core/src/marketing`). Her action `marketing.manage`'i kendisi
 * ister; gerçek gönderim ayrıca taze giriş ister (docs/decisions/0044).
 */

export type CampaignActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; message: string; reauthHref?: string };

function failure(error: unknown): { ok: false; message: string } {
  if (error instanceof CampaignValidationError) return { ok: false, message: error.message };
  throw error;
}

function refresh(): void {
  revalidatePath("/yonetim/kampanyalar", "layout");
}

export async function createCampaignAction(input: {
  title: string;
  subject: string;
  body: string;
}): Promise<CampaignActionResult<{ publicId: string }>> {
  const { actor } = await requireCapability("marketing.manage");
  try {
    const created = await createCampaignDraft(getDatabase(), actor, {
      title: input?.title,
      subject: input?.subject,
      body: input?.body,
    });
    refresh();
    return { ok: true, publicId: created.publicId };
  } catch (error) {
    return failure(error);
  }
}

export async function updateCampaignAction(input: {
  publicId: string;
  expectedContentVersion: number;
  title: string;
  subject: string;
  body: string;
}): Promise<CampaignActionResult<{ changed: boolean; contentVersion: number }>> {
  const { actor } = await requireCapability("marketing.manage");
  try {
    const result = await updateCampaignDraft(getDatabase(), actor, {
      publicId: input?.publicId,
      expectedContentVersion: input?.expectedContentVersion,
      title: input?.title,
      subject: input?.subject,
      body: input?.body,
    });
    if (result.status === "not_found") return { ok: false, message: "Kampanya bulunamadı." };
    refresh();
    return {
      ok: true,
      changed: result.status === "updated",
      contentVersion: result.contentVersion,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function sendTestAction(input: {
  publicId: string;
  expectedContentVersion: number;
  recipient: string;
}): Promise<CampaignActionResult> {
  const { actor } = await requireCapability("marketing.manage");
  try {
    const result = await sendCampaignTest(
      getDatabase(),
      actor,
      {
        publicId: input?.publicId,
        expectedContentVersion: input?.expectedContentVersion,
        recipient: input?.recipient,
      },
      { brand: SITE_BRAND },
    );
    switch (result.status) {
      case "sent":
        refresh();
        return { ok: true };
      case "not_found":
        return { ok: false, message: "Kampanya bulunamadı." };
      case "rate_limited":
        return {
          ok: false,
          message: `Saatte en fazla ${TEST_SENDS_PER_HOUR} test gönderimi yapılabilir. Biraz sonra tekrar dene.`,
        };
      case "failed":
        return {
          ok: false,
          message: `Test e-postası gönderilemedi (${result.code}). E-posta yapılandırmasını kontrol et.`,
        };
    }
  } catch (error) {
    return failure(error);
  }
}

export async function startSendAction(input: {
  publicId: string;
  expectedContentVersion: number;
  confirmed: boolean;
}): Promise<CampaignActionResult<{ alreadyStarted: boolean; recipientCount: number | null }>> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("marketing.manage");
  if (!fresh) {
    // docs/copy.md `admin.login.reauth`
    return {
      ok: false,
      message: "Güvenlik için bu işlemden önce yeniden giriş yap (son girişin 1 saatten eski).",
      reauthHref,
    };
  }
  const db = getDatabase();
  let result: Awaited<ReturnType<typeof startCampaignSend>>;
  try {
    result = await startCampaignSend(db, actor, {
      publicId: input?.publicId,
      expectedContentVersion: input?.expectedContentVersion,
      confirmed: input?.confirmed,
    });
  } catch (error) {
    return failure(error);
  }
  if (result.status === "not_found") return { ok: false, message: "Kampanya bulunamadı." };
  if (result.status === "already_started") {
    refresh();
    return { ok: true, alreadyStarted: true, recipientCount: null };
  }

  // İlk parti hemen (sınırlı süre ve ileti sayısı); kalanı cron ya da
  // "sonraki partiyi işle". Hata gönderimin başlamış olmasını geri almaz.
  try {
    await processMarketingCampaigns(db, { brand: SITE_BRAND, campaignId: result.campaignId });
  } catch (error) {
    console.error(`[pazarlama] ilk parti islenemedi: ${(error as Error).name}`);
  }
  refresh();
  return { ok: true, alreadyStarted: false, recipientCount: result.recipientCount };
}

export async function processNextBatchAction(
  publicId: string,
): Promise<CampaignActionResult<{ sent: number; failed: number; skipped: number }>> {
  const { actor } = await requireCapability("marketing.manage");
  const db = getDatabase();
  let campaignId: number | null;
  try {
    campaignId = await campaignIdForProcessing(db, actor, publicId);
  } catch (error) {
    return failure(error);
  }
  if (campaignId === null) {
    refresh();
    return { ok: false, message: "Bu kampanya şu anda gönderilmiyor." };
  }
  const result = await processMarketingCampaigns(db, { brand: SITE_BRAND, campaignId });
  refresh();
  if (result.stoppedBy === "configuration_error" || result.stoppedBy === "bulk_send_disabled") {
    return {
      ok: false,
      message: "Parti işlenemedi: e-posta yapılandırması ya da gönderim kapısı.",
    };
  }
  return { ok: true, sent: result.sent, failed: result.failed, skipped: result.skipped };
}

export async function cancelCampaignAction(publicId: string): Promise<CampaignActionResult> {
  const { actor } = await requireCapability("marketing.manage");
  try {
    const result = await cancelCampaign(getDatabase(), actor, publicId);
    refresh();
    if (result.status === "not_found") return { ok: false, message: "Kampanya bulunamadı." };
    if (result.status === "not_cancellable") {
      return { ok: false, message: "Bu kampanya artık iptal edilemez." };
    }
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
