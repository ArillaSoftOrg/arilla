/**
 * Internet sonuclarini katalogla kiyaslamak icin gereken salt okunur veri
 * (docs/decisions/0101): aktif magazalarin ana makineleri.
 */
import { type Database, merchant } from "@arilla/db";
import { eq } from "drizzle-orm";

export async function loadCatalogHosts(db: Database): Promise<Set<string>> {
  const rows = await db
    .select({ domain: merchant.domain })
    .from(merchant)
    .where(eq(merchant.isActive, true));
  const hosts = new Set<string>();
  for (const row of rows) {
    const host = row.domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./, "");
    if (host) hosts.add(host);
  }
  return hosts;
}
