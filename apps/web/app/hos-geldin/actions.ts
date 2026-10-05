"use server";

import { completeOnboarding, safeRedirectPath } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../lib/client-ip.ts";
import { requireUser } from "../lib/dal.ts";

/**
 * Karşılamayı bitirir (karar 0059). `newsletter` yalnızca kullanıcı son adımda
 * kartı AÇIKÇA açtıysa `true`; devam (dokunmadan) ve Atla `false` gönderir.
 * İstemciden gelen değerler çalışma zamanında doğrulanır: `newsletter`
 * `=== true` ile daraltılır, `next` güvenli iç yola süzülür. İkinci çağrı
 * (karşılama zaten kapalı) hiçbir şey yazmaz; yine de yönlendirir.
 */
export async function completeOnboardingAction(input: {
  newsletter: boolean;
  next: string;
}): Promise<void> {
  const user = await requireUser();
  await completeOnboarding(getDatabase(), {
    userId: user.id,
    newsletter: input.newsletter === true,
    ip: clientIp(await headers()),
  });
  redirect(safeRedirectPath(input.next));
}
