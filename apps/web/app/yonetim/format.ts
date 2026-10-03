/** /yonetim ekranlarının ortak gösterim yardımcıları. Saat dilimi: Türkiye. */

// İstemci bileşenleri de bu dosyayı içe aktarır: core'dan yalnızca TİP ve saf
// alt yol (`@arilla/core/cost-truth`) alınır, sunucu kodu pakete girmez.
import type { AttentionState, PipelineStage, PipelineStageState, Severity } from "@arilla/core";
import { type CostSummary, costState } from "@arilla/core/cost-truth";

const DATE_TIME = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Istanbul",
});

export function formatDateTime(value: Date): string {
  return DATE_TIME.format(value);
}

export function formatCount(n: number): string {
  return n.toLocaleString("tr-TR");
}

/** `api_usage.cost_micros`: TRY'nin milyonda biri (tamsayı). */
export function formatCostMicros(micros: number): string {
  const lira = micros / 1_000_000;
  return `${lira.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`;
}

/**
 * Maliyetin dürüst gösterimi (karar 0051, core `costState`). Maliyet oranı
 * tanımsızken yazılan çağrılar 0 maliyetlidir; "0,00 TL" gerçek harcama gibi
 * görünmesin diye bu durumda tutar yerine "Hesaplanmadı" / "en az" yazılır.
 */
export function formatCost(summary: CostSummary): { value: string; note: string | null } {
  const state = costState(summary);
  const unpriced = `${formatCount(summary.unpricedCalls)} çağrı fiyatlanmadı (maliyet oranı tanımsız)`;
  if (state === "unpriced") return { value: "Hesaplanmadı", note: unpriced };
  if (state === "partial") {
    return { value: `en az ${formatCostMicros(summary.costMicros)}`, note: unpriced };
  }
  return { value: formatCostMicros(summary.costMicros), note: null };
}

/** Çağrı / önbellek / birim özeti; tutardan bağımsız, her zaman gerçek. */
export function formatUsage(summary: CostSummary): string {
  return `${formatCount(summary.calls)} çağrı · ${formatCount(summary.cacheHits)} önbellekten · ${formatCount(summary.units)} birim`;
}

const ATTENTION_LABELS: Record<AttentionState, string> = {
  stuck: "Takılı koşu (2 saattir sürüyor)",
  failed: "Son koşu başarısız",
  currency_unverified: "Para birimi doğrulanmadı (toplama reddedilir)",
  never_ran: "Hiç toplanmadı",
  stale: "Veri yenilenmedi (24 saatten eski)",
};

export function attentionLabel(state: AttentionState): string {
  return ATTENTION_LABELS[state];
}

/** Boru hattı aşaması: ad, kanıtın ne olduğu ve elle çalıştırma komutu (ops.md). */
export const PIPELINE_STAGE_INFO: Record<
  PipelineStage,
  { label: string; evidence: string; command: string | null }
> = {
  collect: {
    label: "Veri toplama",
    evidence: "son başarılı ya da kısmi toplama koşusu",
    command: "python -m collect.bootstrap",
  },
  resolve: {
    label: "Eşleştirme",
    evidence: "en yeni eşleştirme adayı (yalnızca yeni çiftler iz bırakır)",
    command: "python -m resolve",
  },
  prices: {
    label: "Fiyat özeti",
    evidence:
      "en yeni fiyat istatistiği; ürünün teklif sayısı ve en düşük fiyatı bununla yenilenir",
    command: "python -m similarity --prices",
  },
  enrich: {
    label: "Zenginleştirme (vektör)",
    evidence: "en yeni ürün/teklif embedding'i",
    command: "python -m enrich",
  },
  edges: {
    label: "Benzerlik kenarları",
    evidence: "en yeni benzerlik kenarı",
    command: "python -m similarity --edges",
  },
  link: {
    label: "Link çözümleme",
    evidence: "en son tamamlanan link isteği",
    command: null,
  },
};

const PIPELINE_STATE_LABELS: Record<PipelineStageState, string> = {
  ok: "güncel",
  behind: "geride olabilir",
  warning: "müdahale gerekli",
  none: "kanıt yok",
  unknown: "okunamadı",
};

export function pipelineStateLabel(state: PipelineStageState): string {
  return PIPELINE_STATE_LABELS[state];
}

