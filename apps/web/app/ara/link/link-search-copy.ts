/**
 * `/ara/link` metinleri — docs/copy.md "Link araması" bölümü. Kod içinde
 * dağınık kalmasın diye tek yerde. Arayüz dili Türkçe, büyük harf yok,
 * "satın al" / "ucuz" yok (CLAUDE.md).
 */

export const LINK_SEARCH_COPY = {
  pendingTitle: "Ürün inceleniyor…",
  pendingDescription:
    "Sayfadaki ürün bilgilerini okuyup kataloğumuzda benzerlerini arıyoruz. Bu birkaç saniye sürebilir.",
  resultsTitle: "Bu ürüne benzer sonuçlar",
  sameTitle: "Bu ürün Arilla'da da var",
  sameEvidence: {
    gtin: "Barkod eşleşmesiyle bulundu",
    mpn: "Marka ve üretici kodu eşleşmesiyle bulundu",
  },
  similarTitle: "Benzer ürünler",
  sourceLabel: "İncelediğin ürün",
  sourceNote: "Bu ürün başka bir sitede. Aşağıdakiler Arilla kataloğundan.",
  sourceOpen: "Mağazada aç",
  signalsImage: "Görsel ve ürün bilgisine göre sıralandı.",
  signalsText: "Ürün görseli okunamadı; ürün adına ve markasına göre sıralandı.",
  emptyTitle: "Bu ürüne benzeyen bir şey bulamadık.",
  emptyDescription: "Ürünün adını ya da türünü yazarak aramayı deneyebilirsin.",
  invalidTitle: "Bu bir ürün bağlantısına benzemiyor.",
  invalidDescription: "Bağlantı https:// ile başlamalı ve bir mağazanın ürün sayfasını göstermeli.",
  blockedTitle: "Bu bağlantıyı açamıyoruz.",
  timeoutTitle: "İnceleme beklenenden uzun sürüyor.",
  timeoutDescription: "Birazdan tekrar deneyebilir ya da ürünün adını yazarak arayabilirsin.",
  retry: "Tekrar dene",
  newSearchTitle: "Yeni bir arama yap",
  searchPlaceholder: "Ürün adı, marka ya da ürün bağlantısı",
  searchSubmit: "Ara",
} as const;

interface FailureCopy {
  title: string;
  description: string;
}

const UNAVAILABLE: FailureCopy = {
  title: "Site şu an yanıt vermiyor.",
  description: "Biraz sonra tekrar deneyebilir ya da ürünün adını yazarak arayabilirsin.",
};

/** `link_resolution_request.error_code` -> kullanıcı metni. Bilinmeyen kod genel metne düşer. */
const FAILURES: Record<string, FailureCopy> = {
  robots_disallowed: {
    title: "Bu site ürün sayfasının okunmasına izin vermiyor.",
    description: "Ürünün adını yazarak kataloğumuzda arayabilirsin.",
  },
  access_denied: {
    title: "Bu sayfaya erişemedik.",
    description:
      "Sayfa giriş istiyor ya da ziyaretçileri engelliyor olabilir. Ürünün adını yazarak arayabilirsin.",
  },
  not_found: {
    title: "Bu bağlantıda bir ürün sayfası bulamadık.",
    description: "Ürün kaldırılmış ya da adres değişmiş olabilir.",
  },
  no_product: {
    title: "Bu sayfada ürün bilgisi bulamadık.",
    description:
      "Bağlantının bir ürün sayfasına gittiğinden emin ol ya da ürünün adını yazarak ara.",
  },
  unsupported_content: {
    title: "Bu bağlantı bir ürün sayfasına gitmiyor.",
    description: "Ürün sayfasının bağlantısını yapıştırmayı dene.",
  },
  too_large: {
    title: "Bu sayfayı inceleyemedik.",
    description: "Sayfa beklenenden çok büyük. Ürünün adını yazarak arayabilirsin.",
  },
  blocked_destination: {
    title: "Bu bağlantıyı açamıyoruz.",
    description: "Yalnızca herkese açık mağaza sayfalarını inceleyebiliyoruz.",
  },
  invalid_url: {
    title: "Bu bir ürün bağlantısına benzemiyor.",
    description: "Bağlantı https:// ile başlamalı ve bir mağazanın ürün sayfasını göstermeli.",
  },
  too_many_redirects: {
    title: "Bu bağlantı bizi çok fazla yönlendirdi.",
    description: "Ürün sayfasının doğrudan bağlantısını yapıştırmayı dene.",
  },
  no_rights: {
    title: "Bugünkü arama hakların bitti.",
    description:
      "Günlük hakların gece 00:00'da yenilenir. Bu arada ürünün adını yazarak arayabilir ya da hesabından bonus hak kazanabilirsin.",
  },
  // Kullanicinin arama hizi siniri (0047); sitenin 429'u `rate_limited`.
  search_rate_limited: {
    title: "Biraz hızlı gittin.",
    description:
      "Bir dakika sonra tekrar dener misin? Ürünün adını yazarak aramaya devam edebilirsin.",
  },
  busy: {
    title: "Önceki araman hâlâ sürüyor.",
    description: "Bitince bu bağlantıyı yeniden deneyebilirsin.",
  },
  retry: {
    title: "Bu bağlantıyı şu an inceleyemedik.",
    description: "Tekrar dener misin? Hakkın geri verildi.",
  },
  login_required: {
    title: "Bağlantıyla arama için giriş yap.",
    description: "Fotoğraf ve bağlantı araması hesabınla çalışır; her gün 10 arama hakkın olur.",
  },
  queue_unavailable: {
    title: "Şu an bağlantıları inceleyemiyoruz.",
    description: "Biraz sonra tekrar dene ya da ürünün adını yazarak ara.",
  },
  rate_limited: UNAVAILABLE,
  upstream_error: UNAVAILABLE,
  timeout: UNAVAILABLE,
  fetch_failed: UNAVAILABLE,
  http_error: UNAVAILABLE,
};

export function linkFailureCopy(code: string): FailureCopy {
  return (
    FAILURES[code] ?? {
      title: "Bu bağlantıyı şu an inceleyemedik.",
      description: "Biraz sonra tekrar deneyebilir ya da ürünün adını yazarak arayabilirsin.",
    }
  );
}
