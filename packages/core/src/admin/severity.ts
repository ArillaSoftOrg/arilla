/**
 * Yönetim ekranının ortak önem modeli (docs/decisions/0052). İşletim sağlığı,
 * katalog kalitesi ve "şimdi ne dikkat istiyor?" listesi aynı dili konuşur.
 *
 * - `critical`: veri kaybı/uyumluluk ya da kullanıcıya yanlış veri; hemen.
 * - `warning`: işin bir kısmı aksıyor; bugün bakılmalı.
 * - `info`: bilinmesi iyi, eylem zorunlu değil.
 * - `healthy`: beklenen durum.
 * - `unknown`: denetim çalıştırılamadı (zaman aşımı/hata). Sessizce sağlıklı
 *   sayılmaz.
 *
 * Abartma yok: "geride olabilir" gibi kesin olmayan bir sinyal `info`'dur.
 */
import type { Capability } from "./capabilities.ts";

export const SEVERITIES = ["critical", "warning", "unknown", "info", "healthy"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Küçük olan daha acil. Sıralama ve "en kötü" hesabı için. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
  info: 3,
  healthy: 4,
};

export function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

export function worstSeverity(severities: readonly Severity[]): Severity {
  let worst: Severity = "healthy";
  for (const severity of severities) {
    if (SEVERITY_RANK[severity] < SEVERITY_RANK[worst]) worst = severity;
  }
  return worst;
}

export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

/**
 * Tek bir bulgu: işletim denetimi, katalog kalite sorunu ya da dikkat öğesi.
 * Metinler Türkçe ve operatör içindir; kişisel veri, sır, ham hata metni YOK.
 */
export interface AdminFinding {
  /** Kararlı anahtar (ör. `ingest.stuck`, `catalog.duplicate_gtin`). */
  key: string;
  severity: Severity;
  /** Kısa başlık: "3 mağaza 24 saattir yenilenmedi". */
  title: string;
  /** Ne anlama geliyor, neden önemli. */
  meaning: string;
  /** Somut kanıt: sayı, örnek kimlik, zaman. */
  evidence: string | null;
  /** Operatörün yapması gereken. */
  action: string;
  /** Teşhis sayfası; yalnızca `capability` sahibine gösterilir. */
  href: string | null;
  /** `href`'i açmak için gereken yetenek (bağlantı gösterim koşulu, yetki değil). */
  capability: Capability | null;
  /** Kanıtın zamanı (son koşu, son kanıt) ya da denetim anı. */
  evidenceAt: Date | null;
}

export function sortFindings<T extends Pick<AdminFinding, "severity" | "title">>(
  findings: T[],
): T[] {
  return [...findings].sort(
    (a, b) => compareSeverity(a.severity, b.severity) || a.title.localeCompare(b.title, "tr"),
  );
}
