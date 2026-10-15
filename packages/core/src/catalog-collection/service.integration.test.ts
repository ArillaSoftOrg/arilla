import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdminActor, AdminForbiddenError } from "../admin/capabilities.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  CollectionError,
  closeCollectionRun,
  coverageReport,
  getCollectionStatus,
  startCollectionRun,
  submitCollectionBatch,
} from "./service.ts";

const rec = (id: string, over: Record<string, unknown> = {}) => ({
  externalId: id,
  title: `Test ${id}`,
  url: `https://www.hepsiburada.com/test-p-${id}`,
  priceMinor: 10000,
  currency: "TRY",
  sourceObservedAt: new Date().toISOString(),
  ...over,
});

describe("katalog toplama servisi - entegrasyon (gercek Postgres)", () => {
  let db: Database;
  let admin: AdminActor;
  let moderator: AdminActor;
  let other: AdminActor;
  const suffix = Date.now();

  async function reset() {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM catalog_intake_record");
      await c.query("DELETE FROM collection_unit");
      await c.query("DELETE FROM collection_run");
      await c.query("DELETE FROM collection_usage_day");
      await c.query("UPDATE collection_source SET enabled = TRUE WHERE source = 'hepsiburada'");
    });
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (c) => {
      const ids: number[] = [];
      for (const role of ["admin", "moderator", "admin"]) {
        const r = await c.query("INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id", [
          `collect-${role}-${ids.length}-${suffix}@test.local`,
          role,
        ]);
        ids.push(Number(r.rows[0].id));
      }
      admin = { userId: ids[0] as number, role: "admin" };
      moderator = { userId: ids[1] as number, role: "moderator" };
      other = { userId: ids[2] as number, role: "admin" };
    });
    await reset();
  });

  afterAll(async () => {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM catalog_intake_record");
      await c.query("DELETE FROM collection_unit");
      await c.query("DELETE FROM collection_run");
      await c.query("UPDATE collection_source SET enabled = FALSE WHERE source = 'hepsiburada'");
      await c.query("DELETE FROM admin_audit_event WHERE target_type = 'collection_run'");
      await c.query("DELETE FROM app_user WHERE email LIKE $1", [`collect-%-${suffix}@test.local`]);
    });
  });

  it("moderator katalog toplayamaz", async () => {
    await expect(getCollectionStatus(db, moderator, "hepsiburada")).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
    await expect(
      startCollectionRun(db, moderator, { source: "hepsiburada" }),
    ).rejects.toBeInstanceOf(AdminForbiddenError);
  });

  it("bilinmeyen kaynak reddedilir", async () => {
    await expect(startCollectionRun(db, admin, { source: "trendyol" })).rejects.toMatchObject({
      code: "unknown_source",
    });
  });

  it("kosu -> parti (dogrulama, tekrar, kapsam) -> kapanis; ikinci kosu kota ile reddedilir", async () => {
    const status = await getCollectionStatus(db, admin, "hepsiburada");
    expect(status.quota.canStart).toBe(true);

    const run = await startCollectionRun(db, admin, { source: "hepsiburada" });
    expect(run.maxRequests).toBe(20000);
    expect(run.expiresAt.getTime() - run.reservedAt.getTime()).toBe(6 * 86_400_000);

    // Aralik kisiti kalkti; ama kaynak basina tek ACIK kosu kurali sürer.
    await expect(startCollectionRun(db, admin, { source: "hepsiburada" })).rejects.toMatchObject({
      code: "collection_run_already_open",
    });

    const unit = (page: number, found: number, fresh: number) => ({
      query: "test telefon",
      page,
      status: "done" as const,
      itemsFound: found,
      itemsNew: fresh,
      fetchedAt: new Date().toISOString(),
    });
    const first = await submitCollectionBatch(db, admin, {
      runId: run.id,
      records: [rec("A1"), rec("A2"), rec("A1"), rec("B1", { currency: "USD" }), "bozuk"],
      units: [unit(1, 4, 4)],
      requestsMade: 1,
      checkpoint: { queries: ["test telefon"], done: { "test telefon": 1 } },
    });
    expect(first).toMatchObject({ inserted: 2, duplicates: 1, rejected: 2 });
    expect(first.rejectedByCode).toEqual({ currency: 1, not_object: 1 });

    // Sonraki parti: A2 zaten var (kosu icinde tekrar), A3 yeni; sayfa 2 yeni urun getirdi.
    const second = await submitCollectionBatch(db, admin, {
      runId: run.id,
      records: [rec("A2"), rec("A3")],
      units: [unit(2, 2, 1)],
      requestsMade: 2,
    });
    expect(second).toMatchObject({ inserted: 1, duplicates: 1, rejected: 0 });

    // Baska yonetici bu kosuya yazamaz; istek sayaci geri gidemez; butce asilamaz.
    await expect(
      submitCollectionBatch(db, other, { runId: run.id, records: [], units: [], requestsMade: 3 }),
    ).rejects.toMatchObject({ code: "run_owned_by_other" });
    await expect(
      submitCollectionBatch(db, admin, { runId: run.id, records: [], units: [], requestsMade: 1 }),
    ).rejects.toMatchObject({ code: "bad_requests" });
    await expect(
      submitCollectionBatch(db, admin, {
        runId: run.id,
        records: [],
        units: [],
        requestsMade: 20001,
      }),
    ).rejects.toMatchObject({ code: "request_budget_exceeded" });

    // Tarayici checkpoint'i sunucuda durur (yarim kalani surdurme).
    const resumed = (await getCollectionStatus(db, admin, "hepsiburada")).openRun;
    expect(resumed?.requestsMade).toBe(2);
    expect(resumed?.checkpoint).toEqual({ queries: ["test telefon"], done: { "test telefon": 1 } });

    const report = await closeCollectionRun(db, admin, { runId: run.id, outcome: "completed" });
    expect(report).toMatchObject({
      uniqueRecords: 3,
      pendingMerge: 3,
      queries: 1,
      pagesFetched: 2,
      itemsSeen: 6,
      // Son sayfa hala yeni urun getiriyordu: sayfa tavaninda kesilmis olabilir.
      queriesCappedByPageLimit: 1,
    });

    await expect(
      submitCollectionBatch(db, admin, { runId: run.id, records: [], units: [], requestsMade: 2 }),
    ).rejects.toMatchObject({ code: "collection_run_not_open" });
    await expect(startCollectionRun(db, admin, { source: "hepsiburada" })).rejects.toBeInstanceOf(
      CollectionError,
    );
    const after = await getCollectionStatus(db, admin, "hepsiburada");
    // Koşu aralığı/ay sınırı kalktı: kapanan koşudan hemen sonra yenisi başlatılabilir.
    expect(after.quota.canStart).toBe(true);
    expect(after.quota.blockedBy).toBeNull();
    expect(after.quota.usage.day.requests).toBe(2);

    const audit = await withOwnerClient(async (c) =>
      (
        await c.query(
          "SELECT action FROM admin_audit_event WHERE target_type = 'collection_run' ORDER BY id",
        )
      ).rows.map((r) => r.action),
    );
    expect(audit).toEqual(["catalog_collection.start", "catalog_collection.close"]);
    expect((await coverageReport(db, admin, run.id)).uniqueRecords).toBe(3);
  });

  it("hic istek atilmadan kapatilan kosu kotadan dusulur", async () => {
    await reset();
    const run = await startCollectionRun(db, admin, { source: "hepsiburada" });
    await closeCollectionRun(db, admin, { runId: run.id, outcome: "aborted" });
    const again = await startCollectionRun(db, admin, { source: "hepsiburada" });
    expect(again.id).toBeGreaterThan(run.id);
  });
});
