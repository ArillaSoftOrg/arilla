/** /yonetim ekranlarının ortak gösterim yardımcıları. Saat dilimi: Türkiye. */

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
  "users.role_change": "Rol değiştirildi",
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
