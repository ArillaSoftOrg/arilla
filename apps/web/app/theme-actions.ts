"use server";

import { cookies } from "next/headers";

/** Karar 0007: elle secilen tema tercihi cereze yazilir. */
export async function setTheme(theme: "light" | "dark"): Promise<void> {
  const store = await cookies();
  store.set("theme", theme, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}
