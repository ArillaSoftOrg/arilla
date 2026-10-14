/**
 * Tarayici tabanli canli okuma (karar 0117) bayraklari. Varsayilan: KAPALI.
 *
 * - `TRENDYOL_BROWSER_READ_ENABLED=true`: ayristiricilar ve kuru calisma (dry-run) raporlari
 *   kullanilabilir. Bayrak kapaliyken istemci (eklenti) hicbir sey okumaz.
 * - `TRENDYOL_BROWSER_SCOPE_CONFIRMED=true`: Trendyol'un izin kapsami YAZILI olarak
 *   netlesti. Bu olmadan otomatik toplu okuma ve katalog aktarimi baslatilamaz.
 *
 * Production aktarimi bu modulde YOKTUR; yalnizca satir onizlemesi uretilir.
 */

type Env = Readonly<Record<string, string | undefined>>;

const on = (v: string | undefined) => v?.trim().toLowerCase() === "true";

export function isTrendyolBrowserReadEnabled(env: Env): boolean {
  return on(env.TRENDYOL_BROWSER_READ_ENABLED);
}

export type BulkGate =
  | { allowed: true }
  | { allowed: false; reason: "read_disabled" | "scope_not_confirmed" };

/** Toplu (otomatik) okuma ve katalog yenilemesi icin iki bayrak birlikte gerekir. */
export function bulkRefreshGate(env: Env): BulkGate {
  if (!isTrendyolBrowserReadEnabled(env)) return { allowed: false, reason: "read_disabled" };
  if (!on(env.TRENDYOL_BROWSER_SCOPE_CONFIRMED)) {
    return { allowed: false, reason: "scope_not_confirmed" };
  }
  return { allowed: true };
}
