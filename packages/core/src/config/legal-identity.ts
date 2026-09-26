/**
 * Karar 0038: Arilla'yi isleten kisinin yasal kimliginin TEK kaynagi. Footer,
 * /sirket-bilgileri, /gizlilik, /kvkk-aydinlatma, /kosullar ve /iletisim
 * buradan okur; alanlar baska yerde tekrar yazilmaz.
 *
 * `null` = dogrulanmis deger yok. Arayuz `null` alani render ETMEZ - yer
 * tutucu, ornek telefon veya tahmini unvan asla gosterilmez. Sirket kurulup
 * tescil bilgileri dogrulandiginda yalnizca bu dosya degisir.
 *
 * Secret degildir, env'e konmaz: env'de tanimsiz kalirsa yasal sayfalar
 * sessizce eksik kalirdi.
 */
export interface LegalIdentity {
  brandName: string;
  /** Veri sorumlusu / isletmeci unvani. */
  legalEntityName: string | null;
  legalAddress: string | null;
  country: string | null;
  privacyEmail: string | null;
  supportEmail: string | null;
  mersisNo: string | null;
  taxOfficeAndNo: string | null;
  tradeRegistryNo: string | null;
  phone: string | null;
}

/**
 * GECICI e-posta: kurumsal alan adi alininca yalnizca bu iki satir degisir.
 * Faz 8.1'den beri /iletisim ve /gizlilik'te yayinda olan tek dogrulanmis
 * iletisim adresi. SMTP gondericisi DEGILDIR (`EMAIL_FROM` ayri).
 */
const CONTACT_EMAIL = "arillasoft@gmail.com";

export const LEGAL_IDENTITY: LegalIdentity = {
  brandName: "Arilla",
  legalEntityName: null,
  legalAddress: null,
  country: null,
  privacyEmail: CONTACT_EMAIL,
  supportEmail: CONTACT_EMAIL,
  mersisNo: null,
  taxOfficeAndNo: null,
  tradeRegistryNo: null,
  phone: null,
};

/** Yayina cikmadan once doldurulmasi gereken alanlar (docs/arilla_legal_pack/LEGAL_FIELDS_REQUIRED.md). */
export const REQUIRED_LEGAL_IDENTITY_FIELDS = [
  "legalEntityName",
  "legalAddress",
  "country",
  "privacyEmail",
  "supportEmail",
] as const satisfies readonly (keyof LegalIdentity)[];

export type RequiredLegalIdentityField = (typeof REQUIRED_LEGAL_IDENTITY_FIELDS)[number];

/** Bos veya yalnizca bosluk iceren deger de eksik sayilir. */
export function missingLegalIdentityFields(
  identity: LegalIdentity = LEGAL_IDENTITY,
): RequiredLegalIdentityField[] {
  return REQUIRED_LEGAL_IDENTITY_FIELDS.filter((field) => !identity[field]?.trim());
}

/** Zorunlu alanlarin hepsi dogrulanmis mi - degilse sayfalar "tescil bekleniyor" notunu gosterir. */
export function isLegalIdentityComplete(identity: LegalIdentity = LEGAL_IDENTITY): boolean {
  return missingLegalIdentityFields(identity).length === 0;
}
