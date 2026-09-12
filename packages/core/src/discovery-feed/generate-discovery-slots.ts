/**
 * `discovery_slot` günlük üretimi (docs/backlog.md E4, docs/schema.sql
 * yorumu: "Tarihe göre deterministik üretilir, böylece sayfa
 * önbelleklenebilir ve aynı gün herkes aynısını görür. Organik keşifler
 * önce yerleştirilir, kalan boşluklar curated havuzdan dolar").
 *
 * Organik taraf bugün hep boş - `public_find.source='organic'` üreten
 * toplu iş henüz yazılmadı (bkz. packages/core/src/account/history.ts'teki
 * benzer not: rıza/eşik altyapısı ayrı bir görev). Bu fonksiyon o günü
 * bekletmez; boşsa tamamı curated'tan dolar.
 */

import { type Database, discoverySlot, product, publicFind } from "@arilla/db";
import { and, desc, eq, gt } from "drizzle-orm";

const SLOTS_PER_DAY = 20;

export interface GenerateDiscoverySlotsResult {
  /** false: o tarih icin slot zaten vardi, tekrar uretilmedi (idempotent). */
  generated: boolean;
  slotCount: number;
}

/** UTC gün sayısı - `slotDate` bazlı deterministik rotasyon ofseti için. */
function dayNumber(slotDate: string): number {
  return Math.floor(new Date(`${slotDate}T00:00:00Z`).getTime() / 86_400_000);
}

export function todaySlotDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function generateDiscoverySlots(
  db: Database,
  slotDate: string,
): Promise<GenerateDiscoverySlotsResult> {
  const existing = await db
    .select({ position: discoverySlot.position })
    .from(discoverySlot)
    .where(eq(discoverySlot.slotDate, slotDate))
    .limit(1);
  if (existing[0]) {
    return { generated: false, slotCount: 0 };
  }

  const organicRows = await db
    .select({ productId: publicFind.productId })
    .from(publicFind)
    .where(eq(publicFind.source, "organic"))
    .orderBy(desc(publicFind.rankScore))
    .limit(SLOTS_PER_DAY);

  const usedProductIds = new Set(organicRows.map((row) => row.productId));

  const remainingSlots = SLOTS_PER_DAY - organicRows.length;
  const picked: number[] = [];
  if (remainingSlots > 0) {
    const curatedPool = await db
      .select({ productId: publicFind.productId })
      .from(publicFind)
      .innerJoin(product, eq(product.id, publicFind.productId))
      .where(and(eq(publicFind.source, "curated"), gt(product.inStockCount, 0)))
      .orderBy(publicFind.productId);

    const pool = curatedPool.filter((row) => !usedProductIds.has(row.productId));
    if (pool.length > 0) {
      const count = Math.min(remainingSlots, pool.length);
      // Gunluk adim `remainingSlots` kadar - havuz 20'den buyukse ardisik
      // gunler CAKISMAYAN bloklar gorur (havuz bitince bastan sarar). Adim
      // 1 olsaydi (basit kaydirma) gunler arasi fark yalnizca 1 urun olurdu
      // - "izgara her gun degisiyor" kriterini pratikte karsilamazdi.
      const offset = (dayNumber(slotDate) * remainingSlots) % pool.length;
      for (let i = 0; i < count; i++) {
        const item = pool[(offset + i) % pool.length];
        if (item) picked.push(item.productId);
      }
    }
  }

  const rows = [
    ...organicRows.map((row, i) => ({
      slotDate,
      position: i + 1,
      productId: row.productId,
      source: "organic" as const,
    })),
    ...picked.map((productId, i) => ({
      slotDate,
      position: organicRows.length + i + 1,
      productId,
      source: "curated" as const,
    })),
  ];

  if (rows.length === 0) {
    return { generated: false, slotCount: 0 };
  }

  await db.insert(discoverySlot).values(rows);
  return { generated: true, slotCount: rows.length };
}
