import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminActor } from "../admin/capabilities.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  approveRunDownload,
  planDiscoveryUnits,
  reserveRequests,
  submitDiscoveryBatch,
} from "./discovery-service.ts";
import { closeCollectionRun, getCollectionStatus, startCollectionRun } from "./service.ts";

/**
 * Hacim kotasi (karar 0124, migration 0075): atomik istek rezervasyonu, gunluk/aylik tavan,
 * aylik urun tavani, tukenmis kotada yeni kosu ve defter yetkisi. Gercek Postgres gerekir;
 * kaynaga HICBIR HTTP istegi atilmaz.
 */
const U1 = "sitemaps/product/sitemap_1.xml";
const item = (code: string) => ({
  externalId: code,
  codeKind: "pm",
  url: `https://www.hepsiburada.com/urun-${code.toLowerCase()}-pm-${code}`,
  title: `Urun ${code}`,
  imageUrl: `https://productimages.hepsiburada.net/s/777/1/${code}.jpg`,
  sourceUnitKey: U1,
});

describe("hacim kotasi - entegrasyon (gercek Postgres)", () => {
  let db: Database;
  let admin: AdminActor;
  const suffix = Date.now();

  async function reset(
    limits: { daily?: number | null; monthly?: number | null; products?: number | null } = {},
  ) {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM catalog_discovery");
      await c.query("DELETE FROM collection_unit");
      await c.query("DELETE FROM collection_run");
      await c.query("DELETE FROM collection_usage_day");
      await c.query(
        `UPDATE collection_source SET enabled = TRUE, daily_max_requests = $1,
           monthly_max_requests = $2, monthly_max_products = $3 WHERE source = 'hepsiburada'`,
        [limits.daily ?? 20000, limits.monthly ?? 60000, limits.products ?? 5000000],
      );
    });
  }

  async function openRun(): Promise<number> {
    const run = await startCollectionRun(db, admin, { source: "hepsiburada" });
    await planDiscoveryUnits(db, admin, { runId: run.id, kind: "sitemap_file", keys: [U1] });
    await approveRunDownload(db, admin, {
      runId: run.id,
      bytes: 1_000_000,
      transferOrigin: "admin_wifi",
    });
    return run.id;
  }

  const usage = () =>
    withOwnerClient(
      async (c) =>
        (
          await c.query(
            "SELECT COALESCE(sum(requests),0)::int AS requests, COALESCE(sum(products),0)::int AS products FROM collection_usage_day",
          )
        ).rows[0],
    );

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (c) => {
      const r = await c.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [`quota-${suffix}@test.local`],
      );
      admin = { userId: Number(r.rows[0].id), role: "admin" };
    });
    await reset();
  });

  afterAll(async () => {
    await reset();
    await withOwnerClient(async (c) => {
      await c.query("UPDATE collection_source SET enabled = FALSE WHERE source = 'hepsiburada'");
      await c.query("DELETE FROM admin_audit_event WHERE target_type = 'collection_run'");
      await c.query("DELETE FROM app_user WHERE email = $1", [`quota-${suffix}@test.local`]);
    });
  });

  it("rezervasyon defteri ve kosu sayaclarini ayni islemde artirir", async () => {
    const id = await openRun();
    const r = await reserveRequests(db, admin, { runId: id, count: 3 });
    expect(r).toMatchObject({ reserved: 3, requestsReserved: 3 });
    expect((await usage()).requests).toBe(3);
    const st = await getCollectionStatus(db, admin, "hepsiburada");
    expect(st.openRun?.requestsReserved).toBe(3);
    expect(st.openRun?.requestsMade).toBe(0);
    expect(st.quota.remaining.requestsToday).toBe(20000 - 3);
  });

  it("gunluk tavan asilamaz; 20.001. istek reddedilir ve defter degismez", async () => {
    await reset({ daily: 5 });
    const id = await openRun();
    await reserveRequests(db, admin, { runId: id, count: 5 });
    await expect(reserveRequests(db, admin, { runId: id, count: 1 })).rejects.toMatchObject({
      code: "collection_quota_daily_requests",
    });
    expect((await usage()).requests).toBe(5);
  });

  it("eszamanli rezervasyonlar toplam tavani asamaz", async () => {
    await reset({ daily: 10 });
    const id = await openRun();
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => reserveRequests(db, admin, { runId: id, count: 1 })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect((await usage()).requests).toBe(10);
  });

  // Ayin 1'inde "onceki gun" ayni aya dusmez; o gun bu senaryo kurulamaz.
  it.skipIf(new Date().getUTCDate() === 1)(
    "aylik istek tavani gunluk hak kalsa bile gecerlidir",
    async () => {
      await reset({ daily: 4, monthly: 4 });
      // Ayin onceki gunlerinde 3 istek harcanmis (bugun hak: 4, ay hak: 1).
      await withOwnerClient(async (c) => {
        await c.query(
          `INSERT INTO collection_usage_day (source, usage_date, requests)
         VALUES ('hepsiburada', date_trunc('month', now() AT TIME ZONE 'UTC')::date, 3)`,
        );
      });
      const id = await openRun();
      await reserveRequests(db, admin, { runId: id, count: 1 });
      await expect(reserveRequests(db, admin, { runId: id, count: 1 })).rejects.toMatchObject({
        code: "collection_quota_monthly_requests",
      });
      const st = await getCollectionStatus(db, admin, "hepsiburada");
      expect(st.quota.blockedBy).toBe("open_run");
      expect(st.quota.canResume).toBe(false); // kota bitti, devam da yok
    },
  );

  it("istek rezerve edildikten sonra parti yazimi basarisiz olsa da rezervasyon kalir", async () => {
    await reset();
    const id = await openRun();
    await reserveRequests(db, admin, { runId: id, count: 1 });
    await expect(
      submitDiscoveryBatch(
        db,
        admin,
        {
          runId: id,
          kind: "sitemap_file",
          unitKey: U1,
          status: "done",
          bytesReceived: 10,
          requestsMade: 1,
          fetchedAt: new Date().toISOString(),
          items: [item("HBC0000Q0001")],
        },
        new Date(),
        { maxDatabaseBytes: 1 },
      ),
    ).rejects.toMatchObject({ code: "database_size_limit" });
    expect((await usage()).requests).toBe(1); // geri alinmadi
  });

  it("rezervasyon olmadan tamamlanan istek bildirilemez", async () => {
    await reset();
    const id = await openRun();
    await expect(
      submitDiscoveryBatch(db, admin, {
        runId: id,
        kind: "sitemap_file",
        unitKey: U1,
        status: "done",
        bytesReceived: 10,
        requestsMade: 1,
        fetchedAt: new Date().toISOString(),
        items: [],
      }),
    ).rejects.toMatchObject({ code: "request_not_reserved" });
  });

  it("aylik urun tavani: sigmayan parti reddedilir ve hicbir sey yazilmaz", async () => {
    await reset({ products: 2 });
    const id = await openRun();
    await reserveRequests(db, admin, { runId: id, count: 1 });
    const send = (items: ReturnType<typeof item>[]) =>
      submitDiscoveryBatch(db, admin, {
        runId: id,
        kind: "sitemap_file",
        unitKey: U1,
        status: "done",
        bytesReceived: 10,
        requestsMade: 1,
        fetchedAt: new Date().toISOString(),
        items,
      });
    await expect(
      send([item("HBC0000Q0010"), item("HBC0000Q0011"), item("HBC0000Q0012")]),
    ).rejects.toMatchObject({ code: "collection_quota_monthly_products" });
    const none = await withOwnerClient(async (c) =>
      Number((await c.query("SELECT count(*) FROM catalog_discovery")).rows[0].count),
    );
    expect(none).toBe(0);
    await send([item("HBC0000Q0010"), item("HBC0000Q0011")]);
    expect((await usage()).products).toBe(2);
    const st = await getCollectionStatus(db, admin, "hepsiburada");
    expect(st.quota.remaining.productsMonth).toBe(0);
  });

  it("kota tukenmisse yeni kosu acilmaz; rezervasyonlu kosu 'released' olmaz", async () => {
    await reset({ daily: 1 });
    const id = await openRun();
    await reserveRequests(db, admin, { runId: id, count: 1 });
    await closeCollectionRun(db, admin, { runId: id, outcome: "aborted" });
    const status = await withOwnerClient(
      async (c) => (await c.query("SELECT status FROM collection_run WHERE id=$1", [id])).rows[0],
    );
    expect(status.status).toBe("aborted");
    await expect(startCollectionRun(db, admin, { source: "hepsiburada" })).rejects.toMatchObject({
      code: "collection_quota_daily_requests",
    });
    const st = await getCollectionStatus(db, admin, "hepsiburada");
    expect(st.quota).toMatchObject({ canStart: false, blockedBy: "daily_requests" });
  });

  it("uygulama rolu defteri dogrudan yazamaz/silemez; tetikleyici yazar", async () => {
    await reset();
    await expect(
      db.execute(
        sql`INSERT INTO collection_usage_day (source, usage_date, requests) VALUES ('hepsiburada', now()::date, 1)`,
      ),
    ).rejects.toBeTruthy();
    await expect(
      db.execute(sql`UPDATE collection_usage_day SET requests = 0`),
    ).rejects.toBeTruthy();
    await expect(db.execute(sql`DELETE FROM collection_usage_day`)).rejects.toBeTruthy();
  });

  it("rezervasyon azalamaz ve kapali kosuda degismez", async () => {
    await reset();
    const id = await openRun();
    await reserveRequests(db, admin, { runId: id, count: 2 });
    await expect(
      db.execute(sql`UPDATE collection_run SET requests_reserved = 1 WHERE id = ${id}`),
    ).rejects.toBeTruthy();
    await closeCollectionRun(db, admin, { runId: id, outcome: "completed" });
    await expect(
      db.execute(sql`UPDATE collection_run SET requests_reserved = 3 WHERE id = ${id}`),
    ).rejects.toBeTruthy();
  });
});
