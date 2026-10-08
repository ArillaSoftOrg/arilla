/**
 * Link aramasının kullanıcı tercihleri (karar 0079). Sohbette URL'nin yanında
 * ya da takip mesajında gelen "daha ucuz", "siyah", "daha spor" gibi istekler
 * bu tipe çevrilir; `findLinkSearchResults` yalnızca mevcut katalog alanlarıyla
 * (fiyat, `product.color`, `product.attributes`, lexicon) uygular. Katalogda
 * karşılığı olmayan tercih uydurma bir özellikle UYGULANMAZ, `unapplied` ile
 * bildirilir.
 */
export interface LinkPreferences {
  /** Kuruş. `minPrice` ile aynı birim. */
  priceMinKurus?: number | null;
  priceMaxKurus?: number | null;
  /** Kanonik renk adları (lexicon `color`). */
  colors?: string[];
  /** Kanonik stil/malzeme etiketleri (lexicon `style` / `material`). */
  styles?: string[];
  /** "daha ucuz": uygun sonuçlar arasında fiyata göre artan sıralar. */
  sort?: "cheapest" | null;
}

export type LinkPreferenceKey = "price" | "color" | "style" | "sort";

export interface LinkPreferenceOutcome {
  /** Gerçekten uygulanan tercih grupları. */
  applied: LinkPreferenceKey[];
  /** İstenen ama katalog verisi yetersiz olduğu için uygulanamayanlar. */
  unapplied: LinkPreferenceKey[];
  /** Tercih yüzünden elenen aday sayısı (şeffaflık notu için). */
  droppedByPreferences: number;
}

export function hasLinkPreferences(preferences: LinkPreferences | undefined): boolean {
  if (!preferences) return false;
  return (
    preferences.priceMinKurus != null ||
    preferences.priceMaxKurus != null ||
    (preferences.colors?.length ?? 0) > 0 ||
    (preferences.styles?.length ?? 0) > 0 ||
    preferences.sort != null
  );
}
