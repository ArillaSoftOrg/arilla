import { parseMeasurementId } from "@arilla/core/ga4-measurement";

/**
 * Karar 0087: GA4 ölçümü bu dağıtımda etkin mi (geçerli ölçüm kimliği var mı).
 * Yasal metinler, CSP ve kök layout aynı koşulu kullanır; kimlik değişirse
 * yeniden dağıtım gerekir (CSP derlemede üretilir).
 */
export function isGa4MeasurementActive(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return parseMeasurementId(env.GA4_MEASUREMENT_ID) !== null;
}
