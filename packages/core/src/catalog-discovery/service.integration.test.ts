import type { Database } from "@arilla/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AdminActor, AdminForbiddenError } from "../admin/capabilities.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  cancelDiscoveryOperation,
  claimDiscoveryUnit,
  DiscoveryError,
  getDiscoveryStatus,
  listProblemUnits,
  pauseDiscoveryOperation,
  reportDiscoveryFailure,
  resumeDiscoveryOperation,
  startDiscoveryOperation,
  submitDiscoveryItems,
  submitDiscoveryPlan,
} from "./service.ts";

const ORIGIN = "https://www.hepsiburada.com";
const FILE = (n: number) => `${ORIGIN}/sitemaps/product/sitemap-${n}.xml`;
const item = (code: string, title: string | null = `Ürün ${code}`) => ({
  externalId: code,
  codeKind: "pm",
  urlPath: `/urun-${code.toLowerCase()}-pm-${code}`,
  title,
  imageUrl: `https://productimages.hepsiburada.net/s/1/${code}.jpg`,
});

const A = "client-aaaaaaaa";
const B = "client-bbbbbbbb";
const SEC = 1000;
const HOUR = 3_600_000;

describe("sitemap kesfi servisi - entegrasyon (gercek Postgres)", () => {
  let db: Database;
  let admin: AdminActor;
  let moderator: AdminActor;
  const suffix = Date.now();
  let clock: number;
  const tick = (ms = 3 * SEC) => {
    clock += ms;
    return new Date(clock);
  };

  async function owner(sqlText: string, params: unknown[] = []) {
    return withOwnerClient((c) => c.query(sqlText, params));
  }

  async function reset() {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM catalog_discovery");
      await c.query("DELETE FROM catalog_sync_request");
      await c.query("DELETE FROM catalog_sync_unit");
      await c.query("DELETE FROM catalog_sync_operation");
      await c.query("DELETE FROM catalog_intake_record");
      await c.query("DELETE FROM collection_unit");
      await c.query("DELETE FROM collection_run");
      await c.query(
        "UPDATE catalog_discovery_tally SET items_total = 0, items_priced = 0, items_published = 0, items_removed = 0",
      );
      await c.query("UPDATE collection_source SET enabled = TRUE WHERE source = 'hepsiburada'");
      await c.query(
        `UPDATE discovery_source_policy
            SET enabled = TRUE, min_request_interval_ms = 2000, daily_max_requests = 2500,
                max_attempts_per_file = 3, blocked_cooldown_hours = 24
          WHERE source = 'hepsiburada'`,
      );
    });
    clock = Date.now();
  }

  /** Kosu #1 benzeri, 8 gun once rezerve edilmis ve iptal edilmis eski kota satiri. */
  async function legacyRun(
    daysAgo = 8,
  ): Promise<{ id: number; reserved_at: Date; status: string }> {
    return withOwnerClient(async (c) => {
      await c.query("ALTER TABLE collection_run DISABLE TRIGGER collection_run_quota_guard_trg");
      try {
        const r = await c.query(
          `INSERT INTO collection_run (source, kind, status, reserved_at, expires_at, closed_at,
                                       requests_made, max_requests, summary)
           VALUES ('hepsiburada', 'initial', 'aborted', now() - make_interval(days => $1),
                   now() - make_interval(days => $1) + interval '6 days',
                   now() - make_interval(days => $1) + interval '1 hour', 1, 500,
                   '{"reason":"network_error"}')
           RETURNING id, reserved_at, status`,
          [daysAgo],
        );
        return r.rows[0];
      } finally {
        await c.query("ALTER TABLE collection_run ENABLE TRIGGER collection_run_quota_guard_trg");
      }
    });
  }

  /** Operasyonu indeks + dosyalarla planlar; dosya adreslerini dondurur. */
  async function planned(opId: number, files: number[], client = A) {
    const claim = await claimDiscoveryUnit(
      db,
      admin,
      { operationId: opId, clientId: client },
      tick(),
    );
    expect(claim).toMatchObject({ kind: "unit", seq: 0, unitKind: "index" });
    return submitDiscoveryPlan(
      db,
      admin,
      {
        operationId: opId,
        clientId: client,
        files: files.map((n) => ({ url: FILE(n), lastmod: "2026-10-15T00:00:00Z" })),
        final: true,
        bytesDecoded: 1000,
        bytesTransferred: 200,
      },
      new Date(clock),
    );
  }

  async function claimFile(opId: number, client = A) {
    const c = await claimDiscoveryUnit(db, admin, { operationId: opId, clientId: client }, tick());
    if (c.kind !== "unit") throw new Error(`beklenmeyen hak: ${JSON.stringify(c)}`);
    return c;
  }

  async function finishFile(opId: number, seq: number, codes: string[], client = A) {
    return submitDiscoveryItems(
      db,
      admin,
      {
        operationId: opId,
        clientId: client,
        seq,
        batchIndex: 0,
        items: codes.map((c) => item(c)),
        final: true,
        stats: { itemsFound: codes.length, bytesDecoded: 5000, bytesTransferred: 900 },
      },
      new Date(clock),
    );
  }

  async function runAll(opId: number, filesToCodes: Record<number, string[]>) {
    for (;;) {
      const c = await claimDiscoveryUnit(db, admin, { operationId: opId, clientId: A }, tick());
      if (c.kind === "done") return c;
      if (c.kind === "wait") continue;
      await finishFile(opId, c.seq, filesToCodes[c.seq] ?? []);
    }
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (c) => {
      const ids: number[] = [];
      for (const role of ["admin", "moderator"]) {
        const r = await c.query("INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id", [
          `discovery-${role}-${suffix}@test.local`,
          role,
        ]);
        ids.push(Number(r.rows[0].id));
      }
      admin = { userId: ids[0] as number, role: "admin" };
      moderator = { userId: ids[1] as number, role: "moderator" };
    });
  });

  beforeEach(reset);

  afterAll(async () => {
    await reset();
    await withOwnerClient(async (c) => {
      await c.query(
        "UPDATE discovery_source_policy SET enabled = FALSE WHERE source = 'hepsiburada'",
      );
      await c.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [
        [admin.userId, moderator.userId],
      ]);
      await c.query("DELETE FROM app_user WHERE id = ANY($1)", [[admin.userId, moderator.userId]]);
    });
  });

  it("yonetici olmayan rol erisemez", async () => {
    await expect(getDiscoveryStatus(db, moderator, "hepsiburada")).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
    await expect(
      startDiscoveryOperation(db, moderator, {
        source: "hepsiburada",
        kind: "initial_import",
        network: "wifi",
        clientId: A,
      }),
    ).rejects.toBeInstanceOf(AdminForbiddenError);
  });

  it("politika kapaliyken ve ag beyani yokken baslamaz", async () => {
    await expect(
      startDiscoveryOperation(db, admin, {
        source: "hepsiburada",
        kind: "initial_import",
        network: "mobile" as never,
        clientId: A,
      }),
    ).rejects.toMatchObject({ code: "network_not_declared" });
    await owner("UPDATE discovery_source_policy SET enabled = FALSE WHERE source = 'hepsiburada'");
    await expect(
      startDiscoveryOperation(db, admin, {
        source: "hepsiburada",
        kind: "initial_import",
        network: "wifi",
        clientId: A,
      }),
    ).rejects.toMatchObject({ code: "discovery_disabled" });
  });

  it("ilk aktarim haftalik kota hakki harcamaz; eski kosu #1 aynen korunur", async () => {
    const legacy = await legacyRun(1);
    const op = await startDiscoveryOperation(db, admin, {
      source: "hepsiburada",
      kind: "initial_import",
      network: "wired",
      clientId: A,
    });
    expect(op).toMatchObject({
      kind: "initial_import",
      status: "open",
      quotaRunId: null,
      maxRequests: 8000,
    });
    await planned(op.id, [1, 2]);
    await runAll(op.id, { 1: ["HBC0000AA01"], 2: ["HBC0000AA02"] });
    const runs = await owner(
      "SELECT id, status, reserved_at, kind FROM collection_run ORDER BY id",
    );
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({ id: legacy.id, status: "aborted", kind: "initial" });
    expect(new Date(runs.rows[0].reserved_at).getTime()).toBe(
      new Date(legacy.reserved_at).getTime(),
    );
    // Iptal edilmemis ikinci ilk aktarim yok.
    await expect(
      startDiscoveryOperation(db, admin, {
        source: "hepsiburada",
        kind: "initial_import",
        network: "wifi",
        clientId: A,
      }),
    ).rejects.toMatchObject({ code: "discovery_initial_exists" });
  });

  it("indeks plani: yabanci adres reddedilir, tekrar tek birim olur; istek araligi zorlanir", async () => {
    const op = await startDiscoveryOperation(db, admin, {
      source: "hepsiburada",
      kind: "initial_import",
      network: "wifi",
      clientId: A,
    });
    await claimDiscoveryUnit(db, admin, { operationId: op.id, clientId: A }, tick());
    const plan = await submitDiscoveryPlan(
      db,
      admin,
      {
        operationId: op.id,
        clientId: A,
        files: [
          { url: FILE(1) },
          { url: FILE(1) },
          { url: "https://evil.example/sitemaps/product/sitemap-2.xml" },
          { url: `${ORIGIN}/baska/yol.xml` },
          { url: `${FILE(3)}?x=1` },
          { url: FILE(2) },
        ],
        final: true,
      },
      new Date(clock),
    );
    expect(plan).toMatchObject({ planned: 2, duplicates: 1, rejected: 3, filesPlanned: 2 });
    // Ayni anda ikinci hak: istek araligi dolmadi.
    const wait = await claimDiscoveryUnit(
      db,
      admin,
      { operationId: op.id, clientId: A },
      new Date(clock + 500),
    );
    expect(wait).toMatchObject({ kind: "wait", reason: "interval" });
    expect((wait as { waitMs: number }).waitMs).toBe(1500);
    const reqs = await owner("SELECT count(*)::int AS n FROM catalog_sync_request");
    expect(reqs.rows[0].n).toBe(1);
  });

  it("kayitlar upsert edilir: tekrar kayit yok, yeniden denemede yeni sayilar sismez", async () => {
    const op = await startDiscoveryOperation(db, admin, {
      source: "hepsiburada",
      kind: "initial_import",
      network: "wifi",
      clientId: A,
    });
    await planned(op.id, [1, 2, 3]);

    const f1 = await claimFile(op.id);
    const b0 = await submitDiscoveryItems(db, admin, {
      operationId: op.id,
      clientId: A,
      seq: f1.seq,
      batchIndex: 0,
      items: [item("HBC0000AA01"), item("HBC0000AA02"), item("HBC0000AA02"), { bad: true }],
      final: false,
    });
    expect(b0).toMatchObject({ inserted: 2, duplicates: 1, rejected: 1 });
    const b1 = await submitDiscoveryItems(db, admin, {
      operationId: op.id,
      clientId: A,
      seq: f1.seq,
      batchIndex: 1,
      items: [item("HBC0000AA01", "Yeni başlık"), item("HBC0000AA03", null)],
      final: true,
      stats: { itemsFound: 6, bytesDecoded: 4000, bytesTransferred: 800 },
    });
    expect(b1).toMatchObject({ inserted: 1, updated: 1 });

    // Dosya 2: ilk parti gonderildi, sonra tarayici kapandi (sonuc bildirilmedi).
    const f2 = await claimFile(op.id);
    await submitDiscoveryItems(db, admin, {
      operationId: op.id,
      clientId: A,
      seq: f2.seq,
      batchIndex: 0,
      items: [item("HBC0000AA01"), item("HBC0000AA04")],
      final: false,
    });
    // Sonraki hak: kesilen dosya 'failed/interrupted' olur, once bekleyen dosya 3 gelir.
    const f3 = await claimFile(op.id);
    expect(f3.seq).toBe(3);
    await finishFile(op.id, f3.seq, ["HBC0000AA05"]);
    const retry = await claimFile(op.id);
    expect(retry).toMatchObject({ seq: f2.seq, attempt: 2 });
    await finishFile(op.id, retry.seq, ["HBC0000AA01", "HBC0000AA04", "HBC0000AA06"]);

    const rows = await owner(
      "SELECT external_id, title, last_seen_unit_seq FROM catalog_discovery ORDER BY external_id",
    );
    expect(rows.rows.map((r) => r.external_id)).toEqual([
      "HBC0000AA01",
      "HBC0000AA02",
      "HBC0000AA03",
      "HBC0000AA04",
      "HBC0000AA05",
      "HBC0000AA06",
    ]);
    // Baslik guncellendi; eksik baslik eskisini silmedi.
    expect(rows.rows[0]).toMatchObject({ title: `Ürün HBC0000AA01` });
    const units = await owner(
      "SELECT seq, status, attempts, items_new, items_found FROM catalog_sync_unit WHERE seq > 0 ORDER BY seq",
    );
    expect(units.rows).toEqual([
      { seq: 1, status: "done", attempts: 1, items_new: 3, items_found: 6 },
      // Denemeler boyunca: AA04 bir kez sayildi (ilk deneme), AA06 yeniden denemede.
      { seq: 2, status: "done", attempts: 2, items_new: 2, items_found: 3 },
      { seq: 3, status: "done", attempts: 1, items_new: 1, items_found: 1 },
    ]);
    const status = await getDiscoveryStatus(db, admin, "hepsiburada", new Date(clock));
    expect(status.tally).toMatchObject({ itemsTotal: 6, itemsPriced: 0, itemsUnpriced: 6 });
    expect(status.activeUnits).toMatchObject({ done: 3, pending: 0, failed: 0 });
    // Hepsi bitti: operasyon tamamlanir; ilk aktarimda kaldirma degerlendirmesi yoktur.
    const done = await claimDiscoveryUnit(db, admin, { operationId: op.id, clientId: A }, tick());
    expect(done).toEqual({ kind: "done", status: "completed" });
    const [opRow] = (
      await owner("SELECT status, removal_state, summary FROM catalog_sync_operation")
    ).rows;
    expect(opRow).toMatchObject({ status: "completed", removal_state: "not_applicable" });
    expect(opRow.summary).toMatchObject({ filesDone: 3, itemsNew: 6, complete: true });
  });

  it("duraklat / surdur: kira baskasindayken devralinmaz, suresi dolunca acikca devralinir", async () => {
    const op = await startDiscoveryOperation(db, admin, {
      source: "hepsiburada",
      kind: "initial_import",
      network: "wifi",
      clientId: A,
    });
    await planned(op.id, [1, 2]);
    await expect(
      claimDiscoveryUnit(db, admin, { operationId: op.id, clientId: B }, tick()),
    ).rejects.toMatchObject({ code: "lease_not_held" });

    await pauseDiscoveryOperation(db, admin, { operationId: op.id }, new Date(clock));
    await expect(
      claimDiscoveryUnit(db, admin, { operationId: op.id, clientId: A }, tick()),
    ).rejects.toMatchObject({ code: "operation_paused" });
    await expect(
      resumeDiscoveryOperation(db, admin, { operationId: op.id, clientId: B }, new Date(clock)),
    ).rejects.toMatchObject({ code: "lease_held_by_other" });

    // Tarayici kapandi: kira suresi doldu; panel "calisan istemci yok" gosterir.
    const later = tick(5 * 60_000);
    const status = await getDiscoveryStatus(db, admin, "hepsiburada", later);
    expect(status.active).toMatchObject({ status: "paused", clientActive: false });
    const resumed = await resumeDiscoveryOperation(
      db,
      admin,
      { operationId: op.id, clientId: B },
      later,
    );
    expect(resumed).toMatchObject({ status: "open", leaseClient: B, clientActive: true });
    // Kaldigi yerden: bekleyen ilk dosya.
    const next = await claimFile(op.id, B);
    expect(next.seq).toBe(1);
  });

  it("engel: operasyon durur, bekleme suresi dolmadan surdurulemez", async () => {
    const op = await startDiscoveryOperation(db, admin, {
      source: "hepsiburada",
      kind: "initial_import",
      network: "wifi",
      clientId: A,
    });
    await planned(op.id, [1, 2]);
    const f = await claimFile(op.id);
    const r = await reportDiscoveryFailure(
      db,
      admin,
      { operationId: op.id, clientId: A, seq: f.seq, outcome: "blocked", errorCode: "http_403" },
      new Date(clock),
    );
    expect(r.status).toBe("blocked");
    await expect(
      claimDiscoveryUnit(db, admin, { operationId: op.id, clientId: A }, tick()),
    ).rejects.toMatchObject({ code: "operation_blocked" });
    await expect(
      resumeDiscoveryOperation(db, admin, { operationId: op.id, clientId: A }, tick(HOUR)),
    ).rejects.toMatchObject({ code: "blocked_cooldown" });
    const problems = await listProblemUnits(db, admin, op.id);
    expect(problems).toEqual([
      expect.objectContaining({ seq: 1, status: "blocked", errorCode: "http_403" }),
    ]);
    await resumeDiscoveryOperation(db, admin, { operationId: op.id, clientId: A }, tick(24 * HOUR));
    // Engelli dosya kendiliginden yeniden denenmez; siradaki bekleyen dosya gelir.
    expect((await claimFile(op.id)).seq).toBe(2);
  });

  it("hatali dosya deneme hakki kadar tekrar edilir, sonra 'failed' kalir; tarama yarim sayilir", async () => {
    await owner(
      "UPDATE discovery_source_policy SET max_attempts_per_file = 2 WHERE source = 'hepsiburada'",
    );
    const op = await startDiscoveryOperation(db, admin, {
      source: "hepsiburada",
      kind: "initial_import",
      network: "wifi",
      clientId: A,
    });
    await planned(op.id, [1]);
    for (let i = 0; i < 2; i++) {
      const f = await claimFile(op.id);
      await reportDiscoveryFailure(db, admin, {
        operationId: op.id,
        clientId: A,
        seq: f.seq,
        outcome: "failed",
        errorCode: "http_404",
        errorDetail: "bulunamadi\u0000",
      });
    }
    const done = await claimDiscoveryUnit(db, admin, { operationId: op.id, clientId: A }, tick());
    expect(done).toEqual({ kind: "done", status: "completed" });
    const [opRow] = (await owner("SELECT summary FROM catalog_sync_operation")).rows;
    expect(opRow.summary).toMatchObject({ filesFailed: 1, complete: false });
  });

  it("gunluk tavan dolunca bekleme suresi doner (istek atilmaz)", async () => {
    await owner(
      "UPDATE discovery_source_policy SET daily_max_requests = 2 WHERE source = 'hepsiburada'",
    );
    const op = await startDiscoveryOperation(db, admin, {
      source: "hepsiburada",
      kind: "initial_import",
      network: "wifi",
      clientId: A,
    });
    await planned(op.id, [1, 2]);
    const f = await claimFile(op.id);
    await finishFile(op.id, f.seq, ["HBC0000AA01"]);
    const wait = await claimDiscoveryUnit(db, admin, { operationId: op.id, clientId: A }, tick());
    expect(wait).toMatchObject({ kind: "wait", reason: "daily_limit" });
    expect((wait as { waitMs: number }).waitMs).toBeGreaterThan(23 * HOUR);
    expect((await owner("SELECT count(*)::int AS n FROM catalog_sync_request")).rows[0].n).toBe(2);
  });

  it("istek butcesi asilamaz", async () => {
    const op = await startDiscoveryOperation(db, admin, {
      source: "hepsiburada",
      kind: "initial_import",
      network: "wifi",
      clientId: A,
    });
    await planned(op.id, [1, 2]);
    await withOwnerClient(async (c) => {
      await c.query(
        "ALTER TABLE catalog_sync_operation DISABLE TRIGGER catalog_sync_operation_update_guard_trg",
      );
      await c.query("UPDATE catalog_sync_operation SET max_requests = 1 WHERE id = $1", [op.id]);
      await c.query(
        "ALTER TABLE catalog_sync_operation ENABLE TRIGGER catalog_sync_operation_update_guard_trg",
      );
    });
    await expect(
      claimDiscoveryUnit(db, admin, { operationId: op.id, clientId: A }, tick()),
    ).rejects.toMatchObject({ code: "request_budget_exceeded" });
  });

  describe("haftalik yenileme", () => {
    async function completedInitial(codes: Record<number, string[]>) {
      const op = await startDiscoveryOperation(db, admin, {
        source: "hepsiburada",
        kind: "initial_import",
        network: "wifi",
        clientId: A,
      });
      await planned(op.id, Object.keys(codes).map(Number));
      await runAll(op.id, codes);
      return op;
    }

    it("ilk aktarim tamamlanmadan baslamaz", async () => {
      await legacyRun();
      await expect(
        startDiscoveryOperation(db, admin, {
          source: "hepsiburada",
          kind: "weekly_refresh",
          network: "wifi",
          clientId: A,
        }),
      ).rejects.toMatchObject({ code: "discovery_initial_required" });
      // Basarisiz denemede kota satiri da geri alinir (ayni islem).
      expect((await owner("SELECT count(*)::int AS n FROM collection_run")).rows[0].n).toBe(1);
    });

    it("operasyon basina tek kota hakki; dosyalar ayri hak sayilmaz; 7 gun kurali", async () => {
      const legacy = await legacyRun();
      await completedInitial({ 1: ["HBC0000AA01", "HBC0000AA02"], 2: ["HBC0000AA03"] });
      const op = await startDiscoveryOperation(db, admin, {
        source: "hepsiburada",
        kind: "weekly_refresh",
        network: "wifi",
        clientId: A,
      });
      expect(op.quotaRunId).not.toBeNull();
      expect(op.maxRequests).toBe(8000);
      await planned(op.id, [1, 2, 3]);
      // AA02 bu taramada gorulmuyor; AA04 yeni.
      const done = await runAll(op.id, {
        1: ["HBC0000AA01"],
        2: ["HBC0000AA03"],
        3: ["HBC0000AA04"],
      });
      expect(done).toEqual({ kind: "done", status: "completed" });

      const runs = await owner(
        "SELECT id, kind, status, requests_made, summary FROM collection_run ORDER BY id",
      );
      expect(runs.rows).toHaveLength(2);
      expect(runs.rows[0]).toMatchObject({ id: legacy.id, status: "aborted" });
      expect(runs.rows[1]).toMatchObject({
        kind: "refresh",
        status: "completed",
        requests_made: 0,
      });
      expect(runs.rows[1].summary).toMatchObject({
        mode: "sitemap_refresh",
        operationId: op.id,
        requests: 4,
      });

      const opRow = (
        await owner("SELECT removal_state FROM catalog_sync_operation WHERE id = $1", [op.id])
      ).rows[0];
      expect(opRow.removal_state).toBe("pending");
      // Gorulmeyen urun SILINMEZ ve TS tarafinda kaldirilmis sayilmaz.
      const aa02 = (
        await owner(
          "SELECT presence, missed_scans, last_seen_operation_id FROM catalog_discovery WHERE external_id = 'HBC0000AA02'",
        )
      ).rows[0];
      expect(aa02).toMatchObject({ presence: "present", missed_scans: 0 });
      expect(Number(aa02.last_seen_operation_id)).not.toBe(op.id);
      const aa01 = (
        await owner(
          "SELECT last_seen_operation_id FROM catalog_discovery WHERE external_id = 'HBC0000AA01'",
        )
      ).rows[0];
      expect(Number(aa01.last_seen_operation_id)).toBe(op.id);

      // Ayni hafta ikinci yenileme: 0070 tetikleyicisi reddeder.
      await expect(
        startDiscoveryOperation(db, admin, {
          source: "hepsiburada",
          kind: "weekly_refresh",
          network: "wifi",
          clientId: A,
        }),
      ).rejects.toMatchObject({ code: "collection_quota_interval" });
      const status = await getDiscoveryStatus(db, admin, "hepsiburada");
      expect(status.canStartRefresh).toBe(false);
      expect(status.refreshQuota.blockedBy).toBe("interval");
    });

    it("istek atilmadan iptal edilen yenileme kotadan dusulur; yarim tarama kaldirma sayilmaz", async () => {
      await legacyRun();
      await completedInitial({ 1: ["HBC0000AA01"] });
      const first = await startDiscoveryOperation(db, admin, {
        source: "hepsiburada",
        kind: "weekly_refresh",
        network: "wifi",
        clientId: A,
      });
      await cancelDiscoveryOperation(db, admin, { operationId: first.id });
      const run = (
        await owner("SELECT status FROM collection_run WHERE id = $1", [first.quotaRunId])
      ).rows[0];
      expect(run.status).toBe("released");

      const second = await startDiscoveryOperation(db, admin, {
        source: "hepsiburada",
        kind: "weekly_refresh",
        network: "wifi",
        clientId: A,
      });
      await planned(second.id, [1]);
      await cancelDiscoveryOperation(db, admin, { operationId: second.id });
      const rows = await owner(
        "SELECT o.removal_state, r.status FROM catalog_sync_operation o JOIN collection_run r ON r.id = o.quota_run_id WHERE o.id = $1",
        [second.id],
      );
      expect(rows.rows[0]).toEqual({ removal_state: "skipped_partial", status: "aborted" });
    });

    it("kota penceresi dolan yenileme 'expired' olur", async () => {
      await legacyRun();
      await completedInitial({ 1: ["HBC0000AA01"] });
      const op = await startDiscoveryOperation(db, admin, {
        source: "hepsiburada",
        kind: "weekly_refresh",
        network: "wifi",
        clientId: A,
      });
      await expect(
        claimDiscoveryUnit(
          db,
          admin,
          { operationId: op.id, clientId: A },
          new Date(Date.now() + 7 * 24 * HOUR),
        ),
      ).rejects.toMatchObject({ code: "operation_closed" });
      const row = (
        await owner("SELECT status, removal_state FROM catalog_sync_operation WHERE id = $1", [
          op.id,
        ])
      ).rows[0];
      expect(row).toEqual({ status: "expired", removal_state: "skipped_partial" });
    });
  });

  it("kapanan operasyon degistirilemez (tetikleyici)", async () => {
    const op = await startDiscoveryOperation(db, admin, {
      source: "hepsiburada",
      kind: "initial_import",
      network: "wifi",
      clientId: A,
    });
    await cancelDiscoveryOperation(db, admin, { operationId: op.id });
    await expect(
      resumeDiscoveryOperation(db, admin, { operationId: op.id, clientId: A }),
    ).rejects.toBeInstanceOf(DiscoveryError);
    await expect(
      withOwnerClient((c) =>
        c.query("UPDATE catalog_sync_operation SET status = 'open' WHERE id = $1", [op.id]),
      ),
    ).rejects.toThrow(/discovery_operation_closed/);
  });

  it("uygulama rolu defterden ve istek kaydindan satir silemez", async () => {
    await expect(
      db.execute("DELETE FROM catalog_discovery WHERE false" as never),
    ).rejects.toThrow();
  });
});
