import type { Database } from "@arilla/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicTrends, getTrendBySlug } from "./get-trends.ts";
import {
  isTrendSchemaMissing,
  resetTrendSchemaWarning,
  warnTrendSchemaMissing,
} from "./schema-guard.ts";

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** drizzle sarmalayicisi: `Failed query` -> cause = pg hatasi. */
function wrapped(code: string, message: string): Error {
  return Object.assign(new Error("Failed query: select ..."), {
    cause: pgError(code, message),
  });
}

describe("isTrendSchemaMissing", () => {
  it("eksik trend / trend_product iliskisini tanir (dogrudan ve cause zincirinde)", () => {
    expect(isTrendSchemaMissing(pgError("42P01", 'relation "trend" does not exist'))).toBe(true);
    expect(isTrendSchemaMissing(wrapped("42P01", 'relation "trend_product" does not exist'))).toBe(
      true,
    );
  });

  it("baska tablonun eksikligini maskelemez", () => {
    expect(isTrendSchemaMissing(wrapped("42P01", 'relation "product" does not exist'))).toBe(false);
    expect(isTrendSchemaMissing(wrapped("42P01", 'relation "trend_snapshot" does not exist'))).toBe(
      false,
    );
  });

  it("baska hata kodlarini ve hata olmayanlari maskelemez", () => {
    expect(isTrendSchemaMissing(wrapped("28P01", "password authentication failed"))).toBe(false);
    expect(isTrendSchemaMissing(wrapped("42703", 'column "x" does not exist'))).toBe(false);
    expect(isTrendSchemaMissing(wrapped("57014", "canceling statement due to timeout"))).toBe(
      false,
    );
    expect(isTrendSchemaMissing('relation "trend" does not exist')).toBe(false);
    expect(isTrendSchemaMissing(null)).toBe(false);
  });
});

describe("getPublicTrends / getTrendBySlug: eksik sema", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetTrendSchemaWarning();
  });

  const missing = wrapped("42P01", 'relation "trend" does not exist');
  const failing = (error: Error) =>
    ({
      execute: async () => {
        throw error;
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              throw error;
            },
          }),
        }),
      }),
    }) as unknown as Database;

  it("sema yoksa bos liste / null doner ve uyari loglar", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getPublicTrends(failing(missing))).toEqual([]);
    expect(await getTrendBySlug(failing(missing), "kuru-ciltlere-son")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1); // dakikada en cok bir kez
    expect(String(warn.mock.calls[0]?.[0])).toContain("trend semasi yok");
  });

  it("genel veritabani hatasi firlatilir (bos durum gibi gosterilmez)", async () => {
    const other = wrapped("28P01", "password authentication failed");
    await expect(getPublicTrends(failing(other))).rejects.toThrow();
    await expect(getTrendBySlug(failing(other), "x")).rejects.toThrow();
  });

  it("uyari kisitlayicisi zamanla yeniden yazar", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnTrendSchemaMissing(1_000_000);
    warnTrendSchemaMissing(1_030_000);
    warnTrendSchemaMissing(1_070_000);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
