/**
 * Formun o an gorunur / doldurulabilir olup olmadigi ve hedef kitle kapisi
 * (docs/decisions/0058). Saf fonksiyonlar.
 */
import type { FormAudience, FormStatus } from "@arilla/db";

export type FormAvailability = "open" | "draft" | "closed" | "not_started" | "ended";

export function formAvailability(
  form: { status: FormStatus; startsAt: Date | null; endsAt: Date | null },
  now: Date,
): FormAvailability {
  if (form.status === "draft") return "draft";
  if (form.status === "closed") return "closed";
  if (form.endsAt && form.endsAt <= now) return "ended";
  if (form.startsAt && form.startsAt > now) return "not_started";
  return "open";
}

export type AudienceGate = "ok" | "login_required" | "early_access_required";

/**
 * `public`: herkes. `authenticated`: giris. `early_access`: giris + erken
 * erisim listesinde olmak. `isEarlyAccessMember` yalnizca oturum varken anlamlidir.
 */
export function audienceGate(
  audience: FormAudience,
  user: { id: number } | null,
  isEarlyAccessMember: boolean,
): AudienceGate {
  if (audience === "public") return "ok";
  if (!user) return "login_required";
  if (audience === "early_access" && !isEarlyAccessMember) return "early_access_required";
  return "ok";
}
