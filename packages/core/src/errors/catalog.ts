/**
 * Kullaniciya gorunen hata katalogu (karar 0104). Saf veri: sunucu ve istemci
 * ayni dosyayi okur, hicbir bagimliligi yoktur. Metinler Turkce, ALL CAPS yok;
 * "satin al", "dupe", "ucuz" gecmez. Hicbir metin teknik ayrinti (SQL, adres,
 * anahtar, yigin) icermez - ayrinti yalnizca sunucu logundadir.
 */

export const ERROR_CODES = [
  "db_capacity",
  "db_unavailable",
  "cache_unavailable",
  "deployment_mismatch",
  "ai_rate_limited",
  "ai_timeout",
  "ai_unavailable",
  "ai_bad_response",
  "web_search_unavailable",
  "request_timeout",
  "rate_limited",
  "network",
  "session_expired",
  "invalid_image",
  "invalid_link",
  "no_results",
  "unknown",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Kullanicinin yapabilecegi islem; arayuz bunu dugmeye cevirir. */
export type ErrorAction = "retry" | "reload" | "login" | "none";

/** Hatanin kapsami: arayuzde satir ici / bolum / sayfa secimini yonlendirir. */
export type ErrorScope = "inline" | "section" | "page";

export interface ErrorDefinition {
  title: string;
  message: string;
  /** Birincil islem. */
  action: ErrorAction;
  /** Ayni istegi yeniden denemek anlamli mi. */
  retryable: boolean;
  scope: ErrorScope;
}

export const ERROR_CATALOG: Record<ErrorCode, ErrorDefinition> = {
  db_capacity: {
    title: "Sistem şu an çok yoğun",
    message:
      "Veritabanı bağlantı kapasitesi geçici olarak doldu. Girdiğin bilgiler korunuyor; birkaç saniye sonra tekrar dene.",
    action: "retry",
    retryable: true,
    scope: "section",
  },
  db_unavailable: {
    title: "Veriye şu an ulaşamıyoruz",
    message: "Veritabanına bağlanılamadı. Girdiğin bilgiler korunuyor; biraz sonra tekrar dene.",
    action: "retry",
    retryable: true,
    scope: "section",
  },
  cache_unavailable: {
    title: "Hizmet geçici olarak yavaş",
    message: "Bu işlem için gereken yardımcı servise ulaşılamadı. Biraz sonra tekrar dene.",
    action: "retry",
    retryable: true,
    scope: "inline",
  },
  deployment_mismatch: {
    title: "Sayfa güncellenmiş",
    message:
      "Arilla yeni bir sürüme geçti ve açık sayfan eski kaldı. Sayfayı yenilediğinde devam edebilirsin.",
    action: "reload",
    retryable: false,
    scope: "section",
  },
  ai_rate_limited: {
    title: "Yapay zekâ servisi yoğun",
    message:
      "Yapay zekâ servisi şu an istek sınırına ulaştı. Biraz sonra tekrar dene ya da aramayı doğrudan yap.",
    action: "retry",
    retryable: true,
    scope: "inline",
  },
  ai_timeout: {
    title: "Yanıt zamanında gelmedi",
    message: "Yapay zekâ servisi zamanında yanıt vermedi. Tekrar deneyebilirsin.",
    action: "retry",
    retryable: true,
    scope: "inline",
  },
  ai_unavailable: {
    title: "Yapay zekâ şu an kullanılamıyor",
    message:
      "Yapay zekâ servisine şu an ulaşılamıyor. Aramayı doğrudan yapabilir ya da sonra tekrar deneyebilirsin.",
    action: "retry",
    retryable: true,
    scope: "inline",
  },
  ai_bad_response: {
    title: "Yanıtı işleyemedim",
    message:
      "Yapay zekâ servisinden gelen yanıt kullanılabilir biçimde değildi. Tekrar dener misin?",
    action: "retry",
    retryable: true,
    scope: "inline",
  },
  web_search_unavailable: {
    title: "İnternet araması tamamlanamadı",
    message: "İnternet araması şu an yapılamadı. Katalogdaki sonuçlar olduğu gibi duruyor.",
    action: "retry",
    retryable: true,
    scope: "section",
  },
  request_timeout: {
    title: "İşlem çok uzun sürdü",
    message: "İstek zamanında tamamlanamadı. Tekrar deneyebilirsin.",
    action: "retry",
    retryable: true,
    scope: "inline",
  },
  rate_limited: {
    title: "Çok sık denendi",
    message: "Kısa sürede çok fazla istek gönderildi. Birkaç dakika bekleyip tekrar dene.",
    action: "none",
    retryable: false,
    scope: "inline",
  },
  network: {
    title: "Bağlantı kurulamadı",
    message: "İnternet bağlantını kontrol edip tekrar dene. Girdiğin bilgiler korunuyor.",
    action: "retry",
    retryable: true,
    scope: "inline",
  },
  session_expired: {
    title: "Oturumun sona erdi",
    message:
      "Devam etmek için yeniden giriş yapman gerekiyor. Girdiğin bilgiler bu sayfada duruyor.",
    action: "login",
    retryable: false,
    scope: "inline",
  },
  invalid_image: {
    title: "Fotoğraf kullanılamadı",
    message: "Bu fotoğraf okunamadı. JPEG, PNG ya da WebP biçiminde başka bir fotoğraf dene.",
    action: "none",
    retryable: false,
    scope: "inline",
  },
  invalid_link: {
    title: "Bağlantı kullanılamadı",
    message: "Bu bağlantıdan ürün bilgisi okunamadı. Bağlantıyı kontrol et ya da ürünü adıyla ara.",
    action: "none",
    retryable: false,
    scope: "inline",
  },
  no_results: {
    title: "Ürün bulunamadı",
    message: "Bu arama için uygun ürün bulamadık. Aramayı daha genel yazmayı deneyebilirsin.",
    action: "none",
    retryable: false,
    scope: "section",
  },
  unknown: {
    title: "Bir sorun oluştu",
    message:
      "İşlem tamamlanamadı ve nedenini belirleyemedik. Tekrar deneyebilirsin; sürerse aşağıdaki referans kodunu bize ilet.",
    action: "retry",
    retryable: true,
    scope: "section",
  },
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** Arayuze giden, serilestirilebilir ve gizli bilgi icermeyen hata. */
export interface PublicError {
  code: ErrorCode;
  /** Destek icin referans kimligi; sunucu logundaki kayitla eslesir. */
  reference?: string;
}

export interface UserError extends ErrorDefinition, PublicError {}

/** Kod + referans -> gosterilecek hata. Bilinmeyen kod `unknown` olur. */
export function describeError(input: { code: unknown; reference?: string | null }): UserError {
  const code = isErrorCode(input.code) ? input.code : "unknown";
  return {
    code,
    ...ERROR_CATALOG[code],
    ...(input.reference ? { reference: input.reference } : {}),
  };
}
