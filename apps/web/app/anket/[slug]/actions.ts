"use server";

import { type SubmitFormResult, skipForm, submitForm } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../../lib/client-ip.ts";
import { verifySession } from "../../lib/dal.ts";

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
    const fields = [...formData.entries()].filter(([key]) => key !== "kaynak");
    return await submitForm(getDatabase(), {
      slug: typeof slug === "string" ? slug : "",
      fields,
      user: user ? { id: user.id } : null,
      ip: clientIp(await headers()),
      source: sourceHint(hint),
    });
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
    redirect(sourceHint(hint) === "account" ? "/hesap" : "/erken-erisim");
  }
  redirect(`/anket/${encodeURIComponent(typeof slug === "string" ? slug : "")}`);
}
