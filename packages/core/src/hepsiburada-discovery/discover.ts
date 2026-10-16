/**
 * Hepsiburada urun kesfi (prototip). Harici arama API'si yok; yalnizca
 * robots.txt izin veren, herkese acik sayfalar, nazik hizla okunur.
 * Her asamada engel (403/429/captcha) gorulurse durulur ve rapora yazilir.
 */

import { type DiscoveredProduct, extractProductFromHtml, extractProductLinks } from "./extract.ts";
import type { FetchFailure, PoliteFetcher } from "./polite-fetcher.ts";

export const HEPSIBURADA_ORIGIN = "https://www.hepsiburada.com";

export type DiscoveryStatus = "ok" | "blocked" | "robots-unavailable" | "no-results";

export interface DiscoveryReport {
  query: string;
  status: DiscoveryStatus;
  /** Durumun insan okunur aciklamasi (engel varsa hangi kodla). */
  detail: string;
  products: DiscoveredProduct[];
  requestsMade: number;
  candidateLinks: number;
  skippedByRobots: number;
  failures: { url: string; reason: FetchFailure; status?: number }[];
}

/** Sorgudaki her sozcuk basliktaysa ilgili sayilir (baslik uydurulmaz, yalnizca elenir). */
export function matchesQuery(title: string, query: string): boolean {
  const norm = (s: string) =>
    s
      .toLocaleLowerCase("tr-TR")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const t = ` ${norm(title)} `;
  return norm(query)
    .split(" ")
    .filter(Boolean)
    .every((w) => t.includes(` ${w} `));
}

export async function discoverHepsiburada(
  query: string,
  fetcher: PoliteFetcher,
  opts: { maxProducts: number },
): Promise<DiscoveryReport> {
  const report: DiscoveryReport = {
    query,
    status: "no-results",
    detail: "",
    products: [],
    requestsMade: 0,
    candidateLinks: 0,
    skippedByRobots: 0,
    failures: [],
  };
  const finish = (): DiscoveryReport => {
    report.requestsMade = fetcher.requestCount;
    report.skippedByRobots = fetcher.skippedByRobots.length;
    return report;
  };

  const robots = await fetcher.loadRobots();
  if (!robots.ok) {
    const blocked = robots.reason === "blocked";
    report.status = blocked ? "blocked" : "robots-unavailable";
    report.detail = blocked
      ? `robots.txt istegi engellendi (HTTP ${robots.status ?? "?"}); izin dogrulanamadigi icin hicbir sayfa istenmedi.`
      : `robots.txt okunamadi (${robots.reason}); izin dogrulanamadigi icin hicbir sayfa istenmedi.`;
    return finish();
  }

  const searchUrl = `${HEPSIBURADA_ORIGIN}/ara?q=${encodeURIComponent(query)}`;
  const search = await fetcher.get(searchUrl);
  if (!search.ok) {
    report.failures.push({ url: searchUrl, reason: search.reason, status: search.status });
    report.status = search.reason === "blocked" ? "blocked" : "no-results";
    report.detail =
      search.reason === "robots-disallowed"
        ? "robots.txt arama sayfasina izin vermiyor; kesif yapilmadi."
        : `Arama sayfasi alinamadi (${search.reason}${search.status ? ` ${search.status}` : ""}).`;
    return finish();
  }

  const links = extractProductLinks(search.body, searchUrl, opts.maxProducts * 3);
  report.candidateLinks = links.length;

  for (const link of links) {
    if (report.products.length >= opts.maxProducts) break;
    const page = await fetcher.get(link);
    if (!page.ok) {
      report.failures.push({ url: link, reason: page.reason, status: page.status });
      if (page.reason === "blocked" || page.reason === "budget-exhausted") break;
      continue;
    }
    const product = extractProductFromHtml(page.body, link, page.fetchedAt);
    if (product && matchesQuery(product.title, query)) report.products.push(product);
  }

  if (fetcher.blockedBy) {
    report.status = "blocked";
    report.detail = `HTTP ${fetcher.blockedBy.status} engeli goruldu; durduruldu (${report.products.length} urun).`;
  } else if (report.products.length > 0) {
    report.status = "ok";
    report.detail = `${report.products.length} urun sayfadan dogrulanarak cikarildi.`;
  } else {
    report.status = "no-results";
    report.detail = "Sorguyla eslesen, cikarilabilir urun bulunamadi.";
  }
  return finish();
}
