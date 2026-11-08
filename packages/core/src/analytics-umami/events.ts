/**
 * Umami etkileşim olayları (karar 0173, docs/events.md "Umami"). Saf fonksiyonlar: ağ,
 * Node ve veritabanı bağımlılığı yok; istemci bileşeni `@arilla/core/umami-events`
 * alt yolundan import eder.
 *
 * Gizlilik: olay verisi YALNIZCA sabit sözlüklerden gelir (alan, yüzey, süre aralığı).
 * Ürün/teklif kimliği, sorgu metni, adres, kullanıcı kimliği, IP gönderilmez; serbest
 * metin hiçbir alana girmez. Ölçülmeyen yollarda (`sanitizePagePath` null) olay yok.
 */
import { sanitizePagePath } from "../analytics-ga4/measurement.ts";

/** Sayfada GÖRÜNÜR kalınan süre aralıkları; kesin süre gönderilmez. */
export const ENGAGEMENT_BUCKETS = ["0-10s", "10-30s", "30-120s", "2-10m", "10m+"] as const;
export type EngagementBucket = (typeof ENGAGEMENT_BUCKETS)[number];

const BUCKET_LIMITS: readonly [upperMs: number, bucket: EngagementBucket][] = [
  [10_000, "0-10s"],
  [30_000, "10-30s"],
  [120_000, "30-120s"],
  [600_000, "2-10m"],
];

export function engagementBucket(visibleMs: number): EngagementBucket | null {
  if (!Number.isFinite(visibleMs) || visibleMs < 0) return null;
  for (const [upper, bucket] of BUCKET_LIMITS) if (visibleMs < upper) return bucket;
  return "10m+";
}

/** Sitenin kaba bölümü: arındırılmış yolun ilk parçasından, sabit sözlükle. */
export const PAGE_AREAS = [
  "home",
  "search",
  "product",
  "chat",
  "trends",
  "deals",
  "discover",
  "saved",
  "history",
  "alerts",
  "blog",
  "other",
] as const;
export type PageArea = (typeof PAGE_AREAS)[number];

const AREA_BY_ROOT: Readonly<Record<string, PageArea>> = {
  ara: "search",
  urun: "product",
  sohbet: "chat",
  trendler: "trends",
  firsatlar: "deals",
  kesfet: "discover",
  kaydettiklerim: "saved",
  gecmis: "history",
  alarmlar: "alerts",
  blog: "blog",
};

/**
 * Arındırılmış yol ya da `sanitizePage(...).location` (TAM adres) alır; köken ve sorgu
 * kısmı yok sayılır. Tam adreste ilk parça köken değil yolun ilk parçasıdır.
 */
export function pageArea(sanitizedPathOrUrl: string): PageArea {
  let path = sanitizedPathOrUrl;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return "other";
    }
  }
  path = path.split(/[?#]/)[0] ?? "";
  if (path === "/" || path === "") return "home";
  const root = path.split("/")[1] ?? "";
  return AREA_BY_ROOT[root] ?? "other";
}

/**
 * `/git/:offerId?surface=` yüzeyleri. `attribution/record-click.ts` `CLICK_SURFACES` ile
 * AYNI liste (oradan import edilemez: veritabanı bağımlılığı istemci paketine girer);
 * eşitliği test korur. Listede olmayan değer `other` olur.
 */
export const EXIT_SURFACES = [
  "search",
  "collection",
  "alert",
  "compare",
  "product_primary",
  "structured_data",
  "feed_offers",
] as const;
export type ExitSurface = (typeof EXIT_SURFACES)[number] | "other";

export type LinkClickEvent =
  | { name: "product_opened"; data: { area: PageArea } }
  | { name: "merchant_exit_clicked"; data: { area: PageArea; surface: ExitSurface } };

const OFFER_EXIT = /^\/git\/\d+\/?$/;
const PRODUCT_PAGE = /^\/urun\/[^/]+\/?$/;

/**
 * Tıklanan bağlantının ölçülen bir eylem olup olmadığı. Yalnızca aynı kökenli ürün
 * sayfası (`/urun/:slug`) ve mağaza çıkışı (`/git/:offerId`) sayılır; geri kalan her şey
 * `null`. `currentHref` ölçülmeyen bir yoldaysa (yönetim, giriş alt yolları...) `null`.
 */
export function classifyLinkClick(
  href: string,
  currentHref: string,
  origin: string,
): LinkClickEvent | null {
  let target: URL;
  let current: URL;
  try {
    target = new URL(href, origin);
    current = new URL(currentHref, origin);
  } catch {
    return null;
  }
  if (target.origin !== origin || current.origin !== origin) return null;
  const currentPath = sanitizePagePath(current.pathname);
  if (currentPath === null) return null;
  const area = pageArea(currentPath);
  if (OFFER_EXIT.test(target.pathname)) {
    const raw = target.searchParams.get("surface");
    const surface: ExitSurface =
      raw !== null && (EXIT_SURFACES as readonly string[]).includes(raw)
        ? (raw as ExitSurface)
        : "other";
    return { name: "merchant_exit_clicked", data: { area, surface } };
  }
  if (PRODUCT_PAGE.test(target.pathname)) {
    return { name: "product_opened", data: { area } };
  }
  return null;
}
