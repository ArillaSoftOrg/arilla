import { describe, expect, it } from "vitest";
import { isRetryableRace, isUniqueViolation, retryOnUniqueViolation } from "./unique-race.ts";

const pgUnique = Object.assign(new Error("duplicate key"), { code: "23505" });
const pgDeadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });

describe("isUniqueViolation", () => {
  it("recognizes a pg error directly or wrapped in cause", () => {
    expect(isUniqueViolation(pgUnique)).toBe(true);
    expect(isUniqueViolation(new Error("query failed", { cause: pgUnique }))).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error("fk"), { code: "23503" }))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe("retryOnUniqueViolation", () => {
  it("retries once after a unique violation", async () => {
    let calls = 0;
    const result = await retryOnUniqueViolation(async () => {
      calls += 1;
      if (calls === 1) throw pgUnique;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries a deadlock (rolled-back transaction) too", async () => {
    let calls = 0;
    const result = await retryOnUniqueViolation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("query failed", { cause: pgDeadlock });
      if (calls === 2) throw pgUnique;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(isRetryableRace(pgDeadlock)).toBe(true);
    expect(isUniqueViolation(pgDeadlock)).toBe(false);
  });

  it("gives up after the retry budget and rethrows", async () => {
    let calls = 0;
    await expect(
      retryOnUniqueViolation(async () => {
        calls += 1;
        throw pgUnique;
      }),
    ).rejects.toBe(pgUnique);
    expect(calls).toBe(3);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    const other = new Error("boom");
    await expect(
      retryOnUniqueViolation(async () => {
        calls += 1;
        throw other;
      }),
    ).rejects.toBe(other);
    expect(calls).toBe(1);
  });
});
