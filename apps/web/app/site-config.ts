// Alt yol: `@arilla/core` kökü `pg`yi çeker; bu dosya istemci paketlerine de girer.
import { LEGAL_IDENTITY } from "@arilla/core/legal-identity";

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

/**
 * Yayindaki marka adi (karar 0008: isim koda dagitilmaz). Header, footer,
 * kok metadata, giris ekrani ve lansman oncesi landing buradan okur.
 * Yasal metinler de ayni markayi kullanir (`LEGAL_IDENTITY.brandName`,
 * 6 Ekim 2026). Tescilli unvan ayri alandir (`legalEntityName`).
 */
export const SITE_BRAND = "ManiCepte";

export type SocialNetwork = "instagram" | "tiktok" | "linkedin";

/**
 * Resmi sosyal medya hesaplari - tek kaynak. `null` = dogrulanmis hesap yok;
 * arayuz o baglantiyi HIC gostermez (yer tutucu, tahmini kullanici adi ya da
 * takipci sayisi yok). Hesap acildiginda yalnizca bu nesne degisir.
 */
export const SOCIAL_PROFILES: Readonly<Record<SocialNetwork, string | null>> = {
  instagram: "https://www.instagram.com/manicepte.tr",
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
