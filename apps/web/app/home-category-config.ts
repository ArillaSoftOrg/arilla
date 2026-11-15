export type HomeCategoryId = "mobilya" | "moda" | "parfum";

export interface HomeCategorySuggestion {
  label: string;
  query: string;
}

export interface HomeCategoryOption {
  id: HomeCategoryId;
  label: string;
  mobileImageSrcs: readonly string[];
  desktopImageSrcs: readonly string[];
  suggestions: readonly HomeCategorySuggestion[];
}

export const DEFAULT_HOME_CATEGORY: HomeCategoryId = "parfum";

export const HOME_CATEGORY_OPTIONS = [
  {
    id: "mobilya",
    label: "Mobilya",
    mobileImageSrcs: [
      "/görsel/optimized/mobilya-koltuk-kosesi.webp",
      "/görsel/optimized/mobilya-bej-naturmort.webp",
    ],
    desktopImageSrcs: [
      "/görsel/desktop/optimized/mobilya-minimalist-salon.webp",
      "/görsel/desktop/optimized/mobilya-modern-salon-dekoru.webp",
    ],
    suggestions: [
      { label: "Berjer koltuk", query: "Modern bir berjer koltuk" },
      { label: "Çalışma masası", query: "Küçük bir çalışma masası" },
      { label: "Minimal kitaplık", query: "Minimal bir kitaplık" },
    ],
  },
  {
    id: "moda",
    label: "Moda",
    mobileImageSrcs: [
      "/görsel/optimized/moda-siyah-canta.webp",
      "/görsel/optimized/moda-deri-orgu.webp",
    ],
    desktopImageSrcs: [
      "/görsel/desktop/optimized/moda-luks-vinyet.webp",
      "/görsel/desktop/optimized/moda-bej-canta-aksesuar.webp",
      "/görsel/desktop/optimized/moda-aksesuar-giysi.webp",
    ],
    suggestions: [
      { label: "Siyah omuz çantası", query: "Zarif siyah bir omuz çantası" },
      { label: "Beyaz spor ayakkabı", query: "Günlük beyaz spor ayakkabı" },
      { label: "Keten gömlek", query: "Rahat kesim keten gömlek" },
    ],
  },
  {
    id: "parfum",
    label: "Parfüm",
    mobileImageSrcs: [
      "/görsel/optimized/parfum-lacivert-sis.webp",
      "/görsel/optimized/parfum-amber-zambak.webp",
      "/görsel/optimized/parfum-incir.webp",
      "/görsel/optimized/parfum-yesil-altin.webp",
    ],
    desktopImageSrcs: [
      "/görsel/desktop/optimized/parfum-altin-narenciye.webp",
      "/görsel/desktop/optimized/parfum-botanik-kompozisyon.webp",
      "/görsel/desktop/optimized/parfum-amber-beyaz-cicek.webp",
    ],
    suggestions: [
      { label: "Kalıcı odunsu parfüm", query: "Kalıcı odunsu bir parfüm" },
      { label: "Günlük ferah koku", query: "Günlük kullanıma uygun ferah bir koku" },
      { label: "Sonbahar parfümü", query: "Sonbahar için sıcak bir parfüm" },
    ],
  },
] as const satisfies readonly HomeCategoryOption[];

const CATEGORY_SALT: Record<HomeCategoryId, number> = {
  mobilya: 0x2c1b3c6d,
  moda: 0x5a17d9e3,
  parfum: 0x7f4a7c15,
};

function variantIndex(seed: number, categoryId: HomeCategoryId, length: number): number {
  let mixed = (seed >>> 0) ^ CATEGORY_SALT[categoryId];
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  return ((mixed ^ (mixed >>> 16)) >>> 0) % length;
}

export function selectHomeCategoryImages(
  category: HomeCategoryOption,
  visitSeed: number,
): { mobile: string; desktop: string } {
  const mobile =
    category.mobileImageSrcs[variantIndex(visitSeed, category.id, category.mobileImageSrcs.length)];
  const desktop =
    category.desktopImageSrcs[
      variantIndex(visitSeed ^ 0x6d2b79f5, category.id, category.desktopImageSrcs.length)
    ];
  if (!mobile || !desktop) throw new Error(`Ana sayfa görseli eksik: ${category.id}`);
  return { mobile, desktop };
}

export function homeCategoryOption(id: HomeCategoryId): HomeCategoryOption {
  return HOME_CATEGORY_OPTIONS.find((option) => option.id === id) ?? HOME_CATEGORY_OPTIONS[0];
}
