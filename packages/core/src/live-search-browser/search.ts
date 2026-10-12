/**
 * Tarayicida calisir: magazanin herkese acik arama sayfasini CEREZSIZ ister.
 * Tarayici yaniti yalnizca magaza CORS ile izin verirse okutur; izin yoksa
 * sonuc yoktur (vekil sunucu, kimlik taklidi, engel asma yok).
 */

import { matchesQuery } from "./match.ts";
import type { LiveProduct, LiveStore } from "./types.ts";

export type LiveSearchOutcome =
  | {
      store: string;
      ok: true;
      totalOnPage: number;
      products: LiveProduct[];
      ms: number;
      /** Kategori kaniti (bkz. pazarama-discovery/seo-index.ts `buildEvidence`). */
      pageCategoryNames: string[];
    }
  | {
      store: string;
      ok: false;
      reason: "cors-or-network" | "http-error" | "timeout";
      status?: number;
    };

export interface LiveSearchOptions {
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function searchLiveStore(
  store: LiveStore,
  query: string,
  opts: LiveSearchOptions = {},
): Promise<LiveSearchOutcome> {
  const { limit = 5, timeoutMs = 8_000, fetchImpl = fetch, now = () => new Date() } = opts;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(store.searchUrl(query), {
      mode: "cors",
      credentials: "omit",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { store: store.id, ok: false, reason: timeout ? "timeout" : "cors-or-network" };
  }
  if (!res.ok) return { store: store.id, ok: false, reason: "http-error", status: res.status };
  const html = await res.text();
  const all = store.extract(html, now().toISOString());
  const matched = all.filter((p) => matchesQuery(p.title, query));
  return {
    store: store.id,
    ok: true,
    totalOnPage: all.length,
    products: matched.slice(0, limit),
    ms: Date.now() - started,
    // Yalnizca ESLESEN urunlerin kategorileri (canli: iPhone sorgusunda eslesmeyen CS
    // urunlerinin "Akilli Saat" kategorisi yanlis sayfa sectirdi) + magazanin kendi faseti.
    pageCategoryNames: [
      ...topCategoryNames(matched),
      ...(store.extractCategoryFacet?.(html) ?? []),
    ],
  };
}

/**
 * Kategori kaniti: eslesen urunlerde en sik gecen kategori adlari. Her urunun yalnizca
 * en derin iki seviyesi sayilir ("Spor ve Outdoor" gibi ust adlar gurultudur).
 */
export function topCategoryNames(products: readonly LiveProduct[], limit = 6): string[] {
  const count = new Map<string, number>();
  for (const p of products)
    for (const n of (p.categoryNames ?? []).slice(-2)) count.set(n, (count.get(n) ?? 0) + 1);
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([n]) => n);
}
