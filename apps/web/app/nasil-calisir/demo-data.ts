import type { IntentChip, SearchIntent } from "@arilla/core";
import { DEMO_PRODUCTS } from "../../data/demo/products.ts";
import type {
  ChatToolAccount,
  ChatToolBackend,
  ChatToolDetail,
} from "../sohbet/chat-product-model.ts";

// Marka/görseller mevcut, kaynakları kaydedilmiş örnek katalogdan gelir (data/demo/SOURCES.md).
// Sentetik kimlikler yalnızca bu gösterimin belleğinde kullanılır. Güncel fiyat/stok uydurulmaz.
const IDS = ["nike-air-force-1-07", "puma-suede-classic-xxi", "veja-campo-leather-white-black"];
export const DEMO_CARDS: ChatToolDetail[] = IDS.flatMap((id, index) => {
  const product = DEMO_PRODUCTS.find((item) => item.id === id);
  return product
    ? [
        {
          productId: index + 1,
          slug: product.id,
          title: product.title,
          brand: product.brand,
          imageUrl: product.imageUrl,
          displayPrice: "Fiyat mağazada",
          meta: "Tanıtım ürünü",
          color: null,
          stock: "Bu örnekte gösterilmiyor",
          variants: [],
          priceKurus: null,
          // Bu yerel örnek yalnızca hedef fiyat yazmayı gösterir, fiyat kontrolü/bildirim yapmaz.
          priceAlarmAvailable: true,
        },
      ]
    : [];
});
export const DEMO_NOTICE =
  "Tanıtım örneği. İşlemler hesabına kaydedilmez; gerçek alarm veya bildirim oluşturulmaz.";
export const DEMO_QUERY = "Günlük spor ayakkabı arıyorum.";
export const DEMO_BUDGET = "Bütçem en fazla 5.000 TL olsun.";

export const DEMO_PHASES = [
  { duration: 2600, caption: "Aradığını kendi cümlelerinle anlat." },
  { duration: 1800, caption: "Robot, yanıt hazırlanırken sana eşlik eder." },
  { duration: 3400, caption: "Ürün seçenekleri sohbetin içinde görünür." },
  { duration: 2400, caption: "Aynı sohbete bütçeni veya bir ayrıntıyı ekle." },
  { duration: 1600, caption: "Sohbet, eklediğin tercihle devam eder." },
  { duration: 3200, caption: "Tercihlerini filtrelerden de düzenleyebilirsin." },
  { duration: 2400, caption: "Kalbe dokunarak beğendiğin ürünü sakla." },
  { duration: 3200, caption: "Üç noktadan alarm, benzerler ve karşılaştırmaya ulaş." },
  { duration: 0, caption: "Şimdi kalbi, üç noktayı ve filtreleri sen deneyebilirsin." },
] as const;
export const DEMO_END = DEMO_PHASES.length - 1;

export function demoIntent(budget: boolean): SearchIntent {
  return {
    query: "günlük spor ayakkabı",
    category: null,
    brand: null,
    excludeBrands: [],
    colors: [],
    size: null,
    priceMin: null,
    priceMax: budget ? 5000 : null,
    attributes: {},
    sort: null,
  };
}
export function demoChips(budget: boolean): IntentChip[] {
  return [
    { key: "query", label: "spor ayakkabı" },
    ...(budget ? [{ key: "price", label: "En fazla 5.000 TL" }] : []),
  ];
}

/** Uzak eylem, model, çerez, depolama veya veritabanı bağlantısı içermez. Her gösterim bağımsızdır. */
export function createDemoBackend(): ChatToolBackend {
  const account: ChatToolAccount = { savedProductIds: [], alarms: [] };
  const find = (slug: string) => DEMO_CARDS.find((product) => product.slug === slug);
  return {
    account: async () => ({
      status: "ok",
      account: { savedProductIds: [...account.savedProductIds], alarms: [...account.alarms] },
    }),
    save: async (slug, saved) => {
      const product = find(slug);
      if (!product) return { status: "not_found" };
      account.savedProductIds = account.savedProductIds.filter((id) => id !== product.productId);
      if (saved) account.savedProductIds.push(product.productId);
      return { status: "ok", saved };
    },
    alarm: async (slug, targetPrice) => {
      const product = find(slug);
      if (!product) return { status: "not_found" };
      if (targetPrice !== null && (!Number.isSafeInteger(targetPrice) || targetPrice <= 0))
        return { status: "invalid" };
      const alarm =
        targetPrice === null
          ? null
          : { productId: product.productId, alertId: product.productId, targetPrice };
      account.alarms = account.alarms.filter((item) => item.productId !== product.productId);
      if (alarm) account.alarms.push(alarm);
      return { status: "ok", alarm };
    },
    details: async (slugs) => ({
      status: "ok",
      products: DEMO_CARDS.filter((product) => slugs.includes(product.slug)),
    }),
    similar: async (slug) =>
      find(slug)
        ? { status: "ok", products: DEMO_CARDS.filter((product) => product.slug !== slug) }
        : { status: "not_found" },
  };
}
