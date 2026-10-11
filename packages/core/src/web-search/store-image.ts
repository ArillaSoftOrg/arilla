/**
 * Internet sonucu urunleri icin magaza sayfasindan gorsel cozumleme
 * (docs/decisions/0102). Ek Gemini cagrisi YOK: yalnizca zaten dogrulanmis
 * urun baglantilari, sunucuda SSRF-guvenli ve sinirli olarak okunur.
 *
 * Gorsel yalnizca sayfanin KENDI urun verisinden (JSON-LD `Product.image`, yoksa
 * urun isaretli `og:image`) ve yalnizca sayfadaki urun adi kartin urunuyle
 * uyusuyorsa kullanilir (model kodu + varyant uyumu). Gorsel indirilmez,
 * saklanmaz ya da onbellege alinmaz; tarayici dogrudan magaza sunucusundan
 * yukler (hotlink, `referrerpolicy=no-referrer`). robots.txt ve erisim
 * engelleri (401/403/429) saygiyla karsilanir; atlatilmaz.
 */
import { sameVariant, significantTokens } from "./merge.ts";
import { asciiFold, extractFeatures } from "./query.ts";
import { safeGet } from "./safe-fetch.ts";
import type { WebProductGroup } from "./types.ts";
import { toSafePublicUrl } from "./url-safety.ts";

const PAGE_MAX_BYTES = 400_000;
const ROBOTS_MAX_BYTES = 64_000;
const PAGE_TIMEOUT_MS = 3_000;
const IMAGE_MAX_BYTES = 8_000_000;
const TOTAL_BUDGET_MS = 5_500;
const MAX_GROUPS = 8;
const MAX_OFFERS_TRIED = 2;
const NAME_COVERAGE = 0.6;
const IMAGE_TYPES = /^image\/(?:jpeg|jpg|png|webp|avif|gif)\b/;

export type SafeGetFn = typeof safeGet;

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, num: string) => String.fromCodePoint(Number(num)));
}

function metaContent(html: string, key: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (name !== key) continue;
    const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
    const value = content?.[1] ?? content?.[2];
    if (value) return decodeEntities(value).trim();
  }
  return null;
}

function isProductNode(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  const list = Array.isArray(type) ? type : [type];
  return list.some(
    (t) =>
      typeof t === "string" &&
      (t.toLowerCase() === "product" || t.toLowerCase() === "productgroup"),
  );
}

function imageFromJsonLd(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = imageFromJsonLd(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return imageFromJsonLd(record.url ?? record.contentUrl);
  }
  return null;
}

function findProducts(value: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 5 || out.length >= 5) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) findProducts(item, out, depth + 1);
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (isProductNode(record)) out.push(record);
    findProducts(record["@graph"], out, depth + 1);
    findProducts(record.mainEntity, out, depth + 1);
  }
}

export interface PageProduct {
  name: string;
  image: string;
}

