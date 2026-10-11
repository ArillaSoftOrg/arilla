/**
 * Prelaunch story copy. No live product results, invented counts or launch date.
 * Shared metadata and sign-in copy also serve other public routes.
 */
import { SITE_BRAND } from "./site-config.ts";

export const COMING_SOON_COPY = {
  eyebrow: "Erken Erişim",
  status: `${SITE_BRAND} yakında.`,
  headline: "Alışverişe bir de birlikte bakalım.",
  body: "Ürün keşfi ve fiyat karşılaştırması için alışveriş arkadaşın hazırlanıyor.",
  greeting: "Selam, hoş geldin!",
  greetingBody: "Ben senin alışveriş arkadaşın olacağım.",
  greetingInvitation: "Ben hazırlanırken sen de ilk tanışanlardan ol.",
  progressGoal: (target: string) => `Hedefimiz ${target} kişiyle açılışa başlamak.`,
  progressNote: "Biz ManiCepte'yi hazırlarken sen de yerini al. Açılışta sana haber verelim.",
  availability: "Henüz kullanıma açık değil. Birlikte başlamak için hazırlanıyoruz.",
  motionLabel: "Hareket",
  ctaNote: "Hesabınla devam et ya da yeni hesap aç; listeye otomatik eklenirsin.",
  howItWorksAnchor: "Tanışalım",

  describeEyebrow: "Her şey seninle başlayacak",
  describeTitle: "Aklındakini anlat. Oradan başlayalım.",
  describeBody:
    "Tam adını bilmen gerekmeyecek. Neye ihtiyacın olduğunu, neleri sevdiğini ve senin için neyin önemli olduğunu kendi cümlelerinle anlatabileceksin.",
  exampleLabel: "Örnek bir arama",
  exampleQuery: "“Küçük mutfağıma uygun, kolay temizlenen bir kahve makinesi arıyorum.”",
  describeDialogue: "Küçük mutfak, büyük kahve planları. Anladım.",

  compareEyebrow: "Seçenekler netleşecek",
  compareTitle: "Bir sürü seçenek. Sana göre bir karar.",
  compareBody:
    "Aradığın ürünü, benzerlerini ve farklı mağazalardaki fiyatlarını birlikte inceleyebileceksin.",
  compareDialogue: "Seçenekleri ben toparlayacağım. Son söz sende.",
  comparisonPoints: [
    {
      title: "Fiyatları yan yana.",
      body: "Aynı ürünün farklı mağazalardaki tekliflerini tek yerde karşılaştırabileceksin.",
    },
    {
      title: "Alternatifler de masada.",
      body: "Beğendiğin ürüne benzeyen seçenekleri keşfedip sana uygun olanı seçebileceksin.",
    },
  ],

  enrolledTitle: "Listedesin. İyi ki geldin.",

  buildEyebrow: "Mutfakta neler var?",
  buildTitle: `${SITE_BRAND}'yi geliştiriyoruz.`,
  buildBody: "Ürünü adım adım inşa ediyoruz. Şu an üzerinde çalıştıklarımız:",
  buildStatusDone: "Tamamlandı",
  buildStatusInProgress: "Geliştiriliyor",
  buildUpdated: (month: string) => `Son güncelleme: ${month}`,
  followTitle: "Gelişmeleri takip et",

  faqEyebrow: "Aklına takılanlar",
  faqTitle: "Tanışmışken.",
  questions: [
    {
      question: "ManiCepte'yi hemen kullanabilir miyim?",
      answer:
        "Henüz değil. Arama ve karşılaştırma deneyimini geliştiriyoruz. Erken erişim listesine katıldığında, hazır olduğumuzda sana haber vereceğiz.",
    },
    {
      question: "Erken erişime nasıl katılırım?",
      answer:
        "Erken erişime katıl bağlantısından hesabınla devam edebilir ya da yeni bir hesap açabilirsin. Listeye otomatik eklenirsin.",
    },
    {
      question: "Ne zaman açılacak?",
      answer:
        "Hedefimiz 5.000 kişiyle açılışa başlamak. Bir yandan da ManiCepte'yi geliştiriyoruz; henüz kesin bir tarih yok. Açılışta listedeki herkese haber vereceğiz.",
    },
  ],

  adminLogin: "Admin Girişi",
  adminLoginTitle: "Hesabınla giriş yap.",
  footerDescription: `${SITE_BRAND} yakında: aradığın ürünü bul, alternatiflerini keşfet, fiyatları karşılaştır.`,
  metaTitle: `${SITE_BRAND} – Yakında`,
  metaDescription: `${SITE_BRAND} yakında: aradığın ürünü bul, alternatiflerini keşfet ve farklı mağazalardaki fiyatları karşılaştır. Erken erişim listesine katıl.`,
} as const;

export type BuildStatus = "done" | "in_progress";

/** Real development status, maintained manually; no invented launch promises. */
export const BUILD_ITEMS: readonly { id: string; title: string; status: BuildStatus }[] = [
  { id: "erken-erisim", title: "Erken erişim sistemi", status: "done" },
  { id: "arama", title: "Arama deneyimi", status: "in_progress" },
  { id: "kesif", title: "Ürün keşfi ve karşılaştırma", status: "in_progress" },
  { id: "altyapi", title: "Mağaza ve fiyat altyapısı", status: "in_progress" },
];

export const BUILD_UPDATED: string | null = "Eylül 2026";
