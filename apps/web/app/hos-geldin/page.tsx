import { needsOnboarding, safeRedirectPath } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "../lib/dal.ts";
import { OnboardingClient } from "./onboarding-client.tsx";

export const metadata: Metadata = {
  title: "Hoş geldin",
  robots: { index: false, follow: false },
};

/**
 * İlk giriş karşılaması (karar 0059). Tamamlanmış hesap (`onboarded_at` dolu)
 * her girişte doğrudan hedefe gider: karşılama bir kez gösterilir. Hedef
 * `next`, güvenli iç yola süzülür.
 */
export default async function HosGeldinPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const user = await requireUser();
  const { next } = await searchParams;
  const target = safeRedirectPath(typeof next === "string" ? next : undefined);

  if (!(await needsOnboarding(getDatabase(), user.id))) {
    redirect(target);
  }

  return <OnboardingClient email={user.email} next={target} />;
}
