"use server";

import {
  EmailDeliveryError,
  isRedisUnavailableError,
  RateLimitExceededError,
  requestLoginLink,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { clientIp } from "../lib/client-ip.ts";

export type RequestLoginLinkState =
  | { status: "idle" }
  | { status: "sent" }
  | { status: "rate_limited" }
  | { status: "invalid_email" }
  | { status: "send_failed" };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * decision 0006 / copy.md: `auth.rate_limited` mesajı hesabın var olup
 * olmadığını hiçbir zaman belli etmez - `requestLoginLink` zaten `app_user`
 * tablosuna dokunmuyor, burada da "gönderildi", "oran sınırı" ve "gönderim
 * başarısız" durumları var, "böyle bir hesap yok" gibi bir dal yok.
 *
 * `send_failed`: e-posta gerçekten gönderilemediyse "gönderdik" denmez.
 * Bu dal da hesap varlığından bağımsızdır (gönderim her e-posta için aynı
 * yoldan denenir).
 */
export async function requestLoginLinkAction(
  _prevState: RequestLoginLinkState,
  formData: FormData,
): Promise<RequestLoginLinkState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    return { status: "invalid_email" };
  }

  const headerStore = await headers();
  const ip = clientIp(headerStore.get("x-forwarded-for"));

  try {
    await requestLoginLink(getDatabase(), { email, ip });
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return { status: "rate_limited" };
    }
    if (error instanceof EmailDeliveryError) {
      // Yalnizca hata kodu loglanir: alici adresi ve token'li baglanti
      // (kisisel veri / gizli) hata kayitlarina girmez.
      console.error(`[giris] login email delivery failed: ${error.code}`);
      return { status: "send_failed" };
    }
    if (isRedisUnavailableError(error)) {
      // Oran siniri kontrol edilemiyorsa kapali kalinir: sinirsiz giris
      // e-postasi gonderilmez.
      console.error("[giris] rate limit unavailable");
      return { status: "send_failed" };
    }
    throw error;
  }

  return { status: "sent" };
}
