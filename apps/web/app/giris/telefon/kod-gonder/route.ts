import {
  getSmsSender,
  InvalidPhoneNumberError,
  isRedisUnavailableError,
  normalizePhoneE164,
  RateLimitExceededError,
  readAppUrl,
  requestPhoneLoginCode,
  SmsDeliveryError,
  SmsUnavailableError,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { clientIp } from "../../../lib/client-ip.ts";
import { isSameOriginPost } from "../../../lib/same-origin.ts";
import { PHONE_COOKIE, PHONE_COOKIE_MAX_AGE_SECONDS, PHONE_COOKIE_PATH } from "../phone-cookie.ts";

function seeOther(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, readAppUrl() ?? request.url), 303);
}

/** Telefon kodu isteme. Hesabin var olup olmadigini belli eden bir dal yok. */
export async function POST(request: Request) {
  if (!isSameOriginPost(request)) return seeOther(request, "/giris/telefon?hata=gecersiz");

  const form = await request.formData();
  const phone = normalizePhoneE164(String(form.get("phone") ?? ""));
  if (!phone) return seeOther(request, "/giris/telefon?hata=numara");

  const headerStore = await headers();
  const ip = clientIp(headerStore.get("x-forwarded-for"));

  try {
    await requestPhoneLoginCode(getDatabase(), { phone, ip }, getSmsSender());
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) {
      return seeOther(request, "/giris/telefon?hata=numara");
    }
    if (error instanceof RateLimitExceededError) {
      return seeOther(request, "/giris/telefon?hata=sinir");
    }
    if (
      error instanceof SmsDeliveryError ||
      error instanceof SmsUnavailableError ||
      isRedisUnavailableError(error)
    ) {
      // Yalnizca hata turu: numara ve kod loga girmez.
      console.error(
        `[giris] phone code not sent: ${error instanceof Error ? error.name : "unknown"}`,
      );
      return seeOther(request, "/giris/telefon?hata=gonderilemedi");
    }
    throw error;
  }

  const store = await cookies();
  store.set(PHONE_COOKIE, phone, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: PHONE_COOKIE_PATH,
    maxAge: PHONE_COOKIE_MAX_AGE_SECONDS,
  });
  return seeOther(request, "/giris/telefon?adim=kod");
}
