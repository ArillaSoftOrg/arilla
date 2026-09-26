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
