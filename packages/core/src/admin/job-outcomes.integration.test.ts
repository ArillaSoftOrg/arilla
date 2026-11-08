/**
 * Karar 0174 (PR1b) — iş sonucu okuması gerçek YEREL Postgres'te: `lastGoodAt`,
 * `lastRanAt`, `lastAttemptAt`, `lastProducedAt` SQL filtreleri, yanlış türde
 * sayaçlar ve bozuk sonuçlar sorguyu düşürmeden doğru sınıflanır.
 *
 * Sonuç yazan işlerin (`resolve`, `similarity*`) adları sabit olduğundan test bu
 * adların satırlarını YEREL veritabanında temizler (yalnızca yerel adreste koşar).
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { type JobLastRun, listJobRuns, readJobRunSummary } from "./job-runs.ts";
import { evaluatePipeline, getPipelineEvidence, stageRunEvidence } from "./pipeline-evidence.ts";

function assertLocal(): void {
  for (const name of ["DATABASE_URL", "DATABASE_URL_OWNER"]) {
    const host = new URL(process.env[name] ?? "").hostname;
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
      throw new Error(`${name} yerel degil; bu test yalnizca yerel veritabaninda calisir.`);
    }
  }
}

const JOBS = ["resolve", "similarity", "similarity_edges", "similarity_prices"];
const TAG = `jo${Date.now().toString(36)}`;
let db: Database;
let adminId: number;
/** Koşunun başlangıcı: şimdi - `hours` saat; bitiş 1 dakika sonra. */
const startedAt = new Map<string, Date>();
const finishedAt = new Map<string, Date>();

async function insertRun(
  key: string,
  job: string,
  status: string,
  hoursAgo: number,
  detail: unknown,
): Promise<void> {
  await withOwnerClient(async (client) => {
    const res = await client.query(
      `INSERT INTO job_run (job, trigger, status, started_at, finished_at, detail)
       VALUES ($1, 'cron', $2, now() - make_interval(secs => $3 * 3600),
               CASE WHEN $2 = 'running' THEN NULL
                    ELSE now() - make_interval(secs => $3 * 3600) + interval '1 minute' END,
               $4::jsonb)
       RETURNING started_at, finished_at`,
      [job, status, hoursAgo, JSON.stringify(detail)],
    );
    startedAt.set(key, new Date(res.rows[0].started_at));
    if (res.rows[0].finished_at) finishedAt.set(key, new Date(res.rows[0].finished_at));
  });
}

const fin = (key: string) => finishedAt.get(key) ?? null;
let summaryJobs: JobLastRun[] = [];
const byName = (name: string) => summaryJobs.find((j) => j.job === name);

beforeAll(async () => {
  assertLocal();
  db = getTestDb();
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM job_run WHERE job = ANY($1)", [JOBS]);
    const res = await client.query(
      "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
      [`${TAG}-admin@test.local`],
    );
    adminId = Number(res.rows[0].id);
  });

  // resolve: eski biçim çıktılı → completed ama yalnızca kuyruk → başarısız → girdi yok →
  // yanlış türde sayaçlar → kilit nedeniyle atlandı (en yeni).
  await insertRun("r_legacy", "resolve", "success", 50, { auto_accepted: 3, queued: 1 });
  await insertRun("r_queued", "resolve", "success", 40, {
    outcome: "completed",
    auto_accepted: 0,
    products_created: 0,
    queued: 5,
  });
  await insertRun("r_failed", "resolve", "failed", 30, { outcome: "failed", reason: "exception" });
  await insertRun("r_noinput", "resolve", "success", 20, {
    outcome: "no_input",
    reason: "no_eligible_offers",
    considered: 0,
  });
  await insertRun("r_badtypes", "resolve", "success", 10, {
    outcome: "completed",
    auto_accepted: "7",
    products_created: { n: 1 },
    queued: 2,
  });
  await insertRun("r_skipped", "resolve", "partial", 1, {
    outcome: "skipped_locked",
    reason: "lock_busy",
    auto_accepted: 99,
  });

  // similarity_edges: çıktılı completed → blocked_upstream → iki bozuk sonuç.
  await insertRun("e_done", "similarity_edges", "success", 30, {
    outcome: "completed",
    visual_edges: 10,
    semantic_edges: 0,
    visual_products: 5,
  });
  await insertRun("e_blocked", "similarity_edges", "partial", 20, {
    outcome: "blocked_upstream",
    reason: "no_embeddings",
    visual_edges: 0,
    semantic_edges: 0,
    visual_products: 0,
  });
  await insertRun("e_bogus", "similarity_edges", "success", 10, { outcome: "bogus" });
  await insertRun("e_object", "similarity_edges", "success", 5, {
    outcome: { name: "completed" },
    visual_edges: 4,
  });
  await insertRun("e_mismatch", "similarity_edges", "success", 4, {
    outcome: "skipped_locked",
    visual_edges: 4,
  });

  // Birleşik similarity: kenar engellendi, fiyat yazıldı.
  await insertRun("s_blocked", "similarity", "partial", 3, {
    outcome: "blocked_upstream",
    reason: "no_embeddings",
    visual_edges: 0,
    semantic_edges: 0,
    price_products: 4,
    price_aggregates: 9,
  });
  // Sadece fiyat işi: completed ama yazılan ürün yok (aggregates çıktı sayılmaz).
  await insertRun("p_done", "similarity_prices", "success", 6, {
    outcome: "completed",
    price_products: 0,
    price_aggregates: 12,
  });

  summaryJobs = (await readJobRunSummary(db)).jobs;
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM job_run WHERE job = ANY($1)", [JOBS]);
    await client.query("DELETE FROM app_user WHERE id = $1", [adminId]);
  });
});

