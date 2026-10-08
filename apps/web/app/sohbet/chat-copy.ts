/**
 * `/sohbet` arayuz metinleri (docs/copy.md dili: sen, sade, ALL CAPS yok;
 * "satin al", "dupe", "ucuz" gecmez). Kodda sabit; testler yasakli kelimeleri
 * ve ALL CAPS'i tarar.
 */
export const CHAT_COPY = {
  pageTitle: "Sohbet",
  threadLabel: "Sohbet geçmişi",
  userLabel: "Sen",
  attachedPhotoAlt: "Gönderdiğin fotoğraf",
  assistantLabel: "Asistan",
  composerLabel: "Mesajın",
  composerPlaceholder: "Ne aradığını yaz ya da bir ayrıntı ekle",
  sendLabel: "Gönder",
  sending: "Gönderiliyor",
  thinking: "Yanıt hazırlanıyor",
  skipLabel: "Atla",
  otherLabel: "Başka bir şey…",
  otherInputLabel: "Kendi cevabını yaz",
  otherPlaceholder: "Kısaca yaz",
  otherSubmit: "Gönder",
  retryLabel: "Tekrar dene",
  startFailed: "Sohbet başlatılamadı.",
  backHomeLabel: "Ana sayfaya dön",
  searchDirectlyLabel: "Doğrudan ara",
  newChatLabel: "Yeni sohbet başlat",
  usedInSearch: "Aramada kullanılanlar",
  seeAll: "Tümünü gör",
  closeMatchesHeading: "Birebir eşleşme yok, en yakınlar",
  noResultsTitle: "Bu aramayla eşleşen ürün bulamadım.",
  noResultsInTab: "Bu sıralamada gösterecek ürün yok.",
  noResultsInTabHint: "Seçtiklerimiz sekmesinde bu aramanın sonuçları var.",
  noResultsDescription:
    "Aşağıya renk, marka ya da bütçeni yazarsan birlikte daraltalım; bir ayrıntıyı gevşetmeyi ya da farklı kelimelerle yazmayı da deneyebilirsin.",
  resultsUnavailable: "Sonuçlar şu anda yüklenemedi. Biraz sonra tekrar dener misin?",
  skippedAnswer: "Atladım",
  feedbackQuestion: "Bu yardımcı oldu mu?",
  feedbackYes: "Evet, yardımcı oldu",
  feedbackNo: "Hayır, yardımcı olmadı",
  feedbackThanks: "Teşekkürler, not aldım.",
  feedbackFailed: "Kaydedemedim, tekrar dener misin?",
  tabsLabel: "Sonuç sıralaması",
  tabSelected: "Seçtiklerimiz",
  tabDeals: "En iyi fırsatlar",
  tabMatches: "En iyi eşleşmeler",
  tabMatchesUnavailable: "Bu arama için kullanılamıyor",
  resultsLoading: "Sonuçlar yükleniyor",
  resultsRegion: "Sonuçlar",
  seeAllCount: (count: number) => `Tüm ${count.toLocaleString("tr-TR")} sonucu görüntüle`,
  searchTimedOut: "Arama beklenenden uzun sürdü. Aramanı sakladım, tekrar deneyebilirsin.",
  relaxedLabel: "Aramada yaptığım değişiklikler",
  brandExcludeUnresolved: (brand: string) =>
    `“${brand}” markasını hariç tutamadım, katalogda bu adla bulamadım.`,
} as const;

/** Arama kısıt gevşettiyse sessiz kalmayız (karar 0074); iç kodlar kullanıcı diline çevrilir. */
export function relaxationLabel(relaxation: string): string | null {
  if (relaxation === "color") return "Renk filtresini gevşettim.";
  if (relaxation === "size") return "Beden filtresini gevşettim.";
  if (relaxation === "category") return "Kategoriyi genişlettim.";
  if (relaxation === "typo") return "Yazımı düzelterek aradım.";
  if (relaxation === "alias") return "Benzer adlarla da aradım.";
  if (relaxation.startsWith("token:")) {
    return `“${relaxation.slice("token:".length)}” kelimesini aramadan çıkardım.`;
  }
  return null;
}

export type ChatErrorKind =
  | "provider"
  | "network"
  | "busy"
  | "rate_limited"
  | "conversation_full"
  | "invalid_option"
  | "invalid_input"
  | "unavailable"
  | "not_found";

export interface ChatErrorCopy {
  message: string;
  /** `Tekrar dene` düğmesi anlamlı mı. */
  retry: boolean;
  /** `Doğrudan ara` bağlantısı (yapay zekasız arama) gösterilsin mi. */
  searchDirectly: boolean;
  /** `Yeni sohbet` bağlantısı gösterilsin mi. */
  newChat: boolean;
}

export const CHAT_ERROR_COPY: Record<ChatErrorKind, ChatErrorCopy> = {
  provider: {
    message: "Şu anda yanıt veremedim. Tekrar deneyebilir ya da aramayı doğrudan yapabilirsin.",
    retry: true,
    searchDirectly: true,
    newChat: false,
  },
  network: {
    message: "Bağlantı kurulamadı. İnternetini kontrol edip tekrar dener misin?",
    retry: true,
    searchDirectly: false,
    newChat: false,
  },
  busy: {
    message: "Önceki mesajın hâlâ işleniyor. Birkaç saniye sonra tekrar dene.",
    retry: true,
    searchDirectly: false,
    newChat: false,
  },
  // Saat/gun/hafta/ay sohbet mesaji sinirlarindan biri doldu (quota/policy.ts).
  rate_limited: {
    message:
      "Şimdilik sohbet mesajı sınırına ulaştın. Aramayı doğrudan yapabilirsin; sınırın yenilenince sohbete devam edebilirsin.",
    retry: false,
    searchDirectly: true,
    newChat: false,
  },
  conversation_full: {
    message: "Bu sohbet doldu. Yeni bir sohbet başlatıp devam edebilirsin.",
    retry: false,
    searchDirectly: false,
    newChat: true,
  },
  invalid_option: {
    message: "Bu seçenek artık geçerli değil. Sayfayı yenileyip tekrar dene.",
    retry: true,
    searchDirectly: false,
    newChat: false,
  },
  invalid_input: {
    message: "Mesajını gönderemedim. Başka bir şekilde yazıp tekrar dener misin?",
    retry: false,
    searchDirectly: false,
    newChat: false,
  },
  unavailable: {
    message: "Sohbet şu anda kullanılamıyor. Aramayı doğrudan yapabilirsin.",
    retry: false,
    searchDirectly: true,
    newChat: false,
  },
  not_found: {
    message: "Bu sohbete ulaşamadım. Yeni bir sohbet başlatabilirsin.",
    retry: false,
    searchDirectly: false,
    newChat: true,
  },
};

/** Sunucu eyleminin sabit durum kodunu arayüz hatasına çevirir; başarı için null. */
export function errorKindForStatus(status: string): ChatErrorKind | null {
  switch (status) {
    case "queued":
    case "duplicate":
    case "answered":
    case "idle":
      return null;
    case "provider_error":
      return "provider";
    case "busy":
    case "rate_limited":
    case "conversation_full":
    case "invalid_option":
    case "invalid_input":
    case "unavailable":
    case "not_found":
      return status;
    default:
      return "provider";
  }
}