const PIPELINE_REASON_LABELS: Record<string, string> = {
  stuck_runs: '2 saattir "sürüyor" kalan toplama koşusu var',
  stale_feed: "son başarılı toplama 24 saatten eski",
  link_stuck: "10 dakikadır işlenen link isteği var",
  link_queue_old: "10 dakikadan uzun bekleyen link isteği var",
};

export function pipelineReasonLabel(reason: string): string {
  return PIPELINE_REASON_LABELS[reason] ?? reason;
}

const STATUS_LABELS: Record<string, string> = {
  // ingest_run
  running: "sürüyor",
  success: "başarılı",
  partial: "kısmi",
  failed: "başarısız",
  // link_resolution_request
  queued: "kuyrukta",
  processing: "işleniyor",
  resolved: "çözüldü",
  // image_upload
  pending: "bekliyor",
  embedded: "işlendi",
  rejected_not_product: "ürün değil",
  rejected_moderation: "moderasyon reddi",
  // match_candidate
  auto_accepted: "otomatik kabul",
  accepted: "onaylandı",
  rejected: "reddedildi",
  // marketing_campaign (karar 0048)
  draft: "taslak",
  sending: "gönderiliyor",
  completed: "tamamlandı",
  partially_failed: "kısmen başarısız",
  cancelled: "iptal edildi",
  // marketing_campaign_delivery: "sent" = sağlayıcı kabul etti, teslim değil
  sent: "sağlayıcıya verildi",
  skipped: "atlandı",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

const ACTION_LABELS: Record<string, string> = {
  "matching.approve": "Eşleştirme onaylandı",
  "matching.reject": "Eşleştirme reddedildi",
  "lexicon.create": "Sözlük satırı eklendi",
  "lexicon.update": "Sözlük satırı düzenlendi",
  "lexicon.delete": "Sözlük satırı silindi",
  "merchant.activate": "Mağaza açıldı",
  "merchant.deactivate": "Mağaza kapatıldı",
  "users.lookup": "Kullanıcı arandı",
  "users.search": "Kullanıcı arandı (kısmi)",
  "users.view": "Kullanıcı ayrıntısı görüntülendi",
  "users.list": "Kullanıcı listesi görüntülendi",
  "users.view_tab": "Kullanıcı hassas sekmesi görüntülendi",
  "users.reveal_contact": "Tam iletişim bilgisi gösterildi",
  "users.role_change": "Rol değiştirildi",
  "marketing.campaign_create": "E-posta kampanyası oluşturuldu",
  "marketing.campaign_update": "E-posta kampanyası düzenlendi",
  "marketing.test_send": "Test e-postası gönderildi",
  "marketing.send_start": "E-posta kampanyası gönderimi başlatıldı",
  "marketing.campaign_cancel": "E-posta kampanyası iptal edildi",
  "security.access_denied": "Yetkisiz yönetim erişimi reddedildi",
  "security.admin_session_ended": "Yönetim oturumu sonlandırıldı",
  "sessions.revoke_all": "Tüm oturumlar kapatıldı",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export const ADMIN_ACTIONS = Object.keys(ACTION_LABELS);

export const REVIEW_REASON_LABELS: Record<string, string> = {
  not_same_product: "Farklı ürün",
  different_color: "Farklı renk",
  different_size: "Farklı boyut/hacim",
  bad_data: "Bozuk veri",
  other: "Diğer",
  superseded: "Başka aday onaylandı",
};

export function reviewReasonLabel(reason: string | null): string {
  return reason ? (REVIEW_REASON_LABELS[reason] ?? reason) : "Belirtilmedi";
}

/** Kuruş → "1.299,90 TL". Para asla float saklanmaz; yalnızca gösterim. */
export function formatKurus(kurus: number | null): string {
  if (kurus === null) return "—";
  const lira = Math.trunc(kurus / 100);
  const rest = Math.abs(kurus % 100);
  return `${lira.toLocaleString("tr-TR")}${rest ? `,${String(rest).padStart(2, "0")}` : ""} TL`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000)
    return `${(ms / 1_000).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} sn`;
  return `${Math.round(ms / 60_000).toLocaleString("tr-TR")} dk`;
}

export function formatDateOrDash(value: Date | null): string {
  return value ? formatDateTime(value) : "—";
}

/** URL arama parametresinden pozitif tamsayı (imleç, sayfa, kimlik); değilse undefined. */
export function positiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,15}$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** `?a=1&b=` → yalnızca dolu parametrelerle adres. */
export function hrefWith(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Sözlük türleri (`LEXICON_KINDS`) arayüzde Türkçe; değer olarak İngilizce kalır. */
const LEXICON_KIND_LABELS: Record<string, string> = {
  color: "Renk",
  category: "Kategori",
  brand: "Marka",
  size: "Beden / ölçü",
  material: "Malzeme",
  style: "Stil",
  synonym: "Eş anlamlı",
};

export function lexiconKindLabel(kind: string): string {
  return LEXICON_KIND_LABELS[kind] ?? kind;
}

const ROLE_LABELS: Record<string, string> = {
  user: "Kullanıcı",
  creator: "Creator",
  moderator: "Moderatör",
  admin: "Yönetici",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/** `early_access.status` (0031): bugün tek durum. */
const EARLY_ACCESS_STATUS_LABELS: Record<string, string> = {
  pending: "Listede, açılış bekleniyor",
};

export function earlyAccessStatusLabel(status: string): string {
  return EARLY_ACCESS_STATUS_LABELS[status] ?? status;
}

/** `user_consent.kind` (CONSENT_KINDS). */
const CONSENT_KIND_LABELS: Record<string, string> = {
  browsing_history: "Gezinme geçmişi",
  marketing_email: "Pazarlama e-postası",
  personalization: "Kişiselleştirme",
  public_discovery: "Keşfet'te görünme",
  // 0037: çerez kategorileri ve aydınlatma metni kaydı (rıza değil)
  cookie_functional: "İşlevsel çerezler",
  cookie_analytics: "Analitik çerezler",
  cookie_marketing: "Pazarlama çerezleri",
  privacy_notice: "Aydınlatma metni gösterildi",
};

export function consentKindLabel(kind: string): string {
  return CONSENT_KIND_LABELS[kind] ?? kind;
}

/** Arama hakkı (0034/0047) - değerler veritabanındaki CHECK listeleriyle aynı. */
const SEARCH_OPERATION_LABELS: Record<string, string> = {
  visual_search: "Fotoğrafla arama",
  link_search: "Linkle arama",
};

const CHARGE_STATE_LABELS: Record<string, string> = {
  reserved: "Ayrıldı (sürüyor)",
  settled: "Kullanıldı",
  refunded: "İade edildi",
};

const LEDGER_REASON_LABELS: Record<string, string> = {
  search_charge: "Arama harcaması",
  search_refund: "Arama iadesi",
  referral_inviter: "Davet ödülü (davet eden)",
  referral_invitee: "Davet ödülü (davet edilen)",
  feedback_first: "İlk geri bildirim ödülü",
  admin_grant: "Yönetici tanımı",
  campaign: "Kampanya",
};

const REFUND_REASON_LABELS: Record<string, string> = {
  provider_error: "Sağlayıcı hatası",
  provider_unavailable: "Sağlayıcıya ulaşılamadı",
  internal_error: "İç hata",
  link_failed: "Link çözülemedi",
  link_stale: "Link isteği zaman aşımı",
  link_reused: "Önceki sonuç kullanıldı",
  queue_unavailable: "Kuyruğa ulaşılamadı",
};

const REFERRAL_STATUS_LABELS: Record<string, string> = {
  pending: "Beklemede (henüz kesinleşen arama yok)",
  qualified: "Geçerli",
};

export function searchOperationLabel(value: string): string {
  return SEARCH_OPERATION_LABELS[value] ?? value;
}

export function chargeStateLabel(value: string): string {
  return CHARGE_STATE_LABELS[value] ?? value;
}

export function ledgerReasonLabel(value: string): string {
  return LEDGER_REASON_LABELS[value] ?? value;
}

export function refundReasonLabel(value: string): string {
  return REFUND_REASON_LABELS[value] ?? value;
}

export function referralStatusLabel(value: string): string {
  return REFERRAL_STATUS_LABELS[value] ?? value;
}

/** İşaretli tam sayı: `+5`, `-1`. */
export function formatDelta(n: number): string {
  return n > 0 ? `+${formatCount(n)}` : `-${formatCount(Math.abs(n))}`;
}

/** Kampanya alıcı önizlemesi ve teslim sorunları (karar 0048). */
const MARKETING_REASON_LABELS: Record<string, string> = {
  no_email: "E-posta adresi yok",
  invalid_email: "Geçersiz e-posta adresi",
  unverified_email: "E-posta doğrulanmamış",
  no_consent: "Pazarlama izni hiç verilmemiş",
  consent_revoked: "Pazarlama izni geri alınmış",
  duplicate_email: "Aynı adres başka hesapta",
  // teslim
  not_eligible: "Gönderim anında uygun değildi",
  account_deleted: "Hesap silinmiş",
  cancelled: "Kampanya iptal edildi",
  invalid_recipient: "Alıcı adresi reddedildi",
  provider_rejected: "Sağlayıcı reddetti",
  temporary_error: "Geçici hata (denemeler tükendi)",
  configuration_error: "Yapılandırma hatası",
  unknown_outcome: "Sonuç belirsiz (yeniden denenmedi)",
  bulk_send_disabled: "Gerçek gönderim bu ortamda kapalı",
};

export function marketingReasonLabel(code: string): string {
  return MARKETING_REASON_LABELS[code] ?? code;
}

// ---------------------------------------------------------------------------
// Kullanıcı listesi ve ayrıntı sekmeleri (karar 0049)
// ---------------------------------------------------------------------------

const DATE_ONLY = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "short",
  timeZone: "Europe/Istanbul",
});

