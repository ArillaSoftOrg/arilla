import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminActor } from "../admin/capabilities.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  approveRunDownload,
  discoveryProgress,
  nextDiscoveryUnits,
  planDiscoveryUnits,
  reserveRequests,
  submitDiscoveryBatch,
} from "./discovery-service.ts";
import { closeCollectionRun, startCollectionRun } from "./service.ts";

const item = (code: string, unit: string, over: Record<string, unknown> = {}) => ({
  externalId: code,
  codeKind: "pm",
  url: `https://www.hepsiburada.com/urun-${code.toLowerCase()}-pm-${code}`,
  title: `Urun ${code}`,
  imageUrl: `https://productimages.hepsiburada.net/s/777/1/${code}.jpg`,
  sourceUnitKey: unit,
  ...over,
});

/**
 * Karar 0124: tamamlanan istek once rezerve edilmis olmali. Eski testler yalniz `requestsMade`
 * verdigi icin eksik rezervasyonu burada tamamlariz (gercek servisle); butce asimi ayni kodla doner.
 */
async function submit(
  db: Database,
  actor: AdminActor,
  input: Parameters<typeof submitDiscoveryBatch>[2],
  ...rest: unknown[]
) {
  const have = await withOwnerClient(async (c) =>
    Number(
      (await c.query("SELECT requests_reserved FROM collection_run WHERE id = $1", [input.runId]))
        .rows[0]?.requests_reserved ?? 0,
    ),
  );
  if (input.requestsMade > have) {
    await reserveRequests(db, actor, { runId: input.runId, count: input.requestsMade - have });
  }
  return (submitDiscoveryBatch as (...a: unknown[]) => ReturnType<typeof submitDiscoveryBatch>)(
    db,
    actor,
    input,
    ...rest,
  );
}

