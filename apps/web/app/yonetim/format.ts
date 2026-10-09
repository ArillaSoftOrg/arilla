/** /yonetim ekranlarının ortak gösterim yardımcıları. Saat dilimi: Türkiye. */

// İstemci bileşenleri de bu dosyayı içe aktarır: core'dan yalnızca TİP ve saf
// alt yol (`@arilla/core/cost-truth`) alınır, sunucu kodu pakete girmez.
import type {
  AdminAction,
  AdminTargetType,
  AttentionState,
  PipelineStage,
  PipelineStageState,
  Severity,
} from "@arilla/core";
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
 * Maliyetin dürüst gösterimi (karar 0051, core `costState`). Fiyatlanamayan
 * çağrılar (oran ya da kur tanımsız, fiyat kuralı olmayan model, kullanım
 * bilgisi gelmeyen deneme; karar 0082) 0 maliyetle yazılır; "0,00 TL" gerçek
 * harcama gibi görünmesin diye bu durumda tutar yerine "Hesaplanmadı" / "en
 * az" yazılır. Tutar her durumda tahminidir, sağlayıcı faturası değildir.
 */
export function formatCost(summary: CostSummary): { value: string; note: string | null } {
  const state = costState(summary);
  const unpriced = `${formatCount(summary.unpricedCalls)} çağrı fiyatlanmadı (oran, kur ya da kullanım bilgisi yok)`;
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
  // form (karar 0058)
  published: "yayında",
  closed: "kapalı",
  // marketing_campaign_delivery: "sent" = sağlayıcı kabul etti, teslim değil
  sent: "sağlayıcıya verildi",
  skipped: "atlandı",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** `Record<AdminAction, …>`: denetime yeni eylem eklenince etiketi derlemede istenir (karar 0082). */
const ACTION_LABELS: Record<AdminAction, string> = {
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
  "forms.create": "Form oluşturuldu",
  "forms.update": "Form güncellendi",
  "forms.publish": "Form yayınlandı",
  "forms.close": "Form kapatıldı",
  "forms.results_view": "Form sonuçları görüntülendi",
  "messages.list_view": "Gelen kutusu görüntülendi",
  "chat_feedback.list_view": "AI geri bildirimleri görüntülendi",
  "chat_feedback.view": "AI geri bildirim ayrıntısı görüntülendi",
  "early_access.counter_set": "Erken erişim sayacı güncellendi",
  "security.access_denied": "Yetkisiz yönetim erişimi reddedildi",
  "security.admin_session_ended": "Yönetim oturumu sonlandırıldı",
  "sessions.revoke_all": "Tüm oturumlar kapatıldı",
  "trends.publish": "Trend yayınlandı",
  "trends.unpublish": "Trend yayından kaldırıldı",
  "trends.archive": "Trend arşivlendi",
  "trends.restore": "Trend arşivden taslağa alındı",
  "trends.feature": "Trend öne çıkarıldı",
  "trends.unfeature": "Trend öne çıkarılmaktan çıkarıldı",
  "trends.reorder": "Trend sırası değişti",
  "messages.status_change": "Mesaj durumu değişti",
  "messages.priority_change": "Mesaj önceliği değişti",
};

export function actionLabel(action: string): string {
  return (ACTION_LABELS as Record<string, string>)[action] ?? action;
}

/** Denetim hedef türleri; `Record<AdminTargetType, …>` eksik etiketi derlemede yakalar. */
export const TARGET_TYPE_LABELS: Record<AdminTargetType, string> = {
  match_candidate: "Eşleştirme adayı",
  lexicon: "Sözlük satırı",
  merchant: "Mağaza",
  app_user: "Hesap",
  marketing_campaign: "E-posta kampanyası",
  form: "Form / anket",
  feedback: "Gelen kutusu",
  chat_feedback: "AI geri bildirimi",
  early_access_counter: "Erken erişim sayacı",
  capability: "Yetenek",
  trend: "Trend",
};

export function targetTypeLabel(targetType: string): string {
  return (TARGET_TYPE_LABELS as Record<string, string>)[targetType] ?? targetType;
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

// --- S3 ops/ux ---

const PIPELINE_REASON_LABELS_0055: Record<string, string> = {
  job_failed: "son iş koşusu başarısız",
  job_stuck: '2 saattir "sürüyor" kalan iş koşusu var',
};

/** Boru hattı nedeni; 0055 nedenleri dahil (`pipelineReasonLabel`'a düşer). */
export function pipelineReasonText(reason: string): string {
  return PIPELINE_REASON_LABELS_0055[reason] ?? pipelineReasonLabel(reason);
}

/** "son çalıştı" (`job_run`) ya da "son kanıt" (verinin zamanı). */
export function pipelineSourceLabel(source: "job_run" | "data"): string {
  return source === "job_run" ? "son çalıştı (iş koşusu)" : "son kanıt (veri zamanı)";
}

const JOB_TRIGGER_LABELS: Record<string, string> = {
  manual: "elle",
  cron: "zamanlayıcı",
  worker: "işçi",
};

export function jobTriggerLabel(trigger: string): string {
  return JOB_TRIGGER_LABELS[trigger] ?? trigger;
}

/** `job_run.detail` (düz sayılar) → "anahtar 12 · diğer 3"; boşsa "—". */
export function formatJobDetail(detail: Record<string, unknown>): string {
  const parts = Object.entries(detail)
    .filter(([, value]) => ["number", "boolean", "string"].includes(typeof value))
    .slice(0, 12)
    .map(
      ([key, value]) => `${key} ${typeof value === "number" ? formatCount(value) : String(value)}`,
    );
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** `datetime-local` alanı için Türkiye saatiyle `YYYY-MM-DDTHH:mm` (UTC+3, DST yok). */
export function toDateTimeLocalValue(date: Date | null): string {
  if (!date) return "";
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

/* ---- Karar 0085: analitik merkez etiketleri ---- */

const PERCENT_FORMAT = new Intl.NumberFormat("tr-TR", {
  style: "percent",
  maximumFractionDigits: 1,
});

/** Pay/payda yüzdesi; payda 0 ise "—" (0/0 oran uydurulmaz). */
export function formatPercent(part: number, whole: number): string {
  return whole > 0 ? PERCENT_FORMAT.format(part / whole) : "—";
}

const INTERPRETATION_STATUS_LABELS: Record<string, string> = {
  accepted: "Kabul edildi",
  empty: "Niyet bulunamadı",
  invalid: "Geçersiz çıktı",
};

export function interpretationStatusLabel(value: string): string {
  return INTERPRETATION_STATUS_LABELS[value] ?? value;
}

const CHAT_KIND_LABELS: Record<string, string> = {
  clarify: "Netleştirme sorusu",
  search: "Arama yanıtı",
  notice: "Bilgi / sınır mesajı",
};

export function chatKindLabel(value: string): string {
  return CHAT_KIND_LABELS[value] ?? value;
}

const AFFILIATE_STATUS_LABELS: Record<string, string> = {
  none: "Yok",
  pending: "Bekliyor",
  active: "Etkin",
  suspended: "Askıda",
};

export function affiliateStatusLabel(value: string): string {
  return AFFILIATE_STATUS_LABELS[value] ?? value;
}

const MATCH_METHOD_LABELS: Record<string, string> = {
  gtin: "GTIN",
  mpn: "MPN",
  text: "Metin",
  image: "Görsel",
  hybrid: "Karma",
};

export function matchMethodLabel(value: string): string {
  return MATCH_METHOD_LABELS[value] ?? value;
}

const IMAGE_STATUS_LABELS: Record<string, string> = {
  active: "Etkin",
  removed: "Kaynaktan kalktı",
  broken: "Kırık",
};

export function imageStatusLabel(value: string): string {
  return IMAGE_STATUS_LABELS[value] ?? value;
}

/* ---- Karar 0086: yönetim etiketleri ---- */

const TREND_STATUS_LABELS: Record<string, string> = {
  draft: "Taslak",
  published: "Yayında",
  archived: "Arşiv",
};

export function trendStatusLabel(value: string): string {
  return TREND_STATUS_LABELS[value] ?? value;
}

const TREND_WINDOW_LABELS: Record<string, string> = {
  none: "Pencere yok",
  upcoming: "Başlamadı",
  open: "Açık",
  ended: "Bitti",
};

export function trendWindowLabel(value: string): string {
  return TREND_WINDOW_LABELS[value] ?? value;
}

const INBOX_STATUS_LABELS: Record<string, string> = {
  new: "Yeni",
  reviewing: "İnceleniyor",
  planned: "Planlandı",
  resolved: "Çözüldü",
  rejected: "Reddedildi",
};

export function inboxStatusLabel(value: string): string {
  return INBOX_STATUS_LABELS[value] ?? value;
}

const INBOX_PRIORITY_LABELS: Record<string, string> = {
  low: "Düşük",
  medium: "Orta",
  high: "Yüksek",
  none: "Atanmamış",
};

export function inboxPriorityLabel(value: string | null): string {
  return INBOX_PRIORITY_LABELS[value ?? "none"] ?? value ?? "Atanmamış";
}

const CONFIG_STATE_LABELS: Record<string, string> = {
  set: "Tanımlı",
  default: "Varsayılan",
  missing: "Tanımsız",
  invalid: "Geçersiz",
  unknown: "Bilinmiyor",
  code: "Kod sabiti",
};

export function configStateLabel(value: string): string {
  return CONFIG_STATE_LABELS[value] ?? value;
}

const CONFIG_GROUP_LABELS: Record<string, string> = {
  product: "Ürün ve erişim",
  ai: "AI ve arama",
  analytics: "Trafik ölçümü (GA4)",
  email: "E-posta",
  auth: "Kimlik",
  infrastructure: "Altyapı",
  runtime: "Çalışma ortamı",
};

export function configGroupLabel(value: string): string {
  return CONFIG_GROUP_LABELS[value] ?? value;
}

const QUOTA_POOL_LABELS: Record<string, string> = {
  search_rights: "Arama hakkı (fotoğraf/link)",
  chat_message: "Sohbet mesajı",
  realtime_interpretation_user: "Anlık yorum (girişli)",
  realtime_interpretation_anonymous: "Anlık yorum (anonim)",
};

export function quotaPoolLabel(value: string): string {
  return QUOTA_POOL_LABELS[value] ?? value;
}

/* ---- Karar 0087: trafik (GA4) ---- */

const TRAFFIC_ERROR_LABELS: Record<string, string> = {
  auth: "GA4 kimlik doğrulaması başarısız (servis hesabı anahtarı geçersiz ya da iptal edilmiş).",
  identity_unavailable:
    "Çalışma ortamı kimlik belirteci (OIDC) sağlamadı; Vercel OIDC federasyonu açık mı?",
  federation_rejected:
    "Google federe kimliği reddetti (sağlayıcı, audience ya da yalnızca production koşulu).",
  impersonation_denied:
    "Federe kimliğin servis hesabını kullanma izni yok (Workload Identity User rolü).",
  permission:
    "Servis hesabının bu GA4 mülküne erişimi yok (mülkte Görüntüleyici olarak eklenmeli).",
  quota: "GA4 Data API kotası doldu; bir süre sonra yeniden denenir.",
  quota_guard: "GA4 kotası koruma eşiğinin altında; yeni istek atılmadı.",
  timeout: "GA4 yanıt vermedi (zaman aşımı).",
  network: "GA4'e bağlanılamadı.",
  upstream: "GA4 geçici bir sunucu hatası döndürdü.",
  bad_request: "GA4 isteği reddetti (rapor tanımı ya da mülk kimliği).",
  invalid_response: "GA4 yanıtı beklenen biçimde değil.",
};

export function trafficErrorLabel(code: string): string {
  return TRAFFIC_ERROR_LABELS[code] ?? "GA4 verisi alınamadı.";
}

const MONTHS_SHORT = [
  "Oca",
  "Şub",
  "Mar",
  "Nis",
  "May",
  "Haz",
  "Tem",
  "Ağu",
  "Eyl",
  "Eki",
  "Kas",
  "Ara",
];

/** GA4 kova anahtarı → kısa etiket (`20261009` → "9 Eki", `202641` → "41. hafta", `202610` → "Eki 2026"). */
export function trafficBucketLabel(key: string, granularity: string): string {
  if (granularity === "gun" && /^\d{8}$/.test(key)) {
    return `${Number(key.slice(6, 8))} ${MONTHS_SHORT[Number(key.slice(4, 6)) - 1] ?? ""}`;
  }
  if (granularity === "hafta" && /^\d{6}$/.test(key)) return `${Number(key.slice(4))}. hafta`;
  if (granularity === "ay" && /^\d{6}$/.test(key)) {
    return `${MONTHS_SHORT[Number(key.slice(4, 6)) - 1] ?? ""} ${key.slice(0, 4)}`;
  }
  return key;
}

/** Önceki döneme göre değişim; önceki 0 ise null (sonsuz yüzde gösterilmez). */
export function trafficDelta(current: number, previous: number): string | null {
  if (previous <= 0) return null;
  const change = (current - previous) / previous;
  const sign = change > 0 ? "+" : change < 0 ? "−" : "±";
  return `${sign}${new Intl.NumberFormat("tr-TR", { style: "percent", maximumFractionDigits: 1 }).format(Math.abs(change))}`;
}

const ACQUISITION_CHANNEL_LABELS: Record<string, string> = {
  Direct: "Doğrudan",
  "Organic Search": "Organik arama",
  "Paid Search": "Ücretli arama",
  "Organic Social": "Organik sosyal",
  "Paid Social": "Ücretli sosyal",
  Referral: "Yönlendiren site",
  Email: "E-posta",
  Affiliates: "Ortaklık",
  Display: "Görüntülü reklam",
  "Organic Video": "Organik video",
  "Paid Video": "Ücretli video",
  "Organic Shopping": "Organik alışveriş",
  "Paid Shopping": "Ücretli alışveriş",
  "Cross-network": "Ağlar arası",
  Unassigned: "Atanmamış",
};

/** GA4 varsayılan kanal grubu → Türkçe (bilinmeyen aynen). */
export function acquisitionChannelLabel(value: string): string {
  return ACQUISITION_CHANNEL_LABELS[value] ?? value;
}

const DEVICE_LABELS: Record<string, string> = {
  desktop: "Masaüstü",
  mobile: "Mobil",
  tablet: "Tablet",
  "smart tv": "Akıllı TV",
};

export function deviceLabel(value: string): string {
  return DEVICE_LABELS[value] ?? value;
}
