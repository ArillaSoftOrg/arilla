/**
 * Arama kalitesi günlük özeti (karar 0054), gerçek yerel Postgres:
 * - upsert sayaçları artırır, son değerler güncellenir
 * - kişisel veri içeren sorgu hiç yazılmaz
 * - `recordTextSearchQuality` tanınmayan kelimeleri sözlükten çıkarır
 * - 90 günden eski günler silinir
 * - yönetim listesi: süzgeç, toplam, kelime sıklığı, yetki
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdminActor, AdminForbiddenError } from "../admin/capabilities.ts";
import { listSearchQualityQueries } from "../admin/search-quality.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { purgeSearchQueryDays, recordSearchQuality, recordTextSearchQuality } from "./quality.ts";

// Rakamsiz: "nadirkelime" + rakamli taban-36 parca 16+ karakterlik harf+rakam
// karisimi olur ve kimlik/sir suzgecine (`query-privacy.ts`) takilirdi.
const suffix = Date.now()
  .toString(36)
  .replace(/\d/g, (d) => "abcdefghij"[Number(d)] ?? "x");
const Q = `s2kalite ${suffix} yogamatı`;
const TERM = `nadirkelime${suffix}`;

async function row(queryNorm: string) {
  return withOwnerClient(async (client) => {
    const r = await client.query(
      `SELECT day::text, searches, zero_results, fallbacks, clarifications, last_result_count,
              parser_tier, unrecognized_terms
       FROM search_query_day WHERE query_norm = $1 ORDER BY day`,
      [queryNorm],
    );
    return r.rows;
  });
}

describe("search_query_day - entegrasyon", () => {
  let db: Database;
  let moderator: AdminActor;
  let plainUser: AdminActor;
  let lexiconId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const users = await client.query(
        `INSERT INTO app_user (email, role) VALUES ($1, 'moderator'), ($2, 'user') RETURNING id`,
        [`s2q-mod-${suffix}@test.local`, `s2q-user-${suffix}@test.local`],
      );
      moderator = { userId: Number(users.rows[0].id), role: "moderator" };
      plainUser = { userId: Number(users.rows[1].id), role: "user" };
      const lex = await client.query(
        `INSERT INTO lexicon (kind, surface, normalized) VALUES ('synonym', $1, $1) RETURNING id`,
        [`bilinen${suffix}`],
      );
      lexiconId = Number(lex.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM search_query_day WHERE query_norm LIKE $1", [`%${suffix}%`]);
      await client.query("DELETE FROM lexicon WHERE id = $1", [lexiconId]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [
        [moderator.userId, plainUser.userId],
      ]);
    });
  });

  it("upsert: aynı gün sayaçlar artar, son değerler güncellenir; gün Europe/Istanbul", async () => {
    // 2026-10-02 22:30 UTC = 3 Ekim 01:30 İstanbul.
    const at = new Date("2026-10-02T22:30:00Z");
    const base = {
      queryNorm: Q,
      parserTier: 2,
      clarification: false,
      unrecognizedTerms: ["yogamatı"],
    };
    expect(await recordSearchQuality(db, { ...base, resultCount: 0, usedFallback: true }, at)).toBe(
      "recorded",
    );
    expect(
      await recordSearchQuality(
        db,
        { ...base, resultCount: 5, usedFallback: false, clarification: true },
        new Date(at.getTime() + 60_000),
      ),
    ).toBe("recorded");
    const rows = await row(Q);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: "2026-10-03",
      searches: 2,
      zero_results: 1,
      fallbacks: 1,
      clarifications: 1,
      last_result_count: 5,
      parser_tier: 2,
      unrecognized_terms: ["yogamatı"],
    });
  });

  it("kişisel veri içeren sorgu yazılmaz; sınırlar uygulanır", async () => {
    for (const queryNorm of [
      `ayse${suffix}@ornek.com`,
      `0532 123 45 67 ${suffix}`,
      `https://ornek.com/${suffix}`,
      `siparis 98765432 ${suffix}`,
      `gül sokak no: 5 ${suffix}`,
      `${suffix}${"a".repeat(200)}`,
    ]) {
      expect(
        await recordSearchQuality(db, {
          queryNorm,
          resultCount: 0,
          usedFallback: false,
          clarification: false,
          parserTier: 2,
          unrecognizedTerms: [],
        }),
      ).toBe("skipped");
    }
    const count = await withOwnerClient(async (client) => {
      const r = await client.query(
        "SELECT count(*)::int AS n FROM search_query_day WHERE query_norm LIKE $1 AND query_norm <> $2",
        [`%${suffix}%`, Q],
      );
      return r.rows[0].n;
    });
    expect(count).toBe(0);

    const q2 = `sinir ${suffix}`;
    await recordSearchQuality(db, {
      queryNorm: q2,
      resultCount: -3,
      usedFallback: false,
      clarification: false,
      parserTier: 9,
      unrecognizedTerms: [
        "a".repeat(41),
        "bir",
        "bir",
        "x@y",
        ...Array.from({ length: 12 }, (_, i) => `k${i}`),
      ],
    });
    const [r] = await row(q2);
    expect(r.last_result_count).toBe(0);
    expect(r.zero_results).toBe(1);
    expect(r.parser_tier).toBeNull();
    expect(r.unrecognized_terms).toHaveLength(8);
    expect(r.unrecognized_terms[0]).toBe("bir");
    expect(r.unrecognized_terms).not.toContain("x@y");
  });

  it("recordTextSearchQuality: normalize eder, sözlükteki kelimeyi tanınmayan saymaz", async () => {
    const text = `  BİLİNEN${suffix}   ${TERM.toLocaleUpperCase("tr-TR")} `;
    expect(
      await recordTextSearchQuality(db, {
        query: text,
        resultCount: 0,
        usedFallback: false,
        clarification: false,
        parserTier: 2,
      }),
    ).toBe("recorded");
    const [r] = await row(`bilinen${suffix} ${TERM}`);
    expect(r.unrecognized_terms).toEqual([TERM]);
    expect(
      await recordTextSearchQuality(db, {
        query: `ara beni 0555 444 33 22 ${suffix}`,
        resultCount: 1,
        usedFallback: false,
        clarification: false,
        parserTier: 2,
      }),
    ).toBe("skipped");
  });

  it("listSearchQualityQueries: süzgeçler, kelime sıklığı, yetki", async () => {
    const zero = await listSearchQualityQueries(db, moderator, { days: 7, kind: "zero" });
    expect(zero.days).toBe(7);
    expect(zero.rows.map((r) => r.queryNorm)).toContain(`bilinen${suffix} ${TERM}`);
    expect(zero.terms.map((t) => t.term)).toContain(TERM);
    expect(zero.totals.searches).toBeGreaterThan(0);

    const unrec = await listSearchQualityQueries(db, moderator, { days: 30, kind: "unrecognized" });
    expect(unrec.rows.every((r) => r.unrecognizedTerms.length > 0)).toBe(true);

    // Geçersiz girdi varsayılana düşer, SQL'e girmez.
    const fallback = await listSearchQualityQueries(db, moderator, {
      days: 9999,
      kind: "x; DROP TABLE lexicon",
      page: -4,
    });
    expect(fallback).toMatchObject({ days: 7, kind: "zero", page: 1 });

    await expect(listSearchQualityQueries(db, plainUser, {})).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
  });

  it("purgeSearchQueryDays: 90 günden eskiyi siler, sınırdakini tutar", async () => {
    const old = `eski ${suffix}`;
    const edge = `sinirda ${suffix}`;
    await withOwnerClient(async (client) => {
      await client.query(
        `INSERT INTO search_query_day (day, query_norm, searches) VALUES ('2026-07-04', $1, 1), ('2026-07-05', $2, 1)`,
        [old, edge],
      );
    });
    // 3 Ekim 2026 İstanbul - 90 gün = 5 Temmuz 2026.
    const deleted = await purgeSearchQueryDays(db, new Date("2026-10-03T09:00:00Z"));
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await row(old)).toHaveLength(0);
    expect(await row(edge)).toHaveLength(1);
  });
});
