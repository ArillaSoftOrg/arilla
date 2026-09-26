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
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export const ADMIN_ACTIONS = Object.keys(ACTION_LABELS);
