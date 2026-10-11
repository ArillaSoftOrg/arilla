import {
  emptyWebOutcome,
  isWebSearchEnabled,
  loadCatalogHosts,
  searchWeb,
  type WebQuerySource,
  type WebSearchOutcome,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { clientIp } from "../lib/client-ip.ts";
import { verifySession } from "../lib/dal.ts";

export interface WebSearchBundle {
  outcome: WebSearchOutcome;
  /** Aktif katalog magazalarinin ana makineleri (yinelenen teklifi atmak icin). */
  catalogHosts: ReadonlySet<string>;
}

/**
 * Internet aramasini veritabani aramasiyla PARALEL baslatir (karar 0102):
 * sayfa promise'i beklemeden render eder, sonuc `<Suspense>` icinde akar.
 * Bayrak kapaliysa `null` doner ve hicbir sey calismaz (sistem davranisi
 * degismez). Asla reddetmez: her hata bir `error` sonucudur.
 */
export function startWebSearch(source: WebQuerySource): Promise<WebSearchBundle> | null {
  if (!isWebSearchEnabled()) return null;
  return (async (): Promise<WebSearchBundle> => {
    try {
      const user = await verifySession();
      const ip = clientIp(await headers());
      const db = getDatabase();
      const [outcome, catalogHosts] = await Promise.all([
        searchWeb(db, source, { userId: user?.id ?? null, ip }),
        loadCatalogHosts(db).catch(() => new Set<string>()),
      ]);
      return { outcome, catalogHosts };
    } catch (error) {
      console.error("[ara] web search failed", error instanceof Error ? error.name : "unknown");
      return { outcome: emptyWebOutcome("error"), catalogHosts: new Set() };
    }
  })();
}
