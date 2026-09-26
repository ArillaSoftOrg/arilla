import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { type AdminActor, AdminForbiddenError } from "./capabilities.ts";
import {
  deleteLexiconEntry,
  LexiconValidationError,
  listLexicon,
  recentTier3Queries,
  upsertLexiconEntry,
} from "./lexicon.ts";

describe("sözlük yönetimi - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  const surface = `admin-lexicon-test-yuzey-${suffix}`;
  const cacheProbeQueryNorm = `admin-lexicon-test-cache-probe-${suffix}`;
  const tier3QueryNorm = `admin-lexicon-test-tier3-${suffix}`;
  const tier2QueryNorm = `admin-lexicon-test-tier2-${suffix}`;
  let insertedId = 0;
  let moderator: AdminActor;

  const auditActions = (id: number) =>
    withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT action, before, after FROM admin_audit_event
          WHERE target_type = 'lexicon' AND target_id = $1 ORDER BY id`,
        [String(id)],
      );
      return res.rows;
    });

  beforeAll(async () => {
    db = getTestDb();
    moderator = await withOwnerClient(async (client) => {
      const res = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'moderator') RETURNING id",
        [`admin-lexicon-mod-${suffix}@test.local`],
      );
      return { userId: Number(res.rows[0].id), role: "moderator" as const };
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = $1", [
        moderator.userId,
      ]);
      await client.query("DELETE FROM app_user WHERE id = $1", [moderator.userId]);
      await client.query("DELETE FROM lexicon WHERE surface = $1", [surface]);
      await client.query("DELETE FROM query_resolution WHERE query_norm = ANY($1)", [
        [cacheProbeQueryNorm, tier3QueryNorm, tier2QueryNorm],
      ]);
    });
  });

  it("upsertLexiconEntry: id verilmeden ekler, sonra id ile günceller", async () => {
    await upsertLexiconEntry(db, moderator, {
      kind: "category",
      surface,
      normalized: "admin-lexicon-test/once",
      weight: 0.5,
    });

    const afterInsert = await listLexicon(db, { search: surface });
    expect(afterInsert).toHaveLength(1);
    expect(afterInsert[0]?.normalized).toBe("admin-lexicon-test/once");
    insertedId = afterInsert[0]!.id;

    await upsertLexiconEntry(db, moderator, {
      id: insertedId,
      kind: "category",
      surface,
      normalized: "admin-lexicon-test/sonra",
      weight: 0.9,
    });

    const afterUpdate = await listLexicon(db, { kind: "category", search: surface });
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0]?.id).toBe(insertedId);
    expect(afterUpdate[0]?.normalized).toBe("admin-lexicon-test/sonra");
    expect(afterUpdate[0]?.weight).toBeCloseTo(0.9);

    const audit = await auditActions(insertedId);
    expect(audit.map((row) => row.action)).toEqual(["lexicon.create", "lexicon.update"]);
    expect(audit[0].before).toBeNull();
    expect(audit[1].before.normalized).toBe("admin-lexicon-test/once");
    expect(audit[1].after.normalized).toBe("admin-lexicon-test/sonra");
  });

  it("upsertLexiconEntry: aynı (kind, surface) ile id vermeden çağrılırsa çakışan satırı günceller", async () => {
    await upsertLexiconEntry(db, moderator, {
      kind: "category",
      surface,
      normalized: "admin-lexicon-test/cakisma",
      weight: 0.7,
    });

    const rows = await listLexicon(db, { search: surface });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(insertedId);
    expect(rows[0]?.normalized).toBe("admin-lexicon-test/cakisma");
  });

  it("listLexicon: kind eşleşmeyince boş döner", async () => {
    const rows = await listLexicon(db, { kind: "brand", search: surface });
    expect(rows).toHaveLength(0);
  });

  it("upsertLexiconEntry: query_resolution önbelleğini temizler (docs/pages.md: 'aramayı anında etkiliyor')", async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        `INSERT INTO query_resolution (query_norm, parsed, parser_tier)
         VALUES ($1, '{}'::jsonb, 2)`,
        [cacheProbeQueryNorm],
      );
    });

    const beforeUpsert = await withOwnerClient(async (client) => {
      const res = await client.query("SELECT 1 FROM query_resolution WHERE query_norm = $1", [
        cacheProbeQueryNorm,
      ]);
      return res.rowCount;
    });
    expect(beforeUpsert).toBe(1);

    await upsertLexiconEntry(db, moderator, {
      kind: "category",
      surface,
      normalized: "admin-lexicon-test/cache-tetikleyici",
      weight: 0.6,
    });

    const afterUpsert = await withOwnerClient(async (client) => {
      const res = await client.query("SELECT 1 FROM query_resolution WHERE query_norm = $1", [
        cacheProbeQueryNorm,
      ]);
      return res.rowCount;
    });
    expect(afterUpsert).toBe(0);
  });

  it("recentTier3Queries: yalnızca parser_tier=3 ve son 7 gün içindeki satırları döner", async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        `INSERT INTO query_resolution (query_norm, parsed, parser_tier, hit_count, last_used_at)
         VALUES ($1, '{}'::jsonb, 3, 4, now())`,
        [tier3QueryNorm],
      );
      await client.query(
        `INSERT INTO query_resolution (query_norm, parsed, parser_tier, hit_count, last_used_at)
         VALUES ($1, '{}'::jsonb, 2, 9, now())`,
        [tier2QueryNorm],
      );
    });

    const rows = await recentTier3Queries(db, 100);
    expect(rows.some((row) => row.queryNorm === tier3QueryNorm)).toBe(true);
    expect(rows.some((row) => row.queryNorm === tier2QueryNorm)).toBe(false);
  });

  it("girdi doğrulanır: geçersiz tür, boş/uzun yüzey, NaN/negatif ağırlık reddedilir", async () => {
    const base = { kind: "category" as const, surface, normalized: "x", weight: 1 };
    const cases = [
      { ...base, kind: "renk" as never },
      { ...base, surface: "   " },
      { ...base, surface: "a".repeat(81) },
      { ...base, normalized: "" },
      { ...base, weight: Number.NaN },
      { ...base, weight: Number.POSITIVE_INFINITY },
      { ...base, weight: -1 },
      { ...base, id: 1.5 },
    ];
    for (const input of cases) {
      await expect(upsertLexiconEntry(db, moderator, input)).rejects.toBeInstanceOf(
        LexiconValidationError,
      );
    }
    const rows = await listLexicon(db, { search: surface });
    expect(rows[0]?.normalized).toBe("admin-lexicon-test/cache-tetikleyici");
  });

  it("yetkisiz aktör yazamaz ve silemez", async () => {
    const creator: AdminActor = { userId: moderator.userId, role: "creator" };
    await expect(
      upsertLexiconEntry(db, creator, { kind: "category", surface, normalized: "x" }),
    ).rejects.toBeInstanceOf(AdminForbiddenError);
    await expect(deleteLexiconEntry(db, creator, insertedId)).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
  });

  it("var olmayan id ile güncelleme found:false döner, satır eklenmez", async () => {
    const result = await upsertLexiconEntry(db, moderator, {
      id: 999_999_999,
      kind: "category",
      surface: `${surface}-yok`,
      normalized: "x",
    });
    expect(result.found).toBe(false);
    expect(await listLexicon(db, { search: `${surface}-yok` })).toHaveLength(0);
  });

  it("listLexicon sınırlıdır: limit üst sınırı uygulanır", async () => {
    const rows = await listLexicon(db, { limit: 10_000 });
    expect(rows.length).toBeLessThanOrEqual(200);
  });

  it("deleteLexiconEntry: siler, önbelleği temizler, önceki değeri denetime yazar", async () => {
    const result = await deleteLexiconEntry(db, moderator, insertedId);
    expect(result.found).toBe(true);
    expect(await listLexicon(db, { search: surface })).toHaveLength(0);

    const audit = await auditActions(insertedId);
    const last = audit[audit.length - 1];
    expect(last.action).toBe("lexicon.delete");
    expect(last.before.surface).toBe(surface);
    expect(last.after).toBeNull();

    expect((await deleteLexiconEntry(db, moderator, insertedId)).found).toBe(false);
  });
});
