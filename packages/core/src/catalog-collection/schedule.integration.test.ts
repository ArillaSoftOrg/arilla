import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminActor } from "../admin/capabilities.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getCollectionSchedule, startScheduledCollectionRun } from "./schedule.ts";
import { startCollectionRun } from "./service.ts";

/** Karar 0220: zamanlanmis haftalik yenileme kararini SUNUCU verir (gercek Postgres). */
describe("zamanlanmis yenileme - entegrasyon (gercek Postgres)", () => {
  let db: Database;
  let admin: AdminActor;
  const suffix = Date.now();
  const on = { flagEnabled: true };

  async function reset() {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM catalog_intake_record");
      await c.query("DELETE FROM collection_unit");
      await c.query("DELETE FROM collection_run");
      await c.query("DELETE FROM collection_usage_day");
      await c.query("UPDATE collection_source SET enabled = TRUE WHERE source = 'hepsiburada'");
    });
  }

  /** Elle kosu: acilir, sorgu listesi kontrol noktasina yazilir, kapanir. */
  async function closedManualRun(daysAgo: number): Promise<number> {
    const run = await startCollectionRun(db, admin, {
      source: "hepsiburada",
      options: { queries: 2, maxPages: 2 },
    });
    await withOwnerClient(async (c) => {
      await c.query(
        `UPDATE collection_run SET requests_made = 2, requests_reserved = 2,
                checkpoint = '{"queries": ["kulaklik", "telefon"], "done": {}, "finished": {}}'
          WHERE id = $1`,
        [run.id],
      );
      await c.query("UPDATE collection_run SET status = 'completed' WHERE id = $1", [run.id]);
      await c.query(
        "ALTER TABLE collection_run DISABLE TRIGGER collection_run_immutable_guard_trg",
      );
      await c.query(
        "UPDATE collection_run SET reserved_at = reserved_at - make_interval(days => $1) WHERE id = $2",
        [daysAgo, run.id],
      );
      await c.query("ALTER TABLE collection_run ENABLE TRIGGER collection_run_immutable_guard_trg");
    });
    return run.id;
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (c) => {
      const r = await c.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [`schedule-admin-${suffix}@test.local`],
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
      await c.query("DELETE FROM app_user WHERE email = $1", [
        `schedule-admin-${suffix}@test.local`,
      ]);
    });
  });

  it("bayrak kapali ya da hic kosu yokken zamanlanmis kosu acilmaz", async () => {
    await reset();
    const off = await getCollectionSchedule(db, admin, "hepsiburada", { flagEnabled: false });
    expect(off.blockedBy).toBe("flag_off");
    await expect(
      startScheduledCollectionRun(db, admin, "hepsiburada", { flagEnabled: false }),
    ).rejects.toMatchObject({ code: "schedule_not_due", detail: "flag_off" });
    const empty = await getCollectionSchedule(db, admin, "hepsiburada", on);
    expect(empty.blockedBy).toBe("no_template"); // ilk yukleme elle
  });

  it("kota politikadan: aralik 0 iken 2 gun once kosu olsa da acilir (gomulu 7 gun yok)", async () => {
    await reset();
    await closedManualRun(2);
    const state = await getCollectionSchedule(db, admin, "hepsiburada", on);
    // 0119: HB politikasi haftada 100, ayda 400 (kullanici beyani, 26 Kasim 2026).
    expect(state).toMatchObject({
      due: true,
      runsThisWeek: 1,
      maxRunsPerWeek: 100,
      runsThisMonth: 1,
      maxRunsPerMonth: 400,
      minIntervalDays: 0,
    });
  });

  it("haftalik tavan dolunca zamanlayici da tetikleyici de reddeder (collection_quota_week)", async () => {
    await reset();
    await withOwnerClient((c) =>
      c.query("UPDATE collection_source SET max_runs_per_week = 1 WHERE source = 'hepsiburada'"),
    );
    try {
      await closedManualRun(2);
      const state = await getCollectionSchedule(db, admin, "hepsiburada", on);
      expect(state).toMatchObject({ due: false, blockedBy: "week", runsThisWeek: 1 });
      await expect(startScheduledCollectionRun(db, admin, "hepsiburada", on)).rejects.toMatchObject(
        { code: "schedule_not_due", detail: "week" },
      );
      await expect(
        startCollectionRun(db, admin, { source: "hepsiburada", options: { queries: 1 } }),
      ).rejects.toMatchObject({ code: "collection_quota_week" });
    } finally {
      await withOwnerClient((c) =>
        c.query(
          "UPDATE collection_source SET max_runs_per_week = 100 WHERE source = 'hepsiburada'",
        ),
      );
    }
  });

  it("son kosunun sorgulariyla kosu acar; ikinci istek acik kosuda durur", async () => {
    await reset();
    const template = await closedManualRun(8);
    const state = await getCollectionSchedule(db, admin, "hepsiburada", on);
    expect(state.due).toBe(true);
    const started = await startScheduledCollectionRun(db, admin, "hepsiburada", on);
    expect(started.queries).toEqual(["kulaklik", "telefon"]);
    expect(started.maxPages).toBe(2);
    expect(started.run.status).toBe("open");
    await expect(startScheduledCollectionRun(db, admin, "hepsiburada", on)).rejects.toMatchObject({
      code: "schedule_not_due",
      detail: "open_run",
    });
    const audit = await withOwnerClient(async (c) =>
      c.query(
        "SELECT after FROM admin_audit_event WHERE action = 'catalog_collection.schedule_start' AND target_id = $1",
        [String(started.run.id)],
      ),
    );
    expect(audit.rows[0]?.after).toMatchObject({ templateRunId: template, queries: 2 });
  });

  it("Trendyol: son kosunun okunan urun/liste adresleriyle ayni zamanlayici (karar 0221)", async () => {
    await reset();
    const previous = process.env.TRENDYOL_COLLECTION_ENABLED;
    process.env.TRENDYOL_COLLECTION_ENABLED = "true";
    const product = "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094";
    try {
      await withOwnerClient((c) =>
        c.query("UPDATE collection_source SET enabled = TRUE WHERE source = 'trendyol'"),
      );
      const off = await getCollectionSchedule(db, admin, "trendyol", on);
      expect(off.blockedBy).toBe("no_template"); // ilk kosu elle
      const run = await startCollectionRun(db, admin, { source: "trendyol" });
      await withOwnerClient(async (c) => {
        await c.query(
          `INSERT INTO collection_unit (run_id, kind, unit_key, page, status, items_found, items_new, fetched_at)
           VALUES ($1, 'product_page', '857296094', 1, 'done', 1, 1, now()),
                  ($1, 'listing_page', '/apple-cep-telefonu-x-b101470-c103498', 1, 'done', 2, 2, now()),
                  ($1, 'listing_page', '/sr', 1, 'done', 1, 1, now())`,
          [run.id],
        );
        await c.query(
          `INSERT INTO catalog_intake_record (run_id, external_id, title, url, price_minor, currency,
                                             source_observed_at)
           VALUES ($1, '857296094', 'Apple iPhone 16 Pro', $2, 12499900, 'TRY', now())`,
          [run.id, product],
        );
        await c.query(
          "UPDATE collection_run SET requests_made = 3, requests_reserved = 3 WHERE id = $1",
          [run.id],
        );
        await c.query("UPDATE collection_run SET status = 'completed' WHERE id = $1", [run.id]);
      });
      // Trendyol politikasi bu testte 0079 varsayilanidir (7 gun / ayda 4): zamanlayici uyar.
      const state = await getCollectionSchedule(db, admin, "trendyol", on);
      expect(state).toMatchObject({ due: false, blockedBy: "interval", minIntervalDays: 7 });
      // Ayni anda kaydedilen birimlerin sirasi collation'a baglidir; icerik karsilastirilir.
      expect([...(state.template?.urls ?? [])].sort()).toEqual(
        [product, "https://www.trendyol.com/apple-cep-telefonu-x-b101470-c103498"].sort(),
      );
      // Politika gevsetilince (sahip rol; kullanici beyani 100/hafta, 400/ay) ayni gun acilir.
      await withOwnerClient((c) =>
        c.query(
          `UPDATE collection_source SET permission_basis = 'declared_extended', min_interval_days = 0,
                  max_runs_per_month = 400, permission_note = 'test' WHERE source = 'trendyol'`,
        ),
      );
      const started = await startScheduledCollectionRun(db, admin, "trendyol", on);
      expect(started.urls).toHaveLength(2);
      expect(started.queries).toEqual([]);
    } finally {
      await withOwnerClient(async (c) => {
        await c.query(
          "DELETE FROM catalog_intake_record WHERE run_id IN (SELECT id FROM collection_run WHERE source = 'trendyol')",
        );
        await c.query(
          "DELETE FROM collection_unit WHERE run_id IN (SELECT id FROM collection_run WHERE source = 'trendyol')",
        );
        await c.query("DELETE FROM collection_run WHERE source = 'trendyol'");
        await c.query(
          `UPDATE collection_source SET enabled = FALSE, permission_basis = 'written_email_reported',
                  min_interval_days = 7, max_runs_per_month = 4 WHERE source = 'trendyol'`,
        );
      });
      if (previous === undefined) delete process.env.TRENDYOL_COLLECTION_ENABLED;
      else process.env.TRENDYOL_COLLECTION_ENABLED = previous;
    }
  });
});
