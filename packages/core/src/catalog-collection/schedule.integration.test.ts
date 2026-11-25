import type { Database } from "@arilla/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AdminActor } from "../admin/capabilities.ts";
import { listCollectionSchedules } from "../admin/collection-schedule-findings.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  getCollectionSchedule,
  recordScheduledOutcome,
  saveCollectionSchedule,
  startScheduledRun,
} from "./schedule.ts";
import { closeCollectionRun, startCollectionRun } from "./service.ts";

/** Zamanlanmis Trendyol toplamasi (karar 0221): kota tetikleyicisi zamanlayiciyi de baglar. */
describe("zamanlanmis toplama - entegrasyon (gercek Postgres)", () => {
  let db: Database;
  let admin: AdminActor;
  const suffix = Date.now();
  const saved = {
    collect: process.env.TRENDYOL_COLLECTION_ENABLED,
    schedule: process.env.TRENDYOL_SCHEDULE_ENABLED,
  };
  const ON = { TRENDYOL_COLLECTION_ENABLED: "true", TRENDYOL_SCHEDULE_ENABLED: "true" };
  const TARGETS = [
    "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094",
    "https://www.trendyol.com/adidas/samba-og-bej-spor-ayakkabi-id0478-p-813659620",
  ];

  async function reset() {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM collection_schedule WHERE source = 'trendyol'");
      await c.query(
        "DELETE FROM collection_unit WHERE run_id IN (SELECT id FROM collection_run WHERE source = 'trendyol')",
      );
      await c.query(
        "DELETE FROM catalog_intake_record WHERE run_id IN (SELECT id FROM collection_run WHERE source = 'trendyol')",
      );
      await c.query("DELETE FROM collection_run WHERE source = 'trendyol'");
      await c.query("DELETE FROM collection_usage_day WHERE source = 'trendyol'");
      await c.query("UPDATE collection_source SET enabled = FALSE WHERE source = 'trendyol'");
    });
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (c) => {
      const r = await c.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [`ty-schedule-${suffix}@test.local`],
      );
      admin = { userId: Number(r.rows[0].id), role: "admin" };
    });
  });

  beforeEach(async () => {
    process.env.TRENDYOL_COLLECTION_ENABLED = "true";
    delete process.env.TRENDYOL_SCHEDULE_ENABLED;
    await reset();
  });

  afterAll(async () => {
    process.env.TRENDYOL_COLLECTION_ENABLED = saved.collect;
    process.env.TRENDYOL_SCHEDULE_ENABLED = saved.schedule;
    if (saved.collect === undefined) delete process.env.TRENDYOL_COLLECTION_ENABLED;
    if (saved.schedule === undefined) delete process.env.TRENDYOL_SCHEDULE_ENABLED;
    await reset();
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM admin_audit_event WHERE actor_user_id = $1", [admin.userId]);
      await c.query("DELETE FROM app_user WHERE email = $1", [`ty-schedule-${suffix}@test.local`]);
    });
  });

  it("varsayilan kapali: satir yok, bayrak yok; acmak bayrak ister, koşu acilmaz", async () => {
    const { schedule } = await getCollectionSchedule(db, admin, "trendyol", new Date(), {});
    expect(schedule).toMatchObject({ flagEnabled: false, enabled: false, targetUrls: [] });
    expect(schedule.decision).toMatchObject({ action: "wait", reason: "flag_off" });
    await expect(
      saveCollectionSchedule(
        db,
        admin,
        { source: "trendyol", enabled: true, targetUrls: TARGETS, paceSeconds: 45 },
        {},
      ),
    ).rejects.toMatchObject({ code: "schedule_flag_off" });
    await expect(startScheduledRun(db, admin, "trendyol", new Date(), {})).rejects.toMatchObject({
      code: "schedule_flag_off",
    });
  });

  it("kaynak bayragi kapaliyken zamanlama da yok sayilir (404)", async () => {
    delete process.env.TRENDYOL_COLLECTION_ENABLED;
    await expect(getCollectionSchedule(db, admin, "trendyol")).rejects.toMatchObject({
      code: "unknown_source",
    });
    await expect(getCollectionSchedule(db, admin, "hepsiburada")).rejects.toMatchObject({
      code: "unknown_source",
    });
  });

  it("acik zamanlama + kapali kaynak politikasi: baslamaz (source_disabled)", async () => {
    await saveCollectionSchedule(
      db,
      admin,
      { source: "trendyol", enabled: true, targetUrls: TARGETS, paceSeconds: 45 },
      ON,
    );
    await expect(startScheduledRun(db, admin, "trendyol", new Date(), ON)).rejects.toMatchObject({
      code: "schedule_source_disabled",
    });
  });

  it("izinli koşu acilir; ikinci koşu 7 gun kotasiyla reddedilir; sonuc ve bulgu kaydedilir", async () => {
    await withOwnerClient((c) =>
      c.query("UPDATE collection_source SET enabled = TRUE WHERE source = 'trendyol'"),
    );
    const save = await saveCollectionSchedule(
      db,
      admin,
      {
        source: "trendyol",
        enabled: true,
        targetUrls: [...TARGETS, "https://www.trendyol.com/sepet", TARGETS[0]],
        paceSeconds: 30,
      },
      ON,
    );
    expect(save).toEqual({ saved: 2, invalid: 1, overflow: 0 });

    const started = await startScheduledRun(db, admin, "trendyol", new Date(), ON);
    expect(started.targetUrls).toEqual(TARGETS);
    expect(started.paceSeconds).toBe(30);
    expect(started.run.kind).toBe("initial"); // ilk yukleme de kotaya sayilir

    // Acik zamanlanmis koşu varken yeni koşu yok; sayfa yeniden acilirsa "yarim kaldi" der.
    const mid = await getCollectionSchedule(db, admin, "trendyol", new Date(), ON);
    expect(mid.schedule.decision).toEqual({ action: "interrupted", runId: started.run.id });

    await closeCollectionRun(db, admin, { runId: started.run.id, outcome: "aborted" });
    await recordScheduledOutcome(db, admin, {
      source: "trendyol",
      runId: started.run.id,
      outcome: "blocked",
      errorCode: "structure_missing",
    });

    const after = await getCollectionSchedule(db, admin, "trendyol", new Date(), ON);
    expect(after.schedule).toMatchObject({
      lastRunId: started.run.id,
      lastOutcome: "blocked",
      lastErrorCode: "structure_missing",
      lastFailed: true,
    });
    // Released degil (sayfa acilmasa da rezervasyon yoksa released olur) ya da aborted: her
    // iki durumda karar kotadan gelir; zamanlayici kotayi asla atlamaz.
    if (after.status.quota.canStart) {
      expect(after.schedule.decision).toEqual({ action: "start" });
    } else {
      expect(after.schedule.decision).toMatchObject({ action: "wait", reason: "interval" });
    }

    const items = await listCollectionSchedules(db, ON);
    expect(items.find((i) => i.source === "trendyol")).toMatchObject({
      active: true,
      lastOutcome: "blocked",
    });
  });

  it("kullanilmis kota: zamanlayici baslatmaz, tetikleyici de reddeder", async () => {
    await withOwnerClient((c) =>
      c.query("UPDATE collection_source SET enabled = TRUE WHERE source = 'trendyol'"),
    );
    await saveCollectionSchedule(
      db,
      admin,
      { source: "trendyol", enabled: true, targetUrls: TARGETS, paceSeconds: 45 },
      ON,
    );
    // Elle acilan ve istek rezerve eden koşu kotayi tuketir.
    const manual = await startCollectionRun(db, admin, { source: "trendyol" });
    await withOwnerClient((c) =>
      c.query("UPDATE collection_run SET requests_reserved = 1, requests_made = 1 WHERE id = $1", [
        manual.id,
      ]),
    );
    const open = await getCollectionSchedule(db, admin, "trendyol", new Date(), ON);
    expect(open.schedule.decision).toMatchObject({ action: "wait", reason: "open_run" });
    await closeCollectionRun(db, admin, { runId: manual.id, outcome: "completed" });

    const { schedule } = await getCollectionSchedule(db, admin, "trendyol", new Date(), ON);
    expect(schedule.decision).toMatchObject({ action: "wait", reason: "interval" });
    await expect(startScheduledRun(db, admin, "trendyol", new Date(), ON)).rejects.toMatchObject({
      code: "schedule_interval",
    });
    // Zamanlanmis olmayan kosunun sonucu yazilamaz.
    await expect(
      recordScheduledOutcome(db, admin, {
        source: "trendyol",
        runId: manual.id,
        outcome: "completed",
      }),
    ).rejects.toMatchObject({ code: "not_scheduled_run" });
  });
});
