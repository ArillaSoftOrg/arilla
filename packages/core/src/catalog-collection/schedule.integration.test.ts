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

  it("son kosudan 7 gun gecmeden sunucu reddeder (DB politikasi aralik 0 olsa bile)", async () => {
    await reset();
    await closedManualRun(2);
    const state = await getCollectionSchedule(db, admin, "hepsiburada", on);
    expect(state).toMatchObject({ due: false, blockedBy: "interval", runsThisMonth: 1 });
    await expect(startScheduledCollectionRun(db, admin, "hepsiburada", on)).rejects.toMatchObject({
      code: "schedule_not_due",
      detail: "interval",
    });
  });

  it("7 gun dolunca son kosunun sorgulariyla kosu acar; ikinci istek acik kosuda durur", async () => {
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
});
