/**
 * Prelaunch story copy. No live product results, invented counts or launch date.
 * Shared metadata and sign-in copy also serve other public routes.
 */
import { SITE_BRAND } from "./site-config.ts";

export const COMING_SOON_COPY = {
  eyebrow: "Erken Erişim",
  status: `${SITE_BRAND} yakında.`,
  headline: "Tarif et, fotoğrafını göster veya linkini bırak.",
  body: "ManiCepte ürünleri bulsun, benzerlerini çıkarsın ve mağaza fiyatlarını karşılaştırsın.",
  greeting: "Selam, hoş geldin!",
  greetingBody: "Hazır olduğumuzda ilk haberdar edeceğimiz kişilerden biri ol.",
  greetingInvitation: "Hazır olduğumuzda ilk haberdar edeceğimiz kişilerden biri ol.",
  stageNote: "Şu an erken erişimdeyiz, ManiCepte’yi geliştirmeye devam ediyoruz.",
  progressGoal: (target: string) => `İlk ${target} kişiden biri ol.`,
  progressNote:
    "Erken erişim listemiz gerçek kayıtlarla güncelleniyor. Geliştirmeler hazır olduğunda sana haber vereceğiz.",
  availability: "Henüz kullanıma açık değil. Birlikte başlamak için hazırlanıyoruz.",
  motionLabel: "Hareket",
  ctaNote: "Hesabınla devam et ya da yeni hesap aç; listeye otomatik eklenirsin.",
  privacyNote: "Bilgilerin yalnızca erişim listesi için kullanılır.",
  howItWorksAnchor: "Nasıl çalıştığını gör",

  demoEyebrow: "Örnek deneyim",
  demoTitle: "ManiCepte nasıl çalışır?",
  demoBody:
    "Aklındaki ürünü tarif et, fotoğrafını göster veya bağlantısını bırak. ManiCepte ihtiyacını anlayıp benzer ürünleri ve mağaza seçeneklerini bir araya getirir.",
  demoInstruction:
    "Aşağıdaki örnek deneyimde ManiCepte’nin nasıl çalıştığını adım adım görebilirsin.",
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

  buildEyebrow: "Mutfakta neler var?",
  buildTitle: `${SITE_BRAND}'yi geliştiriyoruz.`,
  buildBody: "Şu an üzerinde çalıştığımız temel parçalar:",
  buildStatusDone: "Tamamlandı",
  buildStatusInProgress: "Geliştiriliyor",
  buildUpdated: (month: string) => `Son güncelleme: ${month}`,
  followTitle: "Gelişmeleri takip et",
  socialEyebrow: "ManiCepte günlüğü",
  socialTitle: "Gelişmeleri birlikte takip edelim.",
  socialBody:
    "Yeni özellikleri, erken erişim davetlerini ve geliştirme notlarını resmi hesaplarımızda paylaşacağız.",

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
  { id: "erken-erisim", title: "Erken erişim kayıtları açık.", status: "done" },
  {
    id: "arama",
    title: "Ürün bulma ve karşılaştırma deneyimini geliştiriyoruz.",
    status: "in_progress",
  },
  {
    id: "kaynaklar",
    title: "Mağaza ve ürün kaynaklarını genişletiyoruz.",
    status: "in_progress",
  },
];

export const BUILD_UPDATED: string | null = null;
