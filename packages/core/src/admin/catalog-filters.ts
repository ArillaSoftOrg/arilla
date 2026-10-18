/**
 * `/yonetim/katalog/urunler` filtreleri: adres parametresi → doğrulanmış süzgeç.
 *
 * Saf modül (veritabanı yok): her değer sabit bir listeye ya da dar bir desene
 * karşı denetlenir; tanınmayan değer sessizce düşer (filtre uygulanmaz). SQL
 * karşılıkları `catalog.ts`'tedir. Değerler İngilizce, adres anahtarları Türkçe
 * (mevcut `kalite`, `durum`, `sorun` ile aynı düzen).
 */

import {
  isProductIssueFilter,
  isProductQualityFilter,
  isProductStateFilter,
  type ProductSearchFilter,
} from "./catalog.ts";

/**
 * Sınıflandırma durumu (karar 0133, `product_classification`):
 * - `applied`: kural kategoriyi belirledi (yazdı ya da mevcut değeri korudu).
 * - `auto_written`: iş ürüne marka ya da kategori YAZDI (`wrote_*`).
 * - `review`: kanıt yetersiz/çelişkili, ürüne yazılmadı.
 * - `error`: işlenemedi (ör. eşzamanlı değişiklik); sonraki tarama yeniden dener.
 * - `unscanned`: kanıt satırı yok (iş bu ürüne henüz gelmedi).
 */
export const PRODUCT_CLASSIFICATION_FILTERS = [
  "applied",
  "auto_written",
  "review",
  "error",
  "unscanned",
] as const;
export type ProductClassificationFilter = (typeof PRODUCT_CLASSIFICATION_FILTERS)[number];

/**
 * Kategori kararının güven puanı (`product_classification.confidence`, 0–100).
 * `high` yazma eşiğidir (≥ 80, karar 0133); altı ürüne yazılmaz.
 */
export const PRODUCT_CONFIDENCE_FILTERS = ["high", "medium", "low"] as const;
export type ProductConfidenceFilter = (typeof PRODUCT_CONFIDENCE_FILTERS)[number];
export const CONFIDENCE_HIGH_MIN = 80;
export const CONFIDENCE_MEDIUM_MIN = 50;

/** Fiyat özeti: TL fiyatlı, yalnız yurt dışı fiyatlı (karar 0127), hiç fiyatsız. */
export const PRODUCT_PRICE_FILTERS = ["try", "foreign_only", "none"] as const;
export type ProductPriceFilter = (typeof PRODUCT_PRICE_FILTERS)[number];

export const PRODUCT_IMAGE_FILTERS = ["with", "without"] as const;
export type ProductImageFilter = (typeof PRODUCT_IMAGE_FILTERS)[number];

/**
 * Fiyat ÖZETİNİN son değiştiği an (`price_updated_at`, karar 0051): mağaza
 * fiyatının tazeliği değil. `stale` = 7+ gün ya da hiç (`stale_price` ile aynı).
 */
export const PRODUCT_FRESHNESS_FILTERS = ["1d", "7d", "30d", "stale"] as const;
export type ProductFreshnessFilter = (typeof PRODUCT_FRESHNESS_FILTERS)[number];
export const FRESHNESS_DAYS: Record<Exclude<ProductFreshnessFilter, "stale">, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
};

/** Marka/kategori süzgecinde "atanmamış" değeri. */
export const UNASSIGNED = "none";

const MERCHANT_SLUG = /^[a-z0-9-]{1,80}$/;
const CATEGORY_PATH = /^[a-z0-9-]{1,80}(\/[a-z0-9-]{1,80}){0,5}$/;
const ID = /^\d{1,15}$/;