describe("readJobRunSummary — resolve", () => {
  it("son koşu kilit nedeniyle atlandı: geçerli tamamlanma ve deneme önceki koşudan", () => {
    const resolve = byName("resolve");
    expect(resolve?.lastRun?.outcome).toMatchObject({ kind: "skipped_locked", good: false });
    // Yanlış türde sayaçlı completed geçerli tamamlanmadır (sayaç bozuk, sonuç geçerli).
    expect(resolve?.lastGoodAt).toEqual(fin("r_badtypes"));
    expect(resolve?.lastRanAt).toEqual(fin("r_badtypes"));
    expect(resolve?.lastAttemptAt).toEqual(startedAt.get("r_badtypes"));
    expect(resolve?.failuresSinceGood).toBe(0);
  });

  it("son çıktı yalnızca doğrulanmış sayaçtan: kuyruk, metin/nesne sayaç ve atlanan koşu sayılmaz", () => {
    const resolve = byName("resolve");
    // r_skipped auto_accepted 99 yazsa da geçerli koşu değil; r_badtypes "7" metin;
    // r_queued yalnızca kuyruk. Son doğrulanmış çıktı eski biçim koşusu.
    expect(resolve?.lastProducedAt).toEqual(fin("r_legacy"));
    expect(resolve?.producedAt).toEqual({ resolve: fin("r_legacy") });
  });
});

describe("readJobRunSummary — similarity", () => {
  it("blocked_upstream tazelik değil; bozuk sonuçlar başarısızlık sayılır ve sorgu düşmez", () => {
    const edges = byName("similarity_edges");
    expect(edges?.lastRun?.outcome.kind).toBe("invalid");
    expect(edges?.lastGoodAt).toEqual(fin("e_done"));
    expect(edges?.lastRanAt).toEqual(fin("e_blocked"));
    expect(edges?.failuresSinceGood).toBe(3);
    // Bozuk sonuçlu koşunun kenar sayacı çıktı sayılmaz.
    expect(edges?.lastProducedAt).toEqual(fin("e_done"));
    expect(edges?.lastAttemptAt).toEqual(startedAt.get("e_mismatch"));
  });

  it("birleşik iş: kenar çıktısı yok, fiyat çıktısı var; fiyat aşaması bayat sayılmaz", () => {
    const combined = byName("similarity");
    expect(combined?.lastGoodAt).toBeNull();
    expect(combined?.lastRanAt).toEqual(fin("s_blocked"));
    expect(combined?.producedAt).toEqual({ edges: null, prices: fin("s_blocked") });
    expect(byName("similarity_prices")?.lastProducedAt).toBeNull();
    expect(byName("similarity_prices")?.lastGoodAt).toEqual(fin("p_done"));

    const runs = stageRunEvidence(summaryJobs);
    expect(runs.prices).toMatchObject({
      lastGoodAt: fin("s_blocked"),
      lastOutcome: "completed",
      lastProducedAt: fin("s_blocked"),
    });
    expect(runs.edges).toMatchObject({
      lastGoodAt: fin("e_done"),
      lastOutcome: "blocked_upstream",
      lastProducedAt: fin("e_done"),
    });
  });

  it("çıktı sayacı tanımsız işte son çıktı null", async () => {
    await insertRun("x_enrich", "enrich", "success", 2, { embedded: 50 });
    try {
      const enrich = (await readJobRunSummary(db)).jobs.find((j) => j.job === "enrich");
      expect(enrich).toMatchObject({ lastProducedAt: null, producedAt: {} });
      expect(enrich?.lastRun?.outcome.kind).toBe("legacy");
    } finally {
      await withOwnerClient((client) =>
        client.query("DELETE FROM job_run WHERE job = 'enrich' AND started_at = $1", [
          startedAt.get("x_enrich"),
        ]),
      );
    }
  });
});

describe("boru hattı ve koşu geçmişi", () => {
  it("getPipelineEvidence: kenar aşaması uyarı, fiyat aşaması iş kaydından güncel", async () => {
    const actor = { userId: adminId, role: "admin" as const };
    const views = evaluatePipeline(await getPipelineEvidence(db, actor));
    const edges = views.find((v) => v.stage === "edges");
    // Son kenar koşusu (e_mismatch, similarity_edges) bozuk; birleşik iş (3 saat) daha yeni ve engelli.
    expect(edges?.state).toBe("warning");
    expect(edges?.reasons).toContain("job_blocked_upstream");
    const prices = views.find((v) => v.stage === "prices");
    expect(prices).toMatchObject({ source: "job_run", lastOutcome: "completed" });
    expect(prices?.reasons).toEqual([]);
  });

  it("listJobRuns her satıra sonucu ekler; status filtresi değişmez", async () => {
    const actor = { userId: adminId, role: "admin" as const };
    const page = await listJobRuns(db, actor, { job: "resolve", pageSize: 50 });
    const kinds = page.rows.map((r) => r.outcome.kind);
    expect(kinds).toEqual([
      "skipped_locked",
      "completed",
      "no_input",
      "failed",
      "completed",
      "legacy",
    ]);
    const partial = await listJobRuns(db, actor, { job: "resolve", status: "partial" });
    expect(partial.rows.map((r) => r.outcome.kind)).toEqual(["skipped_locked"]);
  });
});
