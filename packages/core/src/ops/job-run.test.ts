/** Karar 0055: iş koşusu kaydının kırpma ve sınırları (saf). */
import { describe, expect, it } from "vitest";
import { boundedJobDetail, JOB_ERROR_SUMMARY_MAX, redactJobError } from "./job-run.ts";

describe("redactJobError", () => {
  it("adresten kimlik bilgisi, yol ve sorgu dizisini atar; ana makine kalır", () => {
    const out = redactJobError(
      "connect postgresql://arilla:s3cret@db.internal:5432/arilla?sslmode=require failed; feed https://shop.example.com/f.xml?token=abc",
    );
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("f.xml");
    expect(out).toContain("postgresql://db.internal:5432/…");
    expect(out).toContain("https://shop.example.com/…");
  });

  it("e-posta ve anahtar=değer sırlarını maskeler, uzunluğu sınırlar", () => {
    const out = redactJobError(`ayse@example.com password=hunter2 ${"x".repeat(900)}`);
    expect(out).not.toContain("ayse@example.com");
    expect(out).not.toContain("hunter2");
    expect(out?.length).toBeLessThanOrEqual(JOB_ERROR_SUMMARY_MAX);
    expect(redactJobError("")).toBeNull();
    expect(redactJobError(null)).toBeNull();
  });
});

describe("boundedJobDetail", () => {
  it("düz sayılar kalır, bir düzey nesne düzleşir, dizi ve derin yapı atılır", () => {
    expect(
      boundedJobDetail({
        authTokens: 3,
        truncated: false,
        retention: { authEventsDeleted: 2, deep: { x: 1 } },
        list: [1, 2],
        bad: Number.NaN,
        url: "https://x.example/a?b=c",
      }),
    ).toEqual({
      authTokens: 3,
      truncated: false,
      retention_authEventsDeleted: 2,
      url: "https://x.example/…",
    });
  });

  it("boyutu ve anahtar sayısını sınırlar; nesne olmayan girdi boş", () => {
    const big = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`k${i}`, "y".repeat(120)]),
    );
    const out = boundedJobDetail(big);
    expect(Object.keys(out).length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(3000);
    expect(boundedJobDetail(null)).toEqual({});
    expect(boundedJobDetail([1, 2])).toEqual({});
  });
});
