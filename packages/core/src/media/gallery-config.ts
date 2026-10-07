/**
 * Urun gorsel galerisi sabitleri ve URL secimi (karar 0073).
 *
 * `MAX_DISPLAY_IMAGES` toplama tarafindaki `services/ingest/collect/images.py`
 * ile AYNI olmak zorundadir (TS ile Python birbirini cagirmaz); esitligi
 * `gallery-config.test.ts` dogrular. Kaynakta saklanan en fazla gorsel
 * (`MAX_SOURCE_IMAGES = 6`) yalnizca toplama tarafinin sabitidir: okuyucu
 * kaynak gorselleri bilmez, yalnizca `display_rank` verilenleri gorur.
 */
export const MAX_DISPLAY_IMAGES = 3;

export interface ImageUrlCandidates {
  /** Aynalanmis kopya (media.manicepte.com). Simdilik hep null. */
  r2Url?: string | null;
  /** Kaynak (merchant CDN) URL'si. */
  sourceUrl?: string | null;
  /** Eski `product.primary_image_url`. */
  legacyUrl?: string | null;
}

function usable(url: string | null | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

/**
 * Gosterilecek URL: `r2_url ?? source_url ?? legacy primary_image_url`.
 * Hicbiri yoksa null; arayuz yer tutucu gosterir.
 */
export function pickImageUrl({ r2Url, sourceUrl, legacyUrl }: ImageUrlCandidates): string | null {
  for (const candidate of [r2Url, sourceUrl, legacyUrl]) {
    if (usable(candidate)) return candidate.trim();
  }
  return null;
}