export function formatDate(value: Date): string {
  return DATE_ONLY.format(value);
}

/** NULL sayaç "bilinmiyor"dur, asla 0 değil. Başlangıç tarihi varsa eklenir. */
export function formatCounterSince(n: number | null, since: Date | null): string {
  if (n === null) return "Bilinmiyor";
  return since ? `${formatCount(n)} (${formatDate(since)} tarihinden beri)` : formatCount(n);
}

const SIGNUP_PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  apple: "Apple",
  phone: "Telefon",
  email: "E-posta bağlantısı",
};

export function signupProviderLabel(value: string | null): string {
  return value ? (SIGNUP_PROVIDER_LABELS[value] ?? value) : "Bilinmiyor";
}

/** Liste: analitik rızası (0049 §1b: açık / kapalı / kayıt yok). */
const LIST_ANALYTICS_LABELS: Record<string, string> = {
  accepted: "Açık",
  declined: "Kapalı",
  none: "Kayıt yok",
};

export function listAnalyticsLabel(value: string): string {
  return LIST_ANALYTICS_LABELS[value] ?? value;
}

/** Ayrıntı: türetilmiş rıza durumu. "Kayıt yok" asla "kabul" gibi gösterilmez. */
const CONSENT_STATUS_LABELS: Record<string, string> = {
  accepted: "Kabul",
  rejected: "Ret",
  revoked: "Geri alındı",
  unknown: "Kayıt yok",
};

