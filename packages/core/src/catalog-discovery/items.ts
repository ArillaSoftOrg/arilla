/**
 * Kesif kaydi: sitemap ogesinden urun kimligi cikarma ve SUNUCU tarafi yeniden dogrulama
 * (karar 0120). Ayni kurallar iki yerde de kullanilir; istemci guvenilmez girdidir.
 *
 * Kimlik URL'nin sonundaki koddur (`-pm-HBC...` urun modeli, `-p-HBCV...` varyant). Kod
 * yoksa kayit atilir. Baslik yalnizca sitemap'in gorsel basligindan gelir; yoksa NULL kalir.
 * Fiyat alani YOKTUR.
 */

export interface DiscoveryItem {
  externalId: string;
  codeKind: "pm" | "p";
  /** Kaynak alan adi olmadan yol (`/apple-iphone-15-128-gb-pm-HBC0000ABC`). */
  urlPath: string;
  title: string | null;
  imageUrl: string | null;
}

export interface DiscoveryRules {
  /** Urun adresinin alan adi (alt alan adlari dahil), or. `hepsiburada.com`. */
  urlHost: string;
  /** Gorsel adresinin alan adi, or. `hepsiburada.net`. */
  imageHost: string;
}

export type DiscoveryRejection = "not_object" | "url" | "external_id" | "code_kind" | "title";

const PRODUCT_CODE = /-(pm|p)-([A-Za-z0-9]{4,40})$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: denetim karakterlerini reddetmek icin
const CONTROL = /[\u0000-\u001f\u007f]/;

function hostMatches(hostname: string, host: string): boolean {
  return hostname === host || hostname.endsWith(`.${host}`);
}

function httpsOn(raw: unknown, host: string, maxLength: number): URL | null {
  if (typeof raw !== "string" || raw.length > maxLength) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || !hostMatches(u.hostname, host)) {
      return null;
    }
    return u;
  } catch {
    return null;
  }
}

/** Baslik: bosluk sadelestirilir; bos, cok uzun ya da denetim karakterli baslik NULL olur. */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length < 1 || t.length > 500 || CONTROL.test(t)) return null;
  return t;
}

/** Yoldan urun kodu: `-pm-KOD` / `-p-KOD`. */
export function productCodeFromPath(
  path: string,
): { externalId: string; codeKind: "pm" | "p" } | null {
  const m = PRODUCT_CODE.exec(path);
  if (!m) return null;
  return { codeKind: m[1] as "pm" | "p", externalId: m[2] as string };
}

/** Sitemap ogesinden kesif kaydi; urun adresi degilse NULL. */
export function itemFromSitemapEntry(
  entry: { loc: string; imageLoc: string | null; imageTitle: string | null },
  rules: DiscoveryRules,
): DiscoveryItem | null {
  const url = httpsOn(entry.loc, rules.urlHost, 2048);
  if (!url) return null;
  const path = url.pathname;
  if (path.length < 2 || path.length > 1024) return null;
  const code = productCodeFromPath(path);
  if (!code) return null;
  const image = httpsOn(entry.imageLoc, rules.imageHost, 1024);
  return {
    externalId: code.externalId,
    codeKind: code.codeKind,
    // Sorgu ve parca kimlige karismaz.
    urlPath: path,
    title: cleanTitle(entry.imageTitle),
    imageUrl: image ? image.toString() : null,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Istemciden gelen kaydin yeniden dogrulanmasi. Bilinmeyen alanlar atilir. */
export function validateDiscoveryItem(
  raw: unknown,
  rules: DiscoveryRules,
): { ok: true; item: DiscoveryItem } | { ok: false; code: DiscoveryRejection } {
  if (!isRecord(raw)) return { ok: false, code: "not_object" };
  const { externalId, codeKind, urlPath, title, imageUrl } = raw;
  if (
    typeof urlPath !== "string" ||
    urlPath.length < 2 ||
    urlPath.length > 1024 ||
    !urlPath.startsWith("/") ||
    urlPath.startsWith("//") ||
    CONTROL.test(urlPath) ||
    /[?#\s]/.test(urlPath)
  ) {
    return { ok: false, code: "url" };
  }
  const code = productCodeFromPath(urlPath);
  if (!code) return { ok: false, code: "url" };
  if (codeKind !== code.codeKind) return { ok: false, code: "code_kind" };
  if (externalId !== code.externalId) return { ok: false, code: "external_id" };
  if (title !== null && title !== undefined && cleanTitle(title) === null) {
    return { ok: false, code: "title" };
  }
  const image = httpsOn(imageUrl, rules.imageHost, 1024);
  return {
    ok: true,
    item: {
      externalId: code.externalId,
      codeKind: code.codeKind,
      urlPath,
      title: cleanTitle(title),
      imageUrl: image ? image.toString() : null,
    },
  };
}

/**
 * Ayni partide ayni kimlik bir kez yazilir (ON CONFLICT ayni satira iki kez dokunamaz).
 * SON gorulen kayit kalir; sayac tekrari ayri bildirir.
 */
export function dedupeItems(items: DiscoveryItem[]): {
  unique: DiscoveryItem[];
  duplicates: number;
} {
  const byId = new Map<string, DiscoveryItem>();
  for (const item of items) byId.set(item.externalId, item);
  return { unique: [...byId.values()], duplicates: items.length - byId.size };
}
