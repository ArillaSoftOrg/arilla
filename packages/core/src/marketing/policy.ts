/**
 * Pazarlama gönderiminin ortam kapısı. Saf fonksiyon: ağ ve veritabanı yok.
 *
 * `MARKETING_EMAIL_MODE`:
 * - `off` (varsayılan, tanımsızken de): hiçbir pazarlama e-postası gitmez.
 * - `allowlist`: yalnızca `MARKETING_EMAIL_ALLOWLIST` içindeki adreslere —
 *   ekip içi deneme. Rıza ve bastırma kontrolleri YİNE uygulanır.
 * - `live`: gerçek alıcılar. Yalnızca Vercel production'da
 *   (`VERCEL_ENV=production`) ve yasal kimlik tamamken kabul edilir; ayrıca
 *   rıza dış sistemde (İYS) senkronlanmış olmalıdır.
 *
 * Yerel geliştirme, test ve preview `live` olamaz: yanlış `.env` gerçek
 * kullanıcılara kampanya gönderemez. Hata mesajları değişken DEĞERİ içermez.
 */
import { isLegalIdentityComplete } from "../config/legal-identity.ts";
import { isDeliverableEmailShape, normalizeEmail } from "./email-hash.ts";

export type MarketingMode = "off" | "allowlist" | "live";

export interface MarketingPolicy {
  mode: MarketingMode;
  from: string | null;
  replyTo: string | null;
  /** Normalize edilmiş adresler; yalnızca `allowlist` kipinde anlamlı. */
  allowlist: ReadonlySet<string>;
  /** Rızanın İYS'de `synced` olması şart mı. `live` kipinde her zaman true. */
  requireExternalSync: boolean;
}

export class MarketingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketingConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export interface MarketingPolicyOptions {
  /** Test kancası; varsayılan `LEGAL_IDENTITY` üzerinden. */
  legalIdentityComplete?: boolean;
}

export function marketingPolicyFromEnv(
  env: Env = process.env,
  options: MarketingPolicyOptions = {},
): MarketingPolicy {
  const rawMode = nonEmpty(env.MARKETING_EMAIL_MODE)?.toLowerCase() ?? "off";
  if (rawMode !== "off" && rawMode !== "allowlist" && rawMode !== "live") {
    throw new MarketingConfigError(
      'MARKETING_EMAIL_MODE yalnizca "off", "allowlist" veya "live" olabilir.',
    );
  }
  const mode: MarketingMode = rawMode;

  if (mode === "off") {
    return { mode, from: null, replyTo: null, allowlist: new Set(), requireExternalSync: true };
  }

  const from = nonEmpty(env.MARKETING_EMAIL_FROM);
  if (!from) {
    throw new MarketingConfigError(
      "MARKETING_EMAIL_FROM tanimli degil. .env.example dosyasina bakin.",
    );
  }
  const replyTo = nonEmpty(env.MARKETING_EMAIL_REPLY_TO) ?? null;
  if (replyTo && !isDeliverableEmailShape(replyTo.replace(/^.*<([^>]+)>\s*$/, "$1"))) {
    throw new MarketingConfigError("MARKETING_EMAIL_REPLY_TO gecerli bir adres degil.");
  }

  if (mode === "allowlist") {
    const entries = (env.MARKETING_EMAIL_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length === 0) {
      throw new MarketingConfigError(
        "MARKETING_EMAIL_MODE=allowlist icin MARKETING_EMAIL_ALLOWLIST bos olamaz.",
      );
    }
    if (entries.some((entry) => !isDeliverableEmailShape(entry))) {
      throw new MarketingConfigError("MARKETING_EMAIL_ALLOWLIST gecersiz bir adres iceriyor.");
    }
    return {
      mode,
      from,
      replyTo,
      allowlist: new Set(entries.map(normalizeEmail)),
      requireExternalSync: false,
    };
  }

  // live
  if (env.NODE_ENV !== "production" || env.VERCEL_ENV?.trim() !== "production") {
    throw new MarketingConfigError(
      "MARKETING_EMAIL_MODE=live yalnizca Vercel production ortaminda kullanilabilir.",
    );
  }
  if (!(options.legalIdentityComplete ?? isLegalIdentityComplete())) {
    throw new MarketingConfigError(
      "MARKETING_EMAIL_MODE=live icin yasal kimlik (legal-identity.ts) tamamlanmali: ticari iletide gonderen kimligi zorunlu.",
    );
  }
  return { mode, from, replyTo, allowlist: new Set(), requireExternalSync: true };
}
