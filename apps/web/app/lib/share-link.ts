/**
 * Paylaşım akışı (ürün ve trend sayfaları). Tarayıcı API'leri parametre olarak
 * gelir; böylece destek/iptal/hata dalları DOM'suz test edilir.
 *
 * Sıra: Web Share API (varsa ve adresi kabul ediyorsa) -> pano -> başarısız
 * (arayüz adresi seçilebilir gösterir). Kullanıcının iptali (`AbortError`) hata
 * değildir ve panoya düşülmez: kullanıcı vazgeçmiştir.
 *
 * Paylaşılan tek şey kanonik sayfa adresidir: sorgu dizisi ve parça atılır
 * (seçili beden, oturum, takip parametresi paylaşılmaz).
 */

export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

export interface ShareTarget {
  url: string;
  title: string;
}

/** `navigator`ın kullanılan alt kümesi; hepsi isteğe bağlıdır (eski tarayıcı). */
export interface ShareEnvironment {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  clipboard?: { writeText: (text: string) => Promise<void> };
}

/**
 * Göreli ya da mutlak adresi `origin`e göre çözer; yalnız `http(s)` ve aynı kökene
 * ait adres kabul edilir, sorgu ve parça atılır. Uymayan adres null.
 */
export function canonicalShareUrl(raw: string, origin: string): string | null {
  let parsed: URL;
  let base: URL;
  try {
    base = new URL(origin);
    parsed = new URL(raw, base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

async function copy(env: ShareEnvironment, url: string): Promise<ShareOutcome> {
  if (!env.clipboard?.writeText) return "failed";
  try {
    await env.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

export async function shareLink(env: ShareEnvironment, target: ShareTarget): Promise<ShareOutcome> {
  const data: ShareData = { title: target.title, url: target.url };
  let supported = typeof env.share === "function";
  if (supported && typeof env.canShare === "function") {
    try {
      supported = env.canShare(data);
    } catch {
      supported = false;
    }
  }
  if (supported && env.share) {
    try {
      await env.share(data);
      return "shared";
    } catch (error) {
      if (isAbort(error)) return "cancelled";
      // İzin/etkinlik hatası (ör. `NotAllowedError`): adres yine panoya verilir.
    }
  }
  return copy(env, target.url);
}
