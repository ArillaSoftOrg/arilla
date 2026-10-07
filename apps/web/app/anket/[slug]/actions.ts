"use server";

import {
  recordOnboardingNewsletterDecision,
  type SubmitFormResult,
  skipForm,
  submitForm,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../../lib/client-ip.ts";
import { verifySession } from "../../lib/dal.ts";
import { NEWSLETTER_OPT_IN_FIELD, NEWSLETTER_STEP_FIELD } from "./survey-wizard.ts";

export type SurveyActionResult = SubmitFormResult | { status: "session_expired" };

/** Yanıtın geldiği yer ipucu; yalnızca izin listesindeki değerler (aksi halde `link`). */
function sourceHint(value: unknown): "link" | "account" {
  return value === "account" ? "account" : "link";
}

/**
 * `/anket/<slug>` gönderimi (docs/decisions/0058). İş kurallarının tamamı
 * core'da (`submitForm`); burada yalnızca oturum ve IP okunur.
 *
 * - Kullanıcı yalnızca sunucudaki oturumdan gelir; formdaki hiçbir alan
 *   kimlik taşımaz (bilinmeyen alan formu reddeder).
 * - `expectedSignedIn`: sayfa girişli çizildiyse istemci `true` gönderir.
 *   Güven değil, yalnızca beklenti: oturum bu arada düştüyse yanıt sessizce
 *   anonim yazılmaz, kullanıcıya tekrar giriş önerilir.
 * - Beklenmeyen hata sabit bir durum olarak döner; logda cevap, kimlik ya da
 *   e-posta yer almaz.
 */
export async function submitSurveyAction(
  slug: string,
  expectedSignedIn: boolean,
  hint: string,
  formData: FormData,
): Promise<SurveyActionResult> {
  try {
    const user = await verifySession();
    if (expectedSignedIn === true && !user) return { status: "session_expired" };
    // Bülten alanları anket cevabı değildir: formdan ayrılır, `submitForm` bilinmeyen alan görmez.
    const fields = [...formData.entries()].filter(
      ([key]) =>
        key !== "kaynak" && key !== NEWSLETTER_STEP_FIELD && key !== NEWSLETTER_OPT_IN_FIELD,
    );
    const ip = clientIp(await headers());
    const safeSlug = typeof slug === "string" ? slug : "";
    const result = await submitForm(getDatabase(), {
      slug: safeSlug,
      fields,
      user: user ? { id: user.id } : null,
      ip,
      source: sourceHint(hint),
    });
    // Onboarding'in son adımı: yalnızca başarılı gönderimden sonra ve adım gösterildiyse.
    // Açık seçim yoksa (dokunulmadı) `false`; ilk karar sonradan değişmez (karar 0060).
    if (result.status === "ok" && user && formData.get(NEWSLETTER_STEP_FIELD) === "1") {
      await recordOnboardingNewsletterDecision(getDatabase(), {
        slug: safeSlug,
        userId: user.id,
        newsletter: formData.get(NEWSLETTER_OPT_IN_FIELD) === "1",
        ip,
      });
    }
    return result;
  } catch {
    console.error("[forms] unexpected failure");
    return { status: "unavailable" };
  }
}

/**
 * "Şimdilik geç": tamamlandı SAYILMAZ, erken erişim kaydına dokunmaz. Form
 * Hesabım'dan sonra doldurulabilir. Başarıda erken erişim sayfasına (ya da
 * Hesabım'dan geldiyse Hesabım'a) döner.
 */
export async function skipSurveyAction(slug: string, hint: string): Promise<void> {
  const user = await verifySession();
  const result = await skipForm(getDatabase(), {
    slug: typeof slug === "string" ? slug : "",
    user: user ? { id: user.id } : null,
  });
  if (result.status === "ok" || result.status === "already_responded") {
    // Atla = bülten kapalı (karar 0060). İlk karar sabit; zaten karar varsa no-op.
    if (user) {
      try {
        await recordOnboardingNewsletterDecision(getDatabase(), {
          slug: typeof slug === "string" ? slug : "",
          userId: user.id,
          newsletter: false,
          ip: clientIp(await headers()),
        });
      } catch {
        console.error("[forms] onboarding newsletter skip failed");
      }
    }
    redirect(sourceHint(hint) === "account" ? "/hesap" : "/erken-erisim");
  }
  redirect(`/anket/${encodeURIComponent(typeof slug === "string" ? slug : "")}`);
}
