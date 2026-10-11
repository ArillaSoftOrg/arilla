/**
 * Internet sonuclarini katalogla kiyaslamak icin gereken salt okunur veri
 * (docs/decisions/0102): aktif magazalarin ana makineleri.
 */
import { type Database, merchant } from "@arilla/db";
import { eq, sql } from "drizzle-orm";
import { foldedTitleExpr, foldForMatch } from "../search/text-match.ts";
import type { CatalogImageCandidate } from "./merge.ts";
import type { WebProductGroup } from "./types.ts";

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

const CANDIDATES_PER_GROUP = 6;

/**
 * Internet urunlerinin KATALOGDAKI karsiliklarini bulur (karar 0107, gorsel kaynagi A):
 * kendi feed'imizden gelen, hakki dogrulanmis `primary_image_url`. Yalnizca aday getirir;
 * asil kimlik denetimi (marka/kelime, nesil ve siniflama, renk/kapasite) `attachCatalogImages`
 * icindedir. Salt okunur, ek model cagrisi yok; hata gorselin yoklugudur.
 */
export async function findCatalogImageCandidates(
  db: Database,
  groups: readonly Pick<WebProductGroup, "title" | "brand">[],
): Promise<CatalogImageCandidate[]> {
  const found = new Map<string, CatalogImageCandidate>();
  await Promise.all(
    groups.map(async (group) => {
      const folded = foldForMatch(`${group.brand ?? ""} ${group.title}`)
        .replace(/\s+/g, " ")
        .trim();
      if (folded.length < 4) return;
      try {
        const result = await db.execute(sql`
          SELECT p.title AS title, p.color AS color, b.name AS brand, p.primary_image_url AS image
            FROM product p
            LEFT JOIN brand b ON b.id = p.brand_id
           WHERE p.primary_image_url IS NOT NULL
             AND p.offer_count > 0
             AND ${foldedTitleExpr(sql`p.title`)} % ${folded}::text
           ORDER BY similarity(${foldedTitleExpr(sql`p.title`)}, ${folded}::text) DESC
           LIMIT ${CANDIDATES_PER_GROUP}
        `);
        for (const row of result.rows as {
          title: string;
          color: string | null;
          brand: string | null;
          image: string;
        }[]) {
          const folded = foldForMatch(row.title);
          const parts = [
            row.brand && !folded.includes(foldForMatch(row.brand)) ? row.brand : "",
            row.title,
          ];
          if (row.color && !folded.includes(foldForMatch(row.color))) parts.push(row.color);
          found.set(row.image, { title: parts.filter(Boolean).join(" "), imageUrl: row.image });
        }
      } catch {
        // Katalog gorseli yok sayilir; internet sonuclari etkilenmez.
      }
    }),
  );
  return [...found.values()];
}
