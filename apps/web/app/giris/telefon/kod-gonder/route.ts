import {
  classifyPhoneSendFailure,
  getSmsSender,
  InvalidPhoneNumberError,
  isRedisUnavailableError,
  normalizePhoneE164,
  RateLimitExceededError,
  readAppUrl,
  requestPhoneLoginCode,
  SmsDeliveryError,
  SmsUnavailableError,
  UnsupportedPhoneCountryError,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { clientIp } from "../../../lib/client-ip.ts";
import { isSameOriginPost } from "../../../lib/same-origin.ts";
import { rememberAuthNext } from "../../next-cookie.ts";
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
  const ip = clientIp(headerStore);

  try {
    await requestPhoneLoginCode(getDatabase(), { phone, ip }, getSmsSender());
  } catch (error) {
    // Alt sinif once: desteklenmeyen ulke ayri mesaj alir (SMS hic gitmez).
    if (error instanceof UnsupportedPhoneCountryError) {
      return seeOther(request, "/giris/telefon?hata=ulke");
    }
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
      // Yalnizca kategori (`sms:netgsm:30`, `sms_unavailable`, ...): numara,
      // kod ve mesaj metni loga girmez. Gonderilemeyen kod kullanilamaz
      // durumda kalir (`requestPhoneLoginCode`).
      console.error(`[giris] phone code not sent: ${classifyPhoneSendFailure(error)}`);
      return seeOther(request, "/giris/telefon?hata=gonderilemedi");
    }
    throw error;
  }

  const store = await cookies();
  // Tekrar gönder formu `next` taşımaz; o durumda ilk adımdaki çerez korunur.
  const next = form.get("next");
  if (typeof next === "string") rememberAuthNext(store, next);
  store.set(PHONE_COOKIE, phone, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: PHONE_COOKIE_PATH,
    maxAge: PHONE_COOKIE_MAX_AGE_SECONDS,
  });
  return seeOther(request, "/giris/telefon?adim=kod");
}
