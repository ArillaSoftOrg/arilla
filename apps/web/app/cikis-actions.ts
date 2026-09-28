"use server";

import { deleteSession } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { redirect } from "next/navigation";
import { clearSessionCookie, readSessionCookie } from "./lib/session-cookie.ts";

/**
 * Çıkış: bu cihazın `session` satırı silinir, çerez temizlenir. Server
 * action olduğu için yalnızca POST ile çağrılır ve Next kaynak (Origin)
 * denetimini kendisi yapar; başka bir site kullanıcıyı çıkışa zorlayamaz.
 * Yönlendirme sabit `/` - istemciden gelen bir adrese gidilmez.
 */
export async function logoutAction(): Promise<void> {
  const rawToken = await readSessionCookie();
  if (rawToken) {
    await deleteSession(getDatabase(), rawToken);
  }
  await clearSessionCookie();
  redirect("/");
}
