import { buildDataLayerPush, type GtmEventMap, type GtmEventName } from "@arilla/core/gtm";

/**
 * Karar 0219: dataLayer'a TEK giriş. Olay adı ve parametreler `docs/events.md`
 * "GTM / dataLayer" tablosuyla birebirdir; her push 9 anahtarın hepsini taşır
 * (kullanılmayanlar null: GTM değerleri sonraki push'a taşır). Kişisel veri
 * `buildDataLayerPush` süzgecinde düşer. Sunucuda ve GTM yokken zararsızdır.
 */
export function trackEvent<N extends GtmEventName>(name: N, params: GtmEventMap[N]): void {
  if (typeof window === "undefined") return;
  const push = buildDataLayerPush(name, params);
  if (!push) return;
  const w = window as unknown as { dataLayer?: unknown[] };
  w.dataLayer = w.dataLayer ?? [];
  w.dataLayer.push(push);
}
