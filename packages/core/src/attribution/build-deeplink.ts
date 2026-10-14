/**
 * Saf fonksiyon - DB'ye dokunmaz. docs/architecture.md SS6 adim 2-3:
 * "Merchant'in affiliate durumu okunur" / "Uygunsa deeplink_template ile
 * takipli link uretilir". Placeholder sozlesmesi packages/db/scripts/seed.ts'te
 * zaten kurulu: yalnizca {url} ve {click_id} gercek veride var; {tracking_id}
 * ileri-uyumluluk icin desteklenir ama sablon icermiyorsa hicbir sey yapmaz.
 *
 * Karar 0113: `{affiliate_url}` = kaynagin (or. Admitad beslemesinin) teklif
 * basina takip baglantisi; kanonik `offer.url`'den AYRI saklanir. Sablon bunu
 * kullaniyorsa ag kurallarina gore yonetici yazar (or. "{affiliate_url}&subid={click_id}");
 * kod alt-kimlik parametresini tahmin etmez. Teklifte takip baglantisi yoksa
 * click yine kayitlidir ve kanonik adrese gidilir (komisyon takibi o tiklamada yok).
 */

export interface BuildDeeplinkInput {
  affiliateStatus: "none" | "pending" | "active" | "suspended";
  deeplinkTemplate: string | null;
  offerUrl: string;
  /** offer.affiliate_url (yalnizca https; migration 0066 CHECK). */
  affiliateUrl?: string | null;
  clickId: string;
  /** creator_affiliate_account.tracking_id - Model A: yalnizca creator'in kendi hesabi varsa dolu. */
  trackingId?: string | null;
}

export function buildDeeplink(input: BuildDeeplinkInput): string {
  if (input.affiliateStatus !== "active" || !input.deeplinkTemplate) {
    return input.offerUrl;
  }

  const template = input.deeplinkTemplate;
  const usesAffiliate = template.includes("{affiliate_url}");
  if ((!template.includes("{url}") && !usesAffiliate) || !template.includes("{click_id}")) {
    // Yanlis yapilandirilmis merchant: sessizce duz URL'e dusmek yerine
    // gurultulu basarisiz ol - CLAUDE.md kural 8, attribution kaydi
    // olmadan link uretilmez.
    throw new Error(`deeplink_template gecersiz: {url} veya {click_id} eksik ("${template}")`);
  }
  if (usesAffiliate && !input.affiliateUrl?.startsWith("https://")) {
    return input.offerUrl;
  }

  let resolved = template
    // Takip baglantisi temel adrestir: kodlanmaz, oldugu gibi yerlesir.
    .replaceAll("{affiliate_url}", input.affiliateUrl ?? "")
    .replaceAll("{url}", encodeURIComponent(input.offerUrl))
    .replaceAll("{click_id}", encodeURIComponent(input.clickId));

  if (template.includes("{tracking_id}")) {
    resolved = resolved.replaceAll("{tracking_id}", encodeURIComponent(input.trackingId ?? ""));
  }

  return resolved;
}
