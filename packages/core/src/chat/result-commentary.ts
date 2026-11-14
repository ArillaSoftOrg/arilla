/**
 * Sohbet sonuç değerlendirmesi, MODELSİZ (karar 0201; plan Faz 3). Saf fonksiyon.
 *
 * Yalnızca gösterilen katalog kartlarının DOĞRULANMIŞ alanlarından hesaplanan olgular: fiyat
 * aralığı, ortanca, mağaza ve marka dağılımı, fiyatsız ürün sayısı. Özellik, performans ya da
 * kalite iddiası YOKTUR (katalogda teknik özellik verisi yok). Cümleler ürün başlığı anmaz;
 * böylece henüz açılmamış (gizli) kartlara atıf yapılmaz. Arayüzde yasak sözcükler ("ucuz",
 * "satın al", "dupe") geçmez; büyük harf yok.
 *
 * Çeşitleme: aynı olgu için birkaç eşdeğer kalıp vardır; seçim sorgudan türetilen sabit
 * tohumla yapılır (aynı sorgu hep aynı cümleyi, farklı sorgular farklı kalıbı alır; test
 * edilebilir, rastgelelik yok).
 */
export interface CommentaryItem {
  /** Kuruş; yoksa `null`. */
  minPrice: number | null;
  brandName?: string | null;
  merchantName?: string | null;
  foreignPrice?: unknown;
}

export interface ResultCommentary {
  sentences: string[];
}

/** En az bu kadar kart yoksa değerlendirme yazılmaz (net/tek ürün aramasında gürültü). */
export const COMMENTARY_MIN_ITEMS = 3;

function seedOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash;
}

const tl = (kurus: number): string => `${Math.round(kurus / 100).toLocaleString("tr-TR")} TL`;

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function top(counts: Map<string, number>): { name: string; count: number } | null {
  let best: { name: string; count: number } | null = null;
  for (const [name, count] of counts) {
    if (!best || count > best.count || (count === best.count && name < best.name)) {
      best = { name, count };
    }
  }
  return best;
}

function tally(values: ReadonlyArray<string | null | undefined>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const name = value?.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

export function buildResultCommentary(
  items: readonly CommentaryItem[],
  options: { seed?: string } = {},
): ResultCommentary | null {
  if (items.length < COMMENTARY_MIN_ITEMS) return null;
  const variant = seedOf(options.seed ?? "");
  const sentences: string[] = [];

  const prices = items
    .map((item) => item.minPrice)
    .filter((value): value is number => value !== null && value > 0)
    .sort((a, b) => a - b);
  const missing = items.length - prices.length;
  if (prices.length >= 2) {
    const min = tl(prices[0] as number);
    const max = tl(prices[prices.length - 1] as number);
    const mid = tl(median(prices));
    if (min === max) {
      sentences.push(`Bu sonuçlarda fiyatlar ${min} civarında.`);
    } else {
      const forms = [
        `Bu sonuçlarda fiyatlar ${min} ile ${max} arasında; ortanca fiyat ${mid}.`,
        `En düşük fiyat ${min}, en yüksek ${max}; ortanca ${mid}.`,
        `${prices.length} üründe fiyat aralığı ${min} - ${max} (ortanca ${mid}).`,
      ];
      sentences.push(forms[variant % forms.length] as string);
    }
  }

  const stores = tally(items.map((item) => item.merchantName));
  const topStore = top(stores);
  if (topStore && stores.size >= 2) {
    const forms = [
      `Ürünler ${stores.size} farklı mağazadan; en çok ${topStore.name} (${topStore.count} ürün).`,
      `${stores.size} mağazanın ürünleri var, ${topStore.name} ${topStore.count} ürünle başta.`,
    ];
    sentences.push(forms[(variant >>> 3) % forms.length] as string);
  } else if (topStore && stores.size === 1 && topStore.count === items.length) {
    sentences.push(`Ürünlerin hepsi ${topStore.name} mağazasından.`);
  }

  const topBrand = top(tally(items.map((item) => item.brandName)));
  if (topBrand && topBrand.count >= 3 && topBrand.count * 2 >= items.length) {
    sentences.push(`${topBrand.name} markası öne çıkıyor (${topBrand.count} / ${items.length}).`);
  }

  if (missing > 0) {
    sentences.push(
      missing === 1
        ? "Bir üründe fiyat bilgisi yok; fiyat hesabına katılmadı."
        : `${missing} üründe fiyat bilgisi yok; fiyat hesabına katılmadı.`,
    );
  }
  if (items.some((item) => item.foreignPrice)) {
    sentences.push("Bazı fiyatlar yurt dışı mağazalara ait ve yaklaşık hesaplanmıştır.");
  }

  return sentences.length > 0 ? { sentences: sentences.slice(0, 4) } : null;
}
