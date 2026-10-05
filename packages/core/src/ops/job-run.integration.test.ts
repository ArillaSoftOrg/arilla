/**
 * Karar 0055: `job_run` yazımı (cron sarmalayıcı), 180 gün temizliği ve
 * yönetim okuma modeli — gerçek Postgres. Testler yalnızca kendi iş adlarını
 * (`t55_...`) denetler ve siler.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listJobRuns, readJobRunSummary } from "../admin/job-runs.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { finishJobRun, purgeJobRuns, startJobRun, withJobRun } from "./job-run.ts";

const SUFFIX = Date.now().toString(36).slice(-6);
const JOB = `t55_${SUFFIX}`;
const OLD_JOB = `t55o_${SUFFIX}`;
const ADMIN = { userId: 1, role: "admin" as const };
const MODERATOR = { userId: 2, role: "moderator" as const };

async function rows(job: string) {
  return withOwnerClient(async (client) => {
    const res = await client.query(
      `SELECT status, trigger, finished_at IS NOT NULL AS finished, detail, error_summary
         FROM job_run WHERE job = $1 ORDER BY id`,
      [job],
    );
    return res.rows;
  });
}

describe("job_run — entegrasyon", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    await withOwnerClient((client) =>
      client.query("DELETE FROM job_run WHERE job = ANY($1)", [[JOB, OLD_JOB]]),
    );
  });

  it("withJobRun başarıyı düz ayrıntıyla, durumu özetleyiciyle yazar", async () => {
    const result = await withJobRun(
      db,
      JOB,
      "cron",
      async () => ({ deleted: 3, truncated: true, nested: { a: 1 } }),
      (r) => ({ status: r.truncated ? "partial" : "success" }),
    );
    expect(result.deleted).toBe(3);
    expect(await rows(JOB)).toEqual([
      {
        status: "partial",
        trigger: "cron",
        finished: true,
        detail: { deleted: 3, truncated: true, nested_a: 1 },
        error_summary: null,
      },
    ]);
  });

  it("iş hata fırlatırsa failed + kırpılmış özet yazılır, hata aynen yükselir", async () => {
    await expect(
      withJobRun(db, JOB, "cron", async () => {
        throw new Error("smtp://user:pw@mail.example:25 reddetti token=abc");
      }),
    ).rejects.toThrow("reddetti");
    const last = (await rows(JOB)).at(-1);
    expect(last?.status).toBe("failed");
    expect(last?.error_summary).toContain("smtp://mail.example:25/…");
    expect(last?.error_summary).not.toContain("pw");
    expect(last?.error_summary).not.toContain("abc");
  });

  it("geçersiz iş adı kayıt bırakmaz ve işi düşürmez; ikinci kapanış yok sayılır", async () => {
    expect(await startJobRun(db, "Geçersiz-Ad")).toBeNull();
    expect(await withJobRun(db, "x", "cron", async () => 5)).toBe(5);
    const id = await startJobRun(db, JOB, "manual");
    await finishJobRun(db, id, "success");
    await finishJobRun(db, id, "failed", {}, "yok sayılır");
    expect((await rows(JOB)).at(-1)).toMatchObject({ status: "success", trigger: "manual" });
  });

  it("okuma modeli: iş başına son koşu ve başarısızlık sayısı; takılı koşu; liste yalnızca yönetici", async () => {
    await withJobRun(db, JOB, "cron", async () => {
      throw new Error("bir");
    }).catch(() => {});
    const summary = await readJobRunSummary(db);
    const mine = summary.jobs.find((j) => j.job === JOB);
    expect(mine?.lastRun?.status).toBe("failed");
    expect(mine?.failuresSinceGood).toBe(1);
    expect(summary.jobs.some((j) => j.job === "cleanup_auth")).toBe(true);

    await withOwnerClient((client) =>
      client.query(
        "INSERT INTO job_run (job, started_at) VALUES ($1, now() - interval '3 hours')",
        [JOB],
      ),
    );
    const again = await readJobRunSummary(db);
    expect(again.stuck.some((s) => s.job === JOB)).toBe(true);

    const page = await listJobRuns(db, ADMIN, { job: JOB, pageSize: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.nextBeforeId).not.toBeNull();
    await expect(listJobRuns(db, MODERATOR, {})).rejects.toThrow("yetki yok");
  });

  it("purgeJobRuns 180 günden eski koşuları (açık kalanlar dahil) siler, yenileri bırakır", async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        `INSERT INTO job_run (job, status, started_at, finished_at)
         VALUES ($1, 'success', now() - interval '181 days', now() - interval '181 days'),
                ($1, 'running', now() - interval '200 days', NULL),
                ($1, 'success', now() - interval '179 days', now() - interval '179 days')`,
        [OLD_JOB],
      );
    });
    const result = await purgeJobRuns(db);
    expect(result.truncated).toBe(false);
    expect(result.deleted).toBeGreaterThanOrEqual(2);
    expect(await rows(OLD_JOB)).toHaveLength(1);
  });
});