describe("kesif defteri - entegrasyon (gercek Postgres)", () => {
  let db: Database;
  let admin: AdminActor;
  const suffix = Date.now();
  const U1 = "sitemaps/product/sitemap_1.xml";
  const U2 = "sitemaps/product/sitemap_2.xml";
  let t0 = Date.now();
  const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();

  async function reset(enabled = true) {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM catalog_discovery");
      await c.query("DELETE FROM catalog_intake_record");
      await c.query("DELETE FROM collection_unit");
      await c.query("DELETE FROM collection_run");
      await c.query("DELETE FROM collection_usage_day");
      await c.query("UPDATE collection_source SET enabled = $1 WHERE source = 'hepsiburada'", [
        enabled,
      ]);
    });
    t0 = Date.now();
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (c) => {
      const r = await c.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [`disc-${suffix}@test.local`],
      );
      admin = { userId: Number(r.rows[0].id), role: "admin" };
    });
    await reset();
  });

  afterAll(async () => {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM catalog_discovery");
      await c.query("DELETE FROM collection_unit");
      await c.query("DELETE FROM collection_run");
      await c.query("UPDATE collection_source SET enabled = FALSE WHERE source = 'hepsiburada'");
      await c.query("DELETE FROM admin_audit_event WHERE target_type = 'collection_run'");
      await c.query("DELETE FROM app_user WHERE email = $1", [`disc-${suffix}@test.local`]);
    });
  });

  it("onay olmadan bayt kabul edilmez; kosu bayt tavanini politikadan alir", async () => {
    const run = await startCollectionRun(db, admin, { source: "hepsiburada" });
    expect(run.kind).toBe("initial");
    await planDiscoveryUnits(db, admin, { runId: run.id, kind: "sitemap_file", keys: [U1, U2] });
    await expect(
      submit(db, admin, {
        runId: run.id,
        kind: "sitemap_file",
        unitKey: U1,
        status: "done",
        bytesReceived: 1000,
        requestsMade: 1,
        fetchedAt: at(0),
        items: [item("HBC0000A0001", U1)],
      }),
    ).rejects.toMatchObject({ code: "download_not_approved" });
    // Politika tavaninin ustu onaylanamaz.
    await expect(
      approveRunDownload(db, admin, { runId: run.id, bytes: 2 ** 40, transferOrigin: "vps" }),
    ).rejects.toMatchObject({ code: "download_exceeds_policy" });
  });

  it("mukerrer kayit olusmaz, son gorulme guncellenir, bos alan degeri silmez", async () => {
    // Onceki testteki kosu hala acik: onu kullan.
    const open = await withOwnerClient(async (c) =>
      Number((await c.query("SELECT id FROM collection_run WHERE status='open'")).rows[0].id),
    );
    await approveRunDownload(db, admin, {
      runId: open,
      bytes: 50_000_000,
      transferOrigin: "admin_wifi",
    });
    const r1 = await submit(db, admin, {
      runId: open,
      kind: "sitemap_file",
      unitKey: U1,
      status: "done",
      bytesReceived: 4000,
      requestsMade: 1,
      fetchedAt: at(0),
      items: [
        item("HBC0000A0001", U1),
        item("HBC0000A0001", U1), // ayni partide tekrar
        item("HBC0000A0002", U1),
        item("HBC0000BAD", U1, { url: "https://evil.example/x-pm-HBC0000BAD" }),
      ],
    });
    expect(r1).toMatchObject({ inserted: 2, seenAgain: 0, rejected: 1, bytesDownloaded: 4000 });
    // Ayni urunler baska dosyada yeniden gorulur; bos baslik eldeki basligi silmez.
    const r2 = await submit(db, admin, {
      runId: open,
      kind: "sitemap_file",
      unitKey: U2,
      status: "done",
      bytesReceived: 3000,
      requestsMade: 2,
      fetchedAt: at(10),
      items: [item("HBC0000A0001", U2, { title: "", imageUrl: null }), item("HBC0000A0003", U2)],
    });
    expect(r2).toMatchObject({ inserted: 1, seenAgain: 1 });
    const rows = await withOwnerClient(
      async (c) =>
        (
          await c.query(
            "SELECT external_id, title, image_url, source_unit_key, price_state, price_checked_at FROM catalog_discovery ORDER BY external_id",
          )
        ).rows,
    );
    expect(rows).toHaveLength(3);
    const a1 = rows.find((r) => r.external_id === "HBC0000A0001");
    expect(a1.title).toBe("Urun HBC0000A0001");
    expect(a1.image_url).toContain("HBC0000A0001");
    expect(a1.source_unit_key).toBe(U2);
    expect(a1.price_state).toBe("unpriced");
    expect(a1.price_checked_at).toBeNull();
    const p = await discoveryProgress(db, admin, { source: "hepsiburada", runId: open });
    expect(p.uniqueProducts).toBe(3);
    expect(p.byPriceState).toEqual({ unpriced: 3 });
    expect(p.unitsByStatus.done).toBe(2);
    expect(p.transferOrigin).toBe("admin_wifi");
  });

  it("veritabani boyut tavani asilirsa parti reddedilir ve hicbir sey yazilmaz", async () => {
    const open = await withOwnerClient(async (c) =>
      Number((await c.query("SELECT id FROM collection_run WHERE status='open'")).rows[0].id),
    );
    await expect(
      submitDiscoveryBatch(
        db,
        admin,
        {
          runId: open,
          kind: "sitemap_file",
          unitKey: U1,
          status: "done",
          bytesReceived: 1,
          requestsMade: 2,
          fetchedAt: at(10),
          items: [item("HBC0000Z9999", U1)],
        },
        undefined,
        { maxDatabaseBytes: 1 },
      ),
    ).rejects.toMatchObject({ code: "database_size_limit" });
    const n = await withOwnerClient(async (c) =>
      Number(
        (await c.query("SELECT count(*) FROM catalog_discovery WHERE external_id='HBC0000Z9999'"))
          .rows[0].count,
      ),
    );
    expect(n).toBe(0);
  });

  it("hiz siniri: 2 sn'den sik istek reddedilir", async () => {
    const open = await withOwnerClient(async (c) =>
      Number((await c.query("SELECT id FROM collection_run WHERE status='open'")).rows[0].id),
    );
    await planDiscoveryUnits(db, admin, {
      runId: open,
      kind: "sitemap_file",
      keys: ["sitemaps/product/sitemap_3.xml"],
    });
    await expect(
      submit(db, admin, {
        runId: open,
        kind: "sitemap_file",
        unitKey: "sitemaps/product/sitemap_3.xml",
        status: "done",
        bytesReceived: 10,
        requestsMade: 3,
        fetchedAt: at(10.5),
        items: [],
      }),
    ).rejects.toMatchObject({ code: "request_rate_exceeded" });
  });

  it("checkpoint: basarisiz birim sirada kalir, tamamlananlar tekrar istenmez", async () => {
    const open = await withOwnerClient(async (c) =>
      Number((await c.query("SELECT id FROM collection_run WHERE status='open'")).rows[0].id),
    );
    await submit(db, admin, {
      runId: open,
      kind: "sitemap_file",
      unitKey: "sitemaps/product/sitemap_3.xml",
      status: "failed",
      bytesReceived: 0,
      requestsMade: 3,
      fetchedAt: at(20),
      items: [],
      errorCode: "network_error",
      checkpoint: { lastUnit: 3 },
    });
    const next = await nextDiscoveryUnits(db, admin, { runId: open, limit: 5 });
    expect(next.map((u) => u.unitKey)).toEqual(["sitemaps/product/sitemap_3.xml"]);
    expect(next[0]?.attempts).toBe(1);
    const cp = await withOwnerClient(
      async (c) =>
        (await c.query("SELECT checkpoint FROM collection_run WHERE id=$1", [open])).rows[0],
    );
    expect(cp.checkpoint).toEqual({ lastUnit: 3 });
  });

  it("engel (blocked) sonrasi sogumada yeni birim kabul edilmez", async () => {
    const open = await withOwnerClient(async (c) =>
      Number((await c.query("SELECT id FROM collection_run WHERE status='open'")).rows[0].id),
    );
    await submit(db, admin, {
      runId: open,
      kind: "sitemap_file",
      unitKey: "sitemaps/product/sitemap_3.xml",
      status: "blocked",
      bytesReceived: 0,
      requestsMade: 4,
      fetchedAt: at(30),
      items: [],
      errorCode: "http_403",
    });
    await expect(
      submit(db, admin, {
        runId: open,
        kind: "sitemap_file",
        unitKey: U1,
        status: "done",
        bytesReceived: 1,
        requestsMade: 5,
        fetchedAt: at(60),
        items: [],
      }),
    ).rejects.toMatchObject({ code: "blocked_cooldown" });
  });

  it("kapanis: aralik/ay-kosu siniri kalkti, ikinci kosu hemen acilir; defter korunur", async () => {
    const open = await withOwnerClient(async (c) =>
      Number((await c.query("SELECT id FROM collection_run WHERE status='open'")).rows[0].id),
    );
    await closeCollectionRun(db, admin, { runId: open, outcome: "aborted" });
    const second = await startCollectionRun(db, admin, { source: "hepsiburada" });
    expect(second.kind).toBe("refresh");
    expect(second.requestsReserved).toBe(0);
    const n = await withOwnerClient(async (c) =>
      Number((await c.query("SELECT count(*) FROM catalog_discovery")).rows[0].count),
    );
    expect(n).toBe(3); // eksik tarama/kapanis hicbir kimligi silmez ya da pasiflestirmez
  });

  it("migration 0075 + 0078: yeni politika (20.000/gun, 60.000/ay, urun sinirsiz) ve aralik kalkti", async () => {
    const pol = await withOwnerClient(
      async (c) =>
        (
          await c.query(
            "SELECT initial_max_requests, refresh_max_requests, min_interval_days, max_runs_per_month, run_window_days, daily_max_requests, monthly_max_requests, monthly_max_products FROM collection_source WHERE source='hepsiburada'",
          )
        ).rows[0],
    );
    expect(pol).toEqual({
      initial_max_requests: 20000,
      refresh_max_requests: 20000,
      min_interval_days: 0,
      max_runs_per_month: null,
      run_window_days: 6,
      daily_max_requests: 20000,
      monthly_max_requests: 60000,
      monthly_max_products: null,
    });
    // arilla_app kesif defterinden silemez.
    await expect(db.execute(sql`DELETE FROM catalog_discovery`)).rejects.toBeTruthy();
  });
});
