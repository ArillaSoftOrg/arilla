import { type UmamiTrackerConfig, umamiTrackerFromEnv } from "@arilla/core/umami-tracker";

/**
 * Karar 0116: Umami ölçümü bu dağıtımda etkin mi (geçerli kök adres ve web sitesi
 * kimliği var mı). Yasal metinler, CSP ve kök layout aynı koşulu kullanır;
 * değişirse yeniden dağıtım gerekir (CSP derlemede üretilir). API anahtarı
 * burada okunmaz: izleyici sır taşımaz.
 */
export function umamiTracker(
  env: Readonly<Record<string, string | undefined>> = process.env,
): UmamiTrackerConfig | null {
  return umamiTrackerFromEnv(env);
}

export function isUmamiTrackerActive(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return umamiTrackerFromEnv(env) !== null;
}
