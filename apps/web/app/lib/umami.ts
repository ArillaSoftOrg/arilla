import {
  type UmamiTrackerConfig,
  umamiTrackerAllowedByCsp,
  umamiTrackerFromEnv,
} from "@arilla/core/umami-tracker";

/**
 * Derlemede CSP'ye yazılan Umami kökeni. `next.config.ts` `env` ile DERLEMEDE gömülür
 * (çalışma ortamından okunmaz); CSP ile aynı kaynaktan (`securityHeaderOptionsFromEnv`).
 */
const CSP_UMAMI_ORIGIN = process.env.ARILLA_CSP_UMAMI_ORIGIN;

/**
 * Karar 0116: Umami ölçümü bu dağıtımda etkin mi (geçerli kök adres ve web sitesi
 * kimliği var mı VE derlemedeki CSP o kökene izin veriyor mu). Yasal metinler, CSP ve
 * kök layout aynı koşulu kullanır; değişirse yeniden derleme gerekir (CSP derlemede
 * üretilir). Çalışma ortamına sonradan eklenen değişkenler, CSP'nin engelleyeceği bir
 * betik bastırmaz. API anahtarı burada okunmaz: izleyici sır taşımaz.
 */
export function umamiTracker(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cspOrigin: string | undefined = CSP_UMAMI_ORIGIN,
): UmamiTrackerConfig | null {
  return umamiTrackerAllowedByCsp(umamiTrackerFromEnv(env), cspOrigin);
}

export function isUmamiTrackerActive(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cspOrigin: string | undefined = CSP_UMAMI_ORIGIN,
): boolean {
  return umamiTracker(env, cspOrigin) !== null;
}
