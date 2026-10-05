import { assertIsolatedTestEnv, assertIsolatedTestUrl, isTestRuntime } from "@arilla/db";
import { describe, expect, it } from "vitest";

describe("test izolasyonu (üretime bağlanmayı engeller)", () => {
  it("yerel adresleri kabul eder", () => {
    for (const url of [
      "postgresql://u:p@localhost:5432/arilla",
      "postgresql://u:p@127.0.0.1:5432/arilla",
      "postgresql://u:p@[::1]:5432/arilla",
      "redis://localhost:6379",
    ]) {
      expect(() => assertIsolatedTestUrl("DATABASE_URL", url)).not.toThrow();
    }
  });

  it("uzak/üretim adreslerini reddeder ve host/parola sızdırmaz", () => {
    const secretHost = "aws-1-eu-west-1.pooler.supabase.com";
    let message = "";
    try {
      assertIsolatedTestUrl(
        "DATABASE_URL",
        `postgresql://postgres.ref:SIR123@${secretHost}:5432/postgres`,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain("SIR123");
    expect(message).not.toContain("supabase.com");
    expect(message).not.toContain("ref");
  });

  it("tanınmayan, boş ve bozuk değerleri reddeder (fail-closed)", () => {
    for (const url of [
      "postgresql://db.example.com/x",
      "not a url",
      "",
      "postgresql://localhost.evil.com/x",
    ]) {
      expect(() => assertIsolatedTestUrl("DATABASE_URL_OWNER", url)).toThrow();
    }
  });

  it("ortam denetimi: tanımlı değişkenlerden biri uzaksa durur", () => {
    expect(() =>
      assertIsolatedTestEnv({ DATABASE_URL: "postgresql://u:p@localhost/x" }),
    ).not.toThrow();
    expect(() =>
      assertIsolatedTestEnv({
        DATABASE_URL: "postgresql://u:p@localhost/x",
        DATABASE_URL_OWNER: "postgresql://u:p@db.prod.example.com/x",
      }),
    ).toThrow();
    expect(() =>
      assertIsolatedTestEnv({ REDIS_URL: "rediss://default:p@remote.upstash.io" }),
    ).toThrow();
  });

  it("vitest altında test çalışma zamanı algılanır", () => {
    expect(isTestRuntime()).toBe(true);
    expect(isTestRuntime({})).toBe(false);
  });
});
