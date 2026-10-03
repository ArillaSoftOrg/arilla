import { LEGAL_IDENTITY } from "@arilla/core";

/**
 * Faz 8.1 / karar 0038: public iletisim e-postasi. Tek kaynak
 * `packages/core/src/config/legal-identity.ts` - adres burada tekrar
 * yazilmaz; kurumsal e-posta alininca yalnizca o dosya degisir.
 *
 * Bu adres SMTP gondericisi DEGILDIR: giris/alarm e-postalari `EMAIL_FROM` ve
 * `SMTP_*` ile ayri yapilandirilir (bkz. .env.example).
 */
export const PUBLIC_CONTACT_EMAIL: string = LEGAL_IDENTITY.supportEmail ?? "";
export const PRIVACY_CONTACT_EMAIL: string = LEGAL_IDENTITY.privacyEmail ?? "";

/** Tanim `site-brand.ts`'de: istemci bilesenleri core'u cekmeden okuyabilsin. */
export { SITE_BRAND } from "./site-brand.ts";

export type SocialNetwork = "instagram" | "tiktok" | "linkedin";

/**
 * Resmi sosyal medya hesaplari - tek kaynak. `null` = dogrulanmis hesap yok;
 * arayuz o baglantiyi HIC gostermez (yer tutucu, tahmini kullanici adi ya da
 * takipci sayisi yok). Hesap acildiginda yalnizca bu nesne degisir.
 */
export const SOCIAL_PROFILES: Readonly<Record<SocialNetwork, string | null>> = {
  instagram: null,
  tiktok: null,
  linkedin: null,
};

const SOCIAL_LABELS: Readonly<Record<SocialNetwork, string>> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
};

export interface SocialLink {
  network: SocialNetwork;
  label: string;
  href: string;
}

/** Yalnizca tanimli ve `https://` olan hesaplar, sabit sirayla. */
export function configuredSocialLinks(
  profiles: Readonly<Record<SocialNetwork, string | null>> = SOCIAL_PROFILES,
): readonly SocialLink[] {
  return (Object.keys(SOCIAL_LABELS) as SocialNetwork[]).flatMap((network) => {
    const href = profiles[network]?.trim();
    if (!href) return [];
    try {
      if (new URL(href).protocol !== "https:") return [];
    } catch {
      return [];
    }
    return [{ network, label: SOCIAL_LABELS[network], href }];
  });
}
