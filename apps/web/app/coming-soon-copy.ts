/**
 * Prelaunch story copy. No live product results, invented counts or launch date.
 * Shared metadata and sign-in copy also serve other public routes.
 */
import { SITE_BRAND } from "./site-config.ts";

export const COMING_SOON_COPY = {
  headline: "Tarif et, fotoğrafını göster veya linkini bırak.",
  body: "ManiCepte ürünleri bulsun, benzerlerini çıkarsın ve mağaza fiyatlarını karşılaştırsın.",
  heroDetailsLabel: "ManiCepte ne yapar?",
  greeting: "Selam, hoş geldin!",
  greetingBody: "Hazır olduğumuzda ilk haberdar edeceğimiz kişilerden biri ol.",
  stageNote: "Şu an erken erişimdeyiz, ManiCepte’yi geliştirmeye devam ediyoruz.",
  progressGoal: (target: string) => `İlk ${target} kişiden biri ol.`,
  progressNote:
    "Erken erişim listemiz gerçek kayıtlarla güncelleniyor. Geliştirmeler hazır olduğunda sana haber vereceğiz.",
  availability: "Henüz kullanıma açık değil. Birlikte başlamak için hazırlanıyoruz.",
  ctaNote: "Hesabınla devam et ya da yeni hesap aç; listeye otomatik eklenirsin.",
  privacyNote: "Bilgilerin yalnızca erişim listesi için kullanılır.",
  howItWorksAnchor: "Nasıl çalıştığını gör",

  demoEyebrow: "Örnek deneyim",
  demoTitle: "ManiCepte nasıl çalışır?",
  demoBody:
    "Aklındakini tarif et, fotoğrafını göster veya linkini bırak. ManiCepte seçenekleri bulup karşılaştırsın.",
  demoScrollLabel: "Aşağı Kaydır",
  demoNotice: "Temsili önizleme",
  demoModes: {
    describe: "Tarif et",
    photo: "Fotoğraf göster",
    link: "Link bırak",
  },
  demoUserLabel: "Sen",
  demoAssistantLabel: "ManiCepte",
  demoUserMessage: "Gün boyu yürüyebileceğim, sade ve açık renkli bir spor ayakkabı arıyorum.",
  demoAssistantMessage:
    "Seni anladım. Rahat seçenekleri bulup fiyat ve özelliklerini karşılaştırıyorum.",
  demoComposerPlaceholder: "Ne aradığını anlat, fotoğrafını göster veya linkini bırak...",
  demoPhaseLabels: [
    "Seni dinliyorum.",
    "İhtiyacını alıyorum.",
    "Neye önem verdiğini anlıyorum.",
    "Seçenekleri araştırıyorum.",
    "En iyi dengeyi buldum.",
  ],
  demoScrollSteps: [
    "İhtiyacını anlat",
    "ManiCepte anlasın",
    "Seçenekleri araştırsın",
    "En iyi dengeyi gör",
  ],
  demoProductInsights: [
    { title: "Günlük rahatlık", note: "Ekonomik seçenek" },
    { title: "Yürüyüş desteği", note: "Dengeli seçenek" },
    { title: "Hafif kullanım", note: "Dayanıklı seçenek" },
  ],
  demoWinner: "En iyi fiyat-kalite dengesi",

  enrolledTitle: "Listedesin. İyi ki geldin.",

  buildEyebrow: "Geliştirme durumu",
  buildTitle: "Neler hazırlıyoruz?",
  buildBody: "Erken erişim öncesindeki çalışma başlıklarımız.",
  buildStatusDone: "Tamamlandı",
  buildStatusInProgress: "Geliştiriliyor",
  buildUpdated: (month: string) => `Son güncelleme: ${month}`,
  followTitle: "Gelişmeleri takip et",
  socialEyebrow: "ManiCepte günlüğü",
  socialTitle: "Gelişmeleri birlikte takip edelim.",
  socialBody:
    "Yeni özellikleri, erken erişim davetlerini ve geliştirme notlarını resmi hesaplarımızda paylaşacağız.",

  faqEyebrow: "Merak ettiklerin",
  faqTitle: "Kısa cevaplar.",
  questions: [
    {
      question: "ManiCepte'yi hemen kullanabilir miyim?",
      answer:
        "Henüz değil. Ürün bulma ve karşılaştırma deneyimini geliştiriyoruz. Listeye katılırsan hazır olduğunda haber alırsın.",
    },
    {
      question: "Erken erişime nasıl katılırım?",
      answer:
        "Erken erişime katıl butonundan hesabınla devam et veya yeni hesap aç. Listeye otomatik eklenirsin.",
    },
    {
      question: "Ne zaman açılacak?",
      answer:
        "İlk topluluk hedefimiz 5.000 kişi. Açılış için kesin bir tarih yok; ürün hazır olduğunda listedeki herkese haber vereceğiz.",
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
  { id: "erken-erisim", title: "Erken erişim kayıtları", status: "done" },
  {
    id: "arama",
    title: "Ürün bulma ve karşılaştırma",
    status: "in_progress",
  },
  {
    id: "kaynaklar",
    title: "Mağaza ve ürün kaynakları",
    status: "in_progress",
  },
];

export const BUILD_UPDATED: string | null = null;
