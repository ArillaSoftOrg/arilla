"use server";

import { RateLimitExceededError, requestLoginLink } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { clientIp } from "../lib/client-ip.ts";

export type RequestLoginLinkState =
  | { status: "idle" }
  | { status: "sent" }
  | { status: "rate_limited" }
  | { status: "invalid_email" };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * decision 0006 / copy.md: `auth.rate_limited` mesajı hesabın var olup
 * olmadığını hiçbir zaman belli etmez - `requestLoginLink` zaten `app_user`
 * tablosuna dokunmuyor, burada da yalnızca "gönderildi" veya "oran sınırı"
 * durumları var, "böyle bir hesap yok" gibi bir dal yok.
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
    throw error;
  }

  return { status: "sent" };
}
