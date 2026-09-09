/**
 * Saf fonksiyon - DB'ye dokunmaz. docs/architecture.md SS6 adim 2-3:
 * "Merchant'in affiliate durumu okunur" / "Uygunsa deeplink_template ile
 * takipli link uretilir". Placeholder sozlesmesi packages/db/scripts/seed.ts'te
 * zaten kurulu: yalnizca {url} ve {click_id} gercek veride var; {tracking_id}
 * ileri-uyumluluk icin desteklenir ama sablon icermiyorsa hicbir sey yapmaz.
 */

export interface BuildDeeplinkInput {
  affiliateStatus: "none" | "pending" | "active" | "suspended";
  deeplinkTemplate: string | null;
  offerUrl: string;
  clickId: string;
  /** creator_affiliate_account.tracking_id - Model A: yalnizca creator'in kendi hesabi varsa dolu. */
  trackingId?: string | null;
}

export function buildDeeplink(input: BuildDeeplinkInput): string {
  if (input.affiliateStatus !== "active" || !input.deeplinkTemplate) {
    return input.offerUrl;
  }

  const template = input.deeplinkTemplate;
  if (!template.includes("{url}") || !template.includes("{click_id}")) {
    // Yanlis yapilandirilmis merchant: sessizce duz URL'e dusmek yerine
    // gurultulu basarisiz ol - CLAUDE.md kural 8, attribution kaydi
    // olmadan link uretilmez.
    throw new Error(`deeplink_template gecersiz: {url} veya {click_id} eksik ("${template}")`);
  }

  let resolved = template
    .replaceAll("{url}", encodeURIComponent(input.offerUrl))
    .replaceAll("{click_id}", encodeURIComponent(input.clickId));

  if (template.includes("{tracking_id}")) {
    resolved = resolved.replaceAll("{tracking_id}", encodeURIComponent(input.trackingId ?? ""));
  }

  return resolved;
}
