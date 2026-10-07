import { describe, expect, it } from "vitest";
import { computeEarlyAccessProgress, EARLY_ACCESS_TARGET } from "./early-access-progress.ts";

describe("computeEarlyAccessProgress", () => {
  it("platform dışı 78 + 0 kayıt: 78 / 5000", () => {
    expect(computeEarlyAccessProgress(78, 0)).toEqual({
      count: 78,
      target: EARLY_ACCESS_TARGET,
      percent: 1.6,
    });
  });

  it("aynı girdi her zaman aynı sonucu verir (rastgelelik/zaman yok)", () => {
    const first = computeEarlyAccessProgress(78, 12);
    for (let i = 0; i < 5; i += 1) expect(computeEarlyAccessProgress(78, 12)).toEqual(first);
  });

  it("yeni gerçek kayıt sayıyı tam 1 artırır", () => {
    const before = computeEarlyAccessProgress(78, 40);
    const after = computeEarlyAccessProgress(78, 41);
    expect(after.count - before.count).toBe(1);
    expect(after.percent).toBeGreaterThanOrEqual(before.percent);
  });

  it("yönetici platform dışı sayıyı artırırsa sayı geri gitmez", () => {
    expect(computeEarlyAccessProgress(90, 5).count).toBeGreaterThan(
      computeEarlyAccessProgress(78, 5).count,
    );
  });

  it("5000 sınırı: üstü gösterilmez, yüzde 100'ü geçmez", () => {
    expect(computeEarlyAccessProgress(78, 4922)).toMatchObject({ count: 5000, percent: 100 });
    expect(computeEarlyAccessProgress(4000, 9000)).toMatchObject({ count: 5000, percent: 100 });
  });

  it("yüzde displayCount / hedef üzerinden, bir ondalıkla", () => {
    expect(computeEarlyAccessProgress(0, 2500).percent).toBe(50);
    expect(computeEarlyAccessProgress(0, 1).percent).toBe(0);
    expect(computeEarlyAccessProgress(0, 5).percent).toBe(0.1);
  });

  it("negatif, kesirli ve sonsuz girdi güvenli ele alınır", () => {
    expect(computeEarlyAccessProgress(-5, 3).count).toBe(3);
    expect(computeEarlyAccessProgress(2.9, 1.2).count).toBe(3);
    expect(computeEarlyAccessProgress(Number.NaN, Number.POSITIVE_INFINITY).count).toBe(0);
  });
});