function oneOf<T extends string>(list: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function positiveId(value: string | undefined): number | undefined {
  if (!value || !ID.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Marka süzgeci: kimlik, `none` ya da ad/slug (en çok 80 karakter, birebir eşleşme). */
export type ProductBrandFilter = number | typeof UNASSIGNED | { name: string };

export function parseBrandFilter(value: string | undefined): ProductBrandFilter | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (raw === UNASSIGNED) return UNASSIGNED;
  const id = positiveId(raw);
  if (id !== undefined) return id;
  return { name: raw.slice(0, 80) };
}

export function brandFilterParam(filter: ProductBrandFilter | undefined): string | undefined {
  if (filter === undefined) return undefined;
  if (typeof filter === "number") return String(filter);
  if (filter === UNASSIGNED) return UNASSIGNED;
  return filter.name;
}

/** Adres parametreleri (`searchParams`); hepsi isteğe bağlı. */
export interface ProductListParams {
  q?: string;
  kalite?: string;
  sorun?: string;
  durum?: string;
  magaza?: string;
  marka?: string;
  kategori?: string;
  siniflandirma?: string;
  guven?: string;
  fiyat?: string;
  gorsel?: string;
  guncellik?: string;
  once?: string;
  sonra?: string;
  sayfa?: string;
  urun?: string;
}

/** Sayfalamayı ve paneli taşımayan filtre anahtarları (bağlantı üretimi için). */
export const PRODUCT_FILTER_KEYS = [
  "q",
  "durum",
  "magaza",
  "marka",
  "kategori",
  "siniflandirma",
  "guven",
  "fiyat",
  "gorsel",
  "guncellik",
  "kalite",
  "sorun",
] as const satisfies readonly (keyof ProductListParams)[];
export type ProductFilterKey = (typeof PRODUCT_FILTER_KEYS)[number];

/**
 * Adres → süzgeç. Geçersiz değerler düşer; `durum` verilmezse `published`
 * (`searchProducts` varsayılanı). `once`/`sonra` anahtar kümeli imleçtir
 * (`p.id`); ikisi birden gelirse `once` kazanır. Eski `sayfa` (ofset) korunur.
 */
export function parseProductListParams(params: ProductListParams): {
  filter: ProductSearchFilter;
  /** Doğrulanmış, adrese geri yazılabilir filtre değerleri (sayfalama ve panel hariç). */
  state: Partial<Record<ProductFilterKey, string>>;
  panelId: number | undefined;
} {
  const query = params.q?.trim().slice(0, 80) || undefined;
  const quality = isProductQualityFilter(params.kalite) ? params.kalite : undefined;
  const issue = isProductIssueFilter(params.sorun) ? params.sorun : undefined;
  const pubState = isProductStateFilter(params.durum) ? params.durum : undefined;
  const merchant = params.magaza && MERCHANT_SLUG.test(params.magaza) ? params.magaza : undefined;
  const brand = parseBrandFilter(params.marka);
  const category =
    params.kategori === UNASSIGNED
      ? UNASSIGNED
      : params.kategori && CATEGORY_PATH.test(params.kategori)
        ? params.kategori
        : undefined;
  const classification = oneOf(PRODUCT_CLASSIFICATION_FILTERS, params.siniflandirma);
  const confidence = oneOf(PRODUCT_CONFIDENCE_FILTERS, params.guven);
  const price = oneOf(PRODUCT_PRICE_FILTERS, params.fiyat);
  const image = oneOf(PRODUCT_IMAGE_FILTERS, params.gorsel);
  const freshness = oneOf(PRODUCT_FRESHNESS_FILTERS, params.guncellik);
  const before = positiveId(params.once);
  const after = before === undefined ? positiveId(params.sonra) : undefined;
  const page = before === undefined && after === undefined ? positiveId(params.sayfa) : undefined;

  return {
    filter: {
      query,
      quality,
      issue,
      state: pubState,
      merchant,
      brand,
      category,
      classification,
      confidence,
      price,
      image,
      freshness,
      before,
      after,
      page,
    },
    state: {
      q: query,
      durum: pubState,
      magaza: merchant,
      marka: brandFilterParam(brand),
      kategori: category,
      siniflandirma: classification,
      guven: confidence,
      fiyat: price,
      gorsel: image,
      guncellik: freshness,
      kalite: quality,
      sorun: issue,
    },
    panelId: positiveId(params.urun),
  };
}

/** Varsayılandan farklı (kullanıcının seçtiği) filtre sayısı; `durum=published` sayılmaz. */
export function activeFilterCount(state: Partial<Record<ProductFilterKey, string>>): number {
  return PRODUCT_FILTER_KEYS.filter((key) => {
    const value = state[key];
    if (!value) return false;
    return !(key === "durum" && value === "published");
  }).length;
}
