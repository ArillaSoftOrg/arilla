/**
 * Kesif defteri (catalog_discovery, karar 0120) kaydinin SUNUCU tarafi dogrulamasi.
 * Istemci guvenilmez girdidir: her alan yeniden sinanir, bilinmeyen alan atilir,
 * eksik alan uydurulmaz. FIYAT alani kabul edilmez: kesif defterinde fiyat yoktur.
 */
import { isRecord } from "./parse-helpers.ts";

export interface DiscoveryItemInput {
  externalId: string;
  codeKind: "pm" | "p";
  url: string;
  title: string | null;
  imageUrl: string | null;
  sourceUnitKey: string;
}

export type DiscoveryRejection = "not_object" | "external_id" | "code_kind" | "url" | "unit_key";

export interface DiscoveryRules {
  urlHost: string;
  imageHost: string;
}

/** Sitemap dosyasi / liste yolu anahtari: yol benzeri, ASCII, en fazla 200 karakter. */
export const UNIT_KEY = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/;

const PRODUCT_PATH = /-(pm|p)-([A-Za-z0-9]{3,60})$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: denetim karakterlerini reddetmek icin
const CONTROL = /[\u0000-\u001f\u007f]/;

function hostOk(raw: string, suffix: string): URL | null {
  try {
    const u = new URL(raw);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      !(u.hostname === suffix || u.hostname.endsWith(`.${suffix}`))
    ) {
      return null;
    }
    return u;
  } catch {
    return null;
  }
}

/** Bos/bozuk baslik reddedilmez, NULL olur: kimlik ve URL yeterlidir. */
function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length < 1 || t.length > 500 || CONTROL.test(t)) return null;
  return t;
}

export function validateDiscoveryItem(
  raw: unknown,
  rules: DiscoveryRules,
): { ok: true; item: DiscoveryItemInput } | { ok: false; code: DiscoveryRejection } {
  if (!isRecord(raw)) return { ok: false, code: "not_object" };
  const { externalId, codeKind, url, title, imageUrl, sourceUnitKey } = raw;
  if (typeof sourceUnitKey !== "string" || !UNIT_KEY.test(sourceUnitKey)) {
    return { ok: false, code: "unit_key" };
  }
  if (codeKind !== "pm" && codeKind !== "p") return { ok: false, code: "code_kind" };
  if (typeof url !== "string" || url.length > 2048) return { ok: false, code: "url" };
  const parsed = hostOk(url, rules.urlHost);
  // Kanonik adres: sorgu ve parca yok; kimlik URL'nin sonundaki koddan DOGRULANIR.
  if (!parsed || parsed.search || parsed.hash) return { ok: false, code: "url" };
  const m = PRODUCT_PATH.exec(parsed.pathname);
  if (!m || m[1] !== codeKind) return { ok: false, code: "url" };
  if (typeof externalId !== "string" || externalId !== m[2]) {
    return { ok: false, code: "external_id" };
  }
  let image: string | null = null;
  if (
    typeof imageUrl === "string" &&
    imageUrl.length <= 2048 &&
    hostOk(imageUrl, rules.imageHost)
  ) {
    image = imageUrl;
  }
  return {
    ok: true,
    item: {
      externalId,
      codeKind,
      url: parsed.toString(),
      title: cleanTitle(title),
      imageUrl: image,
      sourceUnitKey,
    },
  };
}
