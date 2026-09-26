import { type GoogleProfile, requireAppUrl, signInWithGoogle } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../../../lib/client-ip.ts";
import { setSessionCookie } from "../../../lib/session-cookie.ts";

const STATE_COOKIE = "google_oauth_state";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

function googleClientId(): string {
  const value = process.env.GOOGLE_CLIENT_ID;
  if (!value) {
    throw new Error("GOOGLE_CLIENT_ID tanimli degil. .env.example dosyasina bakin.");
  }
  return value;
}

function googleClientSecret(): string {
  const value = process.env.GOOGLE_CLIENT_SECRET;
  if (!value) {
    throw new Error("GOOGLE_CLIENT_SECRET tanimli degil. .env.example dosyasina bakin.");
  }
  return value;
}

async function exchangeCodeForAccessToken(code: string): Promise<string> {
  const appUrl = requireAppUrl();
  const body = new URLSearchParams({
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    code,
    grant_type: "authorization_code",
    redirect_uri: `${appUrl}/giris/google/callback`,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error("Google OAuth token exchange failed");
  }

  const payload = (await response.json()) as { access_token?: unknown };
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("Google OAuth token response missing access_token");
  }
  return payload.access_token;
}

async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error("Google OAuth userinfo fetch failed");
  }

  const payload = (await response.json()) as {
    sub?: unknown;
    email?: unknown;
    email_verified?: unknown;
    name?: unknown;
    picture?: unknown;
  };
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new Error("Google OAuth userinfo response missing identity");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : null,
    picture: typeof payload.picture === "string" ? payload.picture : null,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const store = await cookies();
  const expectedState = store.get(STATE_COOKIE)?.value;
  store.delete(STATE_COOKIE);

  if (error || !code || !state || !expectedState || state !== expectedState) {
    redirect("/giris?error=google");
  }

  const headerStore = await headers();
  const ip = clientIp(headerStore.get("x-forwarded-for"));
  const userAgent = headerStore.get("user-agent");

  try {
    const accessToken = await exchangeCodeForAccessToken(code);
    const profile = await fetchGoogleProfile(accessToken);
    const { rawSessionToken } = await signInWithGoogle(getDatabase(), { profile, ip, userAgent });
    await setSessionCookie(rawSessionToken);
  } catch {
    console.error("[giris] google oauth failed");
    redirect("/giris?error=google");
  }

  redirect("/");
}
