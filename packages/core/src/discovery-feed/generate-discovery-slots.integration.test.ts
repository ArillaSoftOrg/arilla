import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { generateDiscoverySlots } from "./generate-discovery-slots.ts";
import { getDiscoverySlots } from "./get-discovery-slots.ts";

describe("generateDiscoverySlots() / getDiscoverySlots() - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  const slotDate = "2101-01-01"; // gercek veriyle hic cakismayacak uzak bir tarih
  let curatedInStockId = 0;
  let curatedOutOfStockId = 0;
  let organicId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const makeProduct = async (title: string, inStockCount: number) => {
        const result = await client.query(
          "INSERT INTO product (slug, title, in_stock_count) VALUES ($1, $2, $3) RETURNING id",
          [`e4-slots-${title}-${suffix}`, title, inStockCount],
        );
        return Number(result.rows[0].id);
      };
      curatedInStockId = await makeProduct("curated-stokta", 5);
      curatedOutOfStockId = await makeProduct("curated-stoksuz", 0);
      organicId = await makeProduct("organik", 5);

      await client.query("INSERT INTO public_find (product_id, source) VALUES ($1, 'curated')", [
        curatedInStockId,
      ]);
      await client.query("INSERT INTO public_find (product_id, source) VALUES ($1, 'curated')", [
        curatedOutOfStockId,
      ]);
      await client.query(
        "INSERT INTO public_find (product_id, source, distinct_finder_count, found_label, rank_score) VALUES ($1, 'organic', 5, 'bu hafta', 999)",
        [organicId],
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM discovery_slot WHERE slot_date = $1", [slotDate]);
      await client.query("DELETE FROM public_find WHERE product_id = ANY($1)", [
        [curatedInStockId, curatedOutOfStockId, organicId],
      ]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [
        [curatedInStockId, curatedOutOfStockId, organicId],
      ]);
    });
  });

  it("organik once, sonra stokta olan curated - stoksuz curated hic girmez", async () => {
    const result = await generateDiscoverySlots(db, slotDate);
    expect(result.generated).toBe(true);
    expect(result.slotCount).toBeGreaterThan(0);

    const items = await getDiscoverySlots(db, slotDate);
    expect(items[0]?.productId).toBe(organicId);
    expect(items[0]?.source).toBe("organic");
    expect(items[0]?.foundLabel).toBe("bu hafta");

    const productIds = items.map((item) => item.productId);
    expect(productIds).toContain(curatedInStockId);
    expect(productIds).not.toContain(curatedOutOfStockId);
  });

  it("ayni tarih icin ikinci cagri idempotent - tekrar uretmez", async () => {
    const second = await generateDiscoverySlots(db, slotDate);
    expect(second.generated).toBe(false);
  });
});

describe("generateDiscoverySlots() - havuz 20'den buyukse gunler arasi rotasyon", () => {
  let db: Database;
  const suffix = Date.now();
  const dateA = "2102-03-01";
  const dateB = "2102-03-02";
  const dateC = "2102-03-03";
  const poolProductIds: number[] = [];

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      for (let i = 0; i < 45; i++) {
        const result = await client.query(
          "INSERT INTO product (slug, title, in_stock_count) VALUES ($1, $2, 5) RETURNING id",
          [`e4-rotation-${i}-${suffix}`, `Rotasyon Urunu ${i}`],
        );
        const productId = Number(result.rows[0].id);
        poolProductIds.push(productId);
        await client.query("INSERT INTO public_find (product_id, source) VALUES ($1, 'curated')", [
          productId,
        ]);
      }
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM discovery_slot WHERE slot_date = ANY($1)", [
        [dateA, dateB, dateC],
      ]);
      await client.query("DELETE FROM public_find WHERE product_id = ANY($1)", [poolProductIds]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [poolProductIds]);
    });
  });

  it("ardisik gunler buyuk olcude farkli urun setleri gosterir (basit 1-adim kaydirma degil)", async () => {
    await generateDiscoverySlots(db, dateA);
    await generateDiscoverySlots(db, dateB);
    await generateDiscoverySlots(db, dateC);

    const itemsA = await getDiscoverySlots(db, dateA);
    const itemsB = await getDiscoverySlots(db, dateB);
    const itemsC = await getDiscoverySlots(db, dateC);

    const setA = new Set(itemsA.map((item) => item.productId));
    const setB = new Set(itemsB.map((item) => item.productId));
    const setC = new Set(itemsC.map((item) => item.productId));

    const overlapAB = [...setA].filter((id) => setB.has(id)).length;
    const overlapAC = [...setA].filter((id) => setC.has(id)).length;

    // Havuz 45, gunluk 20 - ardisik gunler CAKISMAMALI (1-adim kaydirma
    // olsaydi %95 cakisirdi). Ucuncu gun havuz sarip biraz cakisabilir.
    expect(overlapAB).toBe(0);
    expect(overlapAC).toBeLessThan(20);
  });
});