export function consentStatusLabel(value: string): string {
  return CONSENT_STATUS_LABELS[value] ?? value;
}

const CONSENT_SOURCE_LABELS: Record<string, string> = {
  account_settings: "Hesap ayarları",
  cookie_banner: "Çerez bandı",
  cookie_sync: "Girişte çerezden aktarıldı",
  sign_in: "Giriş",
  unsubscribe_link: "Abonelikten çıkma bağlantısı",
};

export function consentSourceLabel(value: string | null): string {
  return value ? (CONSENT_SOURCE_LABELS[value] ?? value) : "Bilinmiyor";
}

const AUTH_EVENT_LABELS: Record<string, string> = {
  sign_up: "Kayıt",
  sign_in: "Giriş",
  sign_out: "Çıkış",
  session_revoked: "Oturum sonlandırıldı",
};

export function authEventLabel(value: string): string {
  return AUTH_EVENT_LABELS[value] ?? value;
}

const DEVICE_CLASS_LABELS: Record<string, string> = {
  mobile: "Mobil",
  tablet: "Tablet",
  desktop: "Masaüstü",
  other: "Diğer",
};

const BROWSER_FAMILY_LABELS: Record<string, string> = {
  chrome: "Chrome",
  safari: "Safari",
  firefox: "Firefox",
  edge: "Edge",
  samsung: "Samsung Internet",
  opera: "Opera",
  other: "Diğer",
};

