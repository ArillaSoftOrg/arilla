import {
  isRedisUnavailableError,
  PhoneCodeInvalidError,
  RateLimitExceededError,
  readAppUrl,
  signInWithPhone,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { clientIp } from "../../../lib/client-ip.ts";
import { isSameOriginPost } from "../../../lib/same-origin.ts";
import { setSessionCookie } from "../../../lib/session-cookie.ts";
import { PHONE_COOKIE, PHONE_COOKIE_PATH } from "../phone-cookie.ts";

function seeOther(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, readAppUrl() ?? request.url), 303);
}

/** Kodu dogrular; dogruysa mevcut oturum cerezi (`session`) yazilir. */
export async function POST(request: Request) {
  if (!isSameOriginPost(request)) return seeOther(request, "/giris/telefon?hata=gecersiz");

  const store = await cookies();
  const phone = store.get(PHONE_COOKIE)?.value;
  if (!phone) return seeOther(request, "/giris/telefon?hata=sure");

  const form = await request.formData();
  const code = String(form.get("code") ?? "");
  const headerStore = await headers();

  try {
    const { rawSessionToken } = await signInWithPhone(getDatabase(), {
      phone,
      code,
      ip: clientIp(headerStore.get("x-forwarded-for")),
      userAgent: headerStore.get("user-agent"),
    });
    await setSessionCookie(rawSessionToken);
  } catch (error) {
    if (error instanceof PhoneCodeInvalidError) {
      return seeOther(request, "/giris/telefon?adim=kod&hata=kod");
    }
    if (error instanceof RateLimitExceededError) {
      return seeOther(request, "/giris/telefon?adim=kod&hata=sinir");
    }
    if (isRedisUnavailableError(error)) {
      console.error("[giris] phone verify rate limit unavailable");
      return seeOther(request, "/giris/telefon?adim=kod&hata=gonderilemedi");
    }
    throw error;
  }

  store.delete({ name: PHONE_COOKIE, path: PHONE_COOKIE_PATH });
  return seeOther(request, "/");
}
