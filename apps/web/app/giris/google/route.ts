import { generateRawToken, requireAppUrl } from "@arilla/core";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const STATE_COOKIE = "google_oauth_state";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

function googleClientId(): string {
  const value = process.env.GOOGLE_CLIENT_ID;
  if (!value) {
    throw new Error("GOOGLE_CLIENT_ID tanimli degil. .env.example dosyasina bakin.");
  }
  return value;
}

export async function GET() {
  const appUrl = requireAppUrl();
  const state = generateRawToken();
  const store = await cookies();

  store.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", googleClientId());
  url.searchParams.set("redirect_uri", `${appUrl}/giris/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");

  redirect(url.toString());
}