/** Kaba cihaz/tarayıcı/ülke: "Mobil · Safari · TR"; hiçbiri yoksa "Bilinmiyor". */
export function deviceContextLabel(context: {
  deviceClass: string | null;
  browserFamily: string | null;
  countryCode: string | null;
}): string {
  const parts = [
    context.deviceClass ? (DEVICE_CLASS_LABELS[context.deviceClass] ?? context.deviceClass) : null,
    context.browserFamily
      ? (BROWSER_FAMILY_LABELS[context.browserFamily] ?? context.browserFamily)
      : null,
    context.countryCode,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Bilinmiyor";
}

const ACTIVITY_KIND_LABELS: Record<string, string> = {
  search_submitted: "Metin araması",
  product_viewed: "Ürün görüntüleme",
  merchant_exit: "Mağazaya geçiş",
};

export function activityKindLabel(value: string): string {
  return ACTIVITY_KIND_LABELS[value] ?? value;
}

const CHANNEL_LABELS: Record<string, string> = {
  web: "Web",
  mcp: "MCP",
  extension: "Eklenti",
  api: "API",
  prefix_link: "Link öneki",
};

export function channelLabel(value: string): string {
  return CHANNEL_LABELS[value] ?? value;
}

const CLICK_SURFACE_LABELS: Record<string, string> = {
  search: "Arama",
  collection: "Koleksiyon",
  alert: "Alarm",
  compare: "Karşılaştırma",
};

export function clickSurfaceLabel(value: string | null): string {
  return value ? (CLICK_SURFACE_LABELS[value] ?? value) : "—";
}

const CONVERSION_STATUS_LABELS: Record<string, string> = {
  pending: "Beklemede",
  confirmed: "Onaylandı",
  cancelled: "İptal",
  paid: "Ödendi",
};

export function conversionStatusLabel(value: string): string {
  return CONVERSION_STATUS_LABELS[value] ?? value;
}

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Kritik",
  warning: "Uyarı",
  unknown: "Bilinmiyor",
  info: "Bilgi",
  healthy: "Sağlıklı",
};

export function severityLabel(severity: Severity): string {
  return SEVERITY_LABELS[severity];
}

// --- S2 search/dictionary ---

const SEARCH_FILTER_LABELS: Record<string, string> = {
  category: "Kategori",
  color: "Renk",
  price_min: "En düşük fiyat",
  price_max: "En yüksek fiyat",
  size: "Beden",
  brand_include: "Marka",
  brand_exclude: "Hariç marka",
};

/** Arama filtresi adı (`FilterPredicateName`) arayüzde Türkçe. */
export function searchFilterLabel(name: string): string {
  return SEARCH_FILTER_LABELS[name] ?? name;
}

/** Skor çarpanı: 3 ondalık, yoksa tire. */
export function formatFactor(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(3);
}

const SEARCH_QUALITY_KIND_LABELS: Record<string, string> = {
  zero: "Sonuçsuz",
  fallback: "Yedek listeye düşen",
  unrecognized: "Tanınmayan kelimeli",
  frequent: "En sık",
};

export function searchQualityKindLabel(kind: string): string {
  return SEARCH_QUALITY_KIND_LABELS[kind] ?? kind;
}

/** Arama tanısı adresi (sorgu ön dolu; isteğe bağlı ürün sorgusu). */
export function diagnosticsHref(query: string, product?: string): string {
  return hrefWith("/yonetim/arama/tani", { q: query, urun: product });
}

// --- S1 matching/catalog ---
// Eşleştirme kanıtı ve katalog kalitesi (karar 0053).

const IDENTIFIER_STATE_LABELS: Record<string, string> = {
  equal: "Aynı",
  conflict: "Çatışıyor",
  different: "Farklı",
  missing: "Eksik",
};

export function identifierStateLabel(state: string): string {
  return IDENTIFIER_STATE_LABELS[state] ?? state;
}

const SIGNAL_TONE_LABELS: Record<string, string> = {
  supports: "Destekliyor",
  weakens: "Zayıflatıyor",
  neutral: "Bilgi",
};

export function signalToneLabel(tone: string): string {
  return SIGNAL_TONE_LABELS[tone] ?? tone;
}

const SCORE_POSITION_LABELS: Record<string, string> = {
  below_queue: "kuyruk eşiğinin altında",
  review_band: "insan onayı bandında",
  auto_band: "otomatik kabul bandında, ama kabule uygun değil",
};

export function scorePositionLabel(position: string): string {
  return SCORE_POSITION_LABELS[position] ?? position;
}

/** 0–1 skor, Türkçe ondalık: 0,84. */
export function formatScore(score: number): string {
  return score.toFixed(2).replace(".", ",");
}
