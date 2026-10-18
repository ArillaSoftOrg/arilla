import type {
  ClassificationRunStatus,
  ProductClassificationFilter,
  ProductConfidenceFilter,
  ProductFreshnessFilter,
  ProductImageFilter,
  ProductPriceFilter,
  ProductQualityFilter,
  ProductStateFilter,
} from "@arilla/core";
import type { StatusTone } from "../../admin-ui.tsx";

/**
 * Ürünler ekranının Türkçe etiketleri. Değerler core'da İngilizce kalır;
 * tanınmayan değer (ör. sınıflandırıcıya yeni eklenen bir dayanak) ham haliyle
 * gösterilir, gizlenmez.
 */

export const QUALITY_LABELS: Record<ProductQualityFilter, string> = {
  no_brand: "Markası bilinmeyen",
  no_category: "Kategorisiz",
  no_image: "Görselsiz",
  no_offers: "Aktif mağazası yok",
  no_price: "Fiyatsız",
  // Karar 0051: mağaza fiyatının eskiliği DEĞİL; fiyat özetinin son değiştiği an.
  stale_price: "Fiyat özeti 7+ gündür değişmedi",
  foreign_only: "Yalnız yurt dışı fiyatlı",
};

/** Yayın durumu (karar 0121): kaynak ilanı taslakları varsayılan listede yok. */
export const STATE_LABELS: Record<ProductStateFilter, string> = {
  published: "Yayında",
  draft: "Taslak (kaynak ilanı)",
  ready: "Hazır (yayın bekliyor)",
  held: "Beklemede",
  all: "Tümü",
};

export const PUBLICATION_BADGES: Record<string, { label: string; tone: StatusTone }> = {
  published: { label: "Yayında", tone: "success" },
  ready: { label: "Hazır", tone: "info" },
  draft: { label: "Taslak", tone: "neutral" },
  held: { label: "Beklemede", tone: "warning" },
};

export function publicationBadge(state: string): { label: string; tone: StatusTone } {
  return PUBLICATION_BADGES[state] ?? { label: state, tone: "neutral" };
}

export const CLASSIFICATION_FILTER_LABELS: Record<ProductClassificationFilter, string> = {
  applied: "Uygulandı",
  auto_written: "Sistem yazdı (marka ya da kategori)",
  review: "İnceleme gerekiyor",
  error: "Hata",
  unscanned: "Taranmadı",
};

export const CONFIDENCE_LABELS: Record<ProductConfidenceFilter, string> = {
  high: "Yüksek (80+, yazma eşiği)",
  medium: "Orta (50–79)",
  low: "Düşük (0–49)",
};

export const PRICE_LABELS: Record<ProductPriceFilter, string> = {
  try: "TL fiyatlı",
  foreign_only: "Yalnız yurt dışı fiyatlı",
  none: "Fiyatsız",
};

export const IMAGE_LABELS: Record<ProductImageFilter, string> = {
  with: "Görselli",
  without: "Görselsiz",
};

export const FRESHNESS_LABELS: Record<ProductFreshnessFilter, string> = {
  "1d": "Son 24 saatte değişti",
  "7d": "Son 7 günde değişti",
  "30d": "Son 30 günde değişti",
  stale: "7+ gündür değişmedi ya da hiç",
};

const CLASSIFICATION_STATE_BADGES: Record<string, { label: string; tone: StatusTone }> = {
  applied: { label: "Uygulandı", tone: "success" },
  review: { label: "İnceleme", tone: "warning" },
  error: { label: "Hata", tone: "critical" },
};

export function classificationBadge(state: string | null): { label: string; tone: StatusTone } {
  if (state === null) return { label: "Taranmadı", tone: "neutral" };
  return CLASSIFICATION_STATE_BADGES[state] ?? { label: state, tone: "neutral" };
}

/** `product_classification.brand_basis` (karar 0133). */
const BRAND_BASIS_LABELS: Record<string, string> = {
  existing: "Mevcut değer korundu",
  source: "Mağaza alanı",
  title: "Başlıktan",
  none: "Kanıt yok",
  ambiguous: "Belirsiz (birden çok marka)",
};

/** `product_classification.category_basis` (karar 0133). */
const CATEGORY_BASIS_LABELS: Record<string, string> = {
  existing: "Mevcut değer korundu",
  source: "Mağaza kategorisi",
  source_title: "Mağaza kategorisi + başlık",
  title: "Yalnız başlık",
  none: "Kanıt yok",
  conflict: "Çelişkili kanıt",
  low_confidence: "Düşük güven",
};

/** `product_classification.detail`: inceleme/hata nedeni. */
const DETAIL_LABELS: Record<string, string> = {
  weak_source: "Mağaza kategorisi zayıf eşleşti",
  weak_title: "Başlık eşleşmesi zayıf",
  title_conflict: "Başlık birden çok kategoriye uyuyor",
  no_evidence: "Kategori kanıtı yok",
  concurrent_change: "Ürün işlem sırasında başka yerden değişti",
};

export function brandBasisLabel(value: string): string {
  return BRAND_BASIS_LABELS[value] ?? value;
}

export function categoryBasisLabel(value: string): string {
  return CATEGORY_BASIS_LABELS[value] ?? value;
}

export function classificationDetailLabel(value: string | null): string {
  if (value === null) return "—";
  return DETAIL_LABELS[value] ?? value;
}

export const RUN_STATUS_BADGES: Record<
  ClassificationRunStatus,
  { label: string; tone: StatusTone }
> = {
  never: { label: "Hiç çalışmadı", tone: "neutral" },
  running: { label: "Çalışıyor", tone: "info" },
  stalled: { label: "İlerlemiyor", tone: "warning" },
  failed: { label: "Son koşu başarısız", tone: "critical" },
  completed: { label: "Tamamlandı", tone: "success" },
  paused: { label: "Duraklatıldı (tamamlanmadı)", tone: "warning" },
};

/** Güven puanı tonu: yazma eşiği 80 (karar 0133). */
export function confidenceTone(confidence: number): StatusTone {
  if (confidence >= 80) return "success";
  if (confidence >= 50) return "warning";
  return "critical";
}

/** Kategori yolunun son iki bölümü ("elektronik/ses/kulaklik" → "ses › kulaklik"). */
export function shortCategory(path: string): string {
  const parts = path.split("/");
  return parts.slice(-2).join(" › ");
}
