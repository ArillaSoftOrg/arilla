/**
 * Sitemap girdisinden kesif kaydi (karar 0120). Tarayicida calisir; sunucu ayni sekli
 * `validateDiscoveryItem` ile yeniden dogrular. Fiyat alani yoktur.
 */
import type { SitemapUrlEntry } from "./sitemap-stream.ts";

export interface SitemapDiscoveryRecord {
  externalId: string;
  codeKind: "pm" | "p";
  url: string;
  title: string | null;
  imageUrl: string | null;
  sourceUnitKey: string;
}

const PRODUCT_PATH = /-(pm|p)-([A-Za-z0-9]{3,60})$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: denetim karakterlerini reddetmek icin
const CONTROL = /[\u0000-\u001f\u007f]/;

function httpsOn(raw: string | null, host: string): URL | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    const ok =
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (u.hostname === host || u.hostname.endsWith(`.${host}`));
    return ok ? u : null;
  } catch {
    return null;
  }
}

/** Urun adresi degilse (kodsuz, yabanci alan adi) `null`; baslik yoksa uydurulmaz. */
export function recordFromSitemapEntry(
  entry: SitemapUrlEntry,
  unitKey: string,
): SitemapDiscoveryRecord | null {
  const url = httpsOn(entry.loc, "hepsiburada.com");
  if (!url) return null;
  const m = PRODUCT_PATH.exec(url.pathname);
  if (!m) return null;
  const image = httpsOn(entry.imageLoc, "hepsiburada.net");
  const title = entry.imageTitle?.replace(/\s+/g, " ").trim() ?? "";
  return {
    externalId: m[2] as string,
    codeKind: m[1] as "pm" | "p",
    // Sorgu ve parca kimlige karismaz.
    url: `${url.origin}${url.pathname}`,
    title: title && title.length <= 500 && !CONTROL.test(title) ? title : null,
    imageUrl: image ? `${image.origin}${image.pathname}${image.search}` : null,
    sourceUnitKey: unitKey,
  };
}