/** Sayfa HTML'inden (urun adi, gorsel adresi) cifti; yoksa `null`. Saf fonksiyon. */
export function extractPageProduct(html: string, pageUrl: string): PageProduct | null {
  const resolve = (raw: string): string | null => {
    try {
      return toSafePublicUrl(new URL(decodeEntities(raw).trim(), pageUrl).toString())?.url ?? null;
    } catch {
      return null;
    }
  };
  const scripts = html.match(/<script\b[^>]*ld\+json[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  for (const script of scripts.slice(0, 8)) {
    const json = script.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    const products: Record<string, unknown>[] = [];
    findProducts(parsed, products);
    for (const product of products) {
      const name = typeof product.name === "string" ? decodeEntities(product.name).trim() : "";
      const rawImage = imageFromJsonLd(product.image);
      const image = rawImage ? resolve(rawImage) : null;
      if (name && image) return { name, image };
    }
  }
  const ogImage = metaContent(html, "og:image") ?? metaContent(html, "og:image:url");
  const ogTitle = metaContent(html, "og:title");
  const ogType = metaContent(html, "og:type") ?? "";
  // og:image yalnizca sayfa kendini urun olarak isaretliyorsa guvenilir.
  if (ogImage && ogTitle && /product/i.test(ogType)) {
    const image = resolve(ogImage);
    if (image) return { name: ogTitle, image };
  }
  return null;
}

/** Sayfadaki urun adi kartin urunuyle uyusuyor mu (model kodu + kapsama + varyant). */
export function productNameMatches(
  group: Pick<WebProductGroup, "title" | "brand">,
  pageName: string,
): boolean {
  const wanted = significantTokens(`${group.brand ?? ""} ${group.title}`);
  if (wanted.length === 0) return false;
  const page = new Set(significantTokens(pageName));
  const covered = wanted.filter((t) => page.has(t)).length / wanted.length;
  if (covered < NAME_COVERAGE) return false;
  const a = extractFeatures(group.title, group.brand);
  const b = extractFeatures(pageName, null);
  const foldedPage = asciiFold(pageName).replace(/[^a-z0-9]/g, "");
  for (const code of a.modelCodes) {
    if (!foldedPage.includes(code.replace(/[^a-z0-9]/g, ""))) return false;
  }
  return sameVariant(a, b);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Basit robots.txt: `ManiCepteBot` ya da `*` grubunda en uzun eslesen kural kazanir. */
export function robotsAllows(robotsTxt: string, path: string): boolean {
  const rules: { allow: boolean; prefix: string; specific: boolean }[] = [];
  let agents: string[] = [];
  let lastWasAgent = false;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const field = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    if (field === "user-agent") {
      if (!lastWasAgent) agents = [];
      agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field !== "allow" && field !== "disallow") continue;
    const specific = agents.some((a) => a.includes("manicepte"));
    if (!specific && !agents.includes("*")) continue;
    rules.push({ allow: field === "allow", prefix: value, specific });
  }
  const useSpecific = rules.some((r) => r.specific);
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rules) {
    if (useSpecific && !rule.specific) continue;
    if (rule.prefix === "") continue;
    const pattern = rule.prefix.replace(/\$$/, "");
    const hit = pattern.includes("*")
      ? new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}`).test(path)
      : path.startsWith(pattern);
    if (hit && (best === null || pattern.length >= best.length)) {
      best = { allow: rule.allow, length: pattern.length };
    }
  }
  return best === null ? true : best.allow;
}

export interface StoreImageDeps {
  get?: SafeGetFn;
  budgetMs?: number;
}

async function imageForOffer(
  group: WebProductGroup,
  offerUrl: string,
  get: SafeGetFn,
  signal: AbortSignal,
): Promise<string | null> {
  const safe = toSafePublicUrl(offerUrl);
  if (safe === null) return null;
  const parsed = new URL(safe.url);
  const robots = await get(`https://${safe.host}/robots.txt`, {
    maxBytes: ROBOTS_MAX_BYTES,
    timeoutMs: PAGE_TIMEOUT_MS,
    accept: "text/plain",
    signal,
  });
  if (robots && robots.status === 200) {
    if (!robotsAllows(robots.body.toString("utf8"), `${parsed.pathname}${parsed.search}`)) {
      return null;
    }
  }
  const page = await get(safe.url, {
    maxBytes: PAGE_MAX_BYTES,
    timeoutMs: PAGE_TIMEOUT_MS,
    accept: "text/html,application/xhtml+xml",
    signal,
  });
  // 401/403/429 vb. erisim engeli: denenmez, atlatilmaz.
  if (!page || page.status !== 200 || !page.contentType.includes("html")) return null;
  const product = extractPageProduct(page.body.toString("utf8"), page.finalUrl);
  if (!product || !productNameMatches(group, product.name)) return null;
  const image = await get(product.image, {
    maxBytes: 0,
    timeoutMs: PAGE_TIMEOUT_MS,
    accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.5",
    headersOnly: true,
    signal,
  });
  if (!image || image.status !== 200 || !IMAGE_TYPES.test(image.contentType)) return null;
  if (image.contentLength !== null && image.contentLength > IMAGE_MAX_BYTES) return null;
  return product.image;
}

/**
 * Gorseli olmayan gruplara magaza sayfasindan gorsel ekler. Hata/zaman asimi
 * gorselin yoklugudur; sonuc listesini asla bozmaz. Toplam sure sinirlidir.
 */
export async function attachStoreImages(
  groups: readonly WebProductGroup[],
  deps: StoreImageDeps = {},
): Promise<WebProductGroup[]> {
  const get = deps.get ?? safeGet;
  const signal = AbortSignal.timeout(deps.budgetMs ?? TOTAL_BUDGET_MS);
  return Promise.all(
    groups.map(async (group, index) => {
      if (group.imageUrl || index >= MAX_GROUPS) return group;
      for (const offer of group.offers.slice(0, MAX_OFFERS_TRIED)) {
        if (signal.aborted) break;
        try {
          const imageUrl = await imageForOffer(group, offer.url, get, signal);
          if (imageUrl) return { ...group, imageUrl };
        } catch {
          // Gorsel yok sayilir.
        }
      }
      return group;
    }),
  );
}
