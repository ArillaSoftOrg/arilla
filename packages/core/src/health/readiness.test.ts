import { describe, expect, it, vi } from "vitest";
import { checkReadiness, createReadinessProbe } from "./readiness.ts";

const ok = () => Promise.resolve("ok");
const boom = (message: string) => () => Promise.reject(new Error(message));

describe("checkReadiness()", () => {
  it("iki bilesen de cevap verirse hazir", async () => {
    const report = await checkReadiness({ database: ok, redis: ok });
    expect(report).toEqual({ ready: true, checks: { database: "ok", redis: "ok" } });
  });

  it("veritabani ya da Redis hata verirse hazir degil, hangisi oldugu bellidir", async () => {
    expect(await checkReadiness({ database: boom("x"), redis: ok })).toEqual({
      ready: false,
      checks: { database: "fail", redis: "ok" },
    });
    expect(await checkReadiness({ database: ok, redis: boom("x") })).toEqual({
      ready: false,
      checks: { database: "ok", redis: "fail" },
    });
  });

  it("yanit hata metnini, adresi ya da parolayi tasimaz", async () => {
    const report = await checkReadiness({
      database: boom("postgres://arilla_app:gizli-parola@db.internal:5432/arilla"),
      redis: boom("redis://:gizli-parola@redis:6379"),
    });
    expect(JSON.stringify(report)).not.toMatch(/gizli|postgres|redis:\/\/|internal/);
  });

  it("takilan bilesen zaman asimiyla fail olur ve sonsuz beklemez", async () => {
    const hang = () => new Promise<never>(() => {});
    const started = Date.now();
    const report = await checkReadiness({ database: hang, redis: ok }, 30);
    expect(report.ready).toBe(false);
    expect(report.checks.database).toBe("fail");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("createReadinessProbe()", () => {
  it("sonucu onbellek suresi icinde yeniden kullanir", async () => {
    let time = 1_000;
    const database = vi.fn(ok);
    const probe = createReadinessProbe(
      { database, redis: ok },
      { cacheMs: 2_000, now: () => time },
    );
    await probe();
    time += 1_999;
    await probe();
    expect(database).toHaveBeenCalledTimes(1);
    time += 2;
    await probe();
    expect(database).toHaveBeenCalledTimes(2);
  });

  it("eszamanli cagrilar tek denetimi paylasir", async () => {
    const database = vi.fn(ok);
    const probe = createReadinessProbe({ database, redis: ok }, { cacheMs: 0 });
    await Promise.all([probe(), probe(), probe()]);
    expect(database).toHaveBeenCalledTimes(1);
  });

  it("basarisiz sonucu da kisa sure onbellekler (cokmus DB'ye saldirmaz)", async () => {
    let time = 0;
    const database = vi.fn(boom("down"));
    const probe = createReadinessProbe(
      { database, redis: ok },
      { cacheMs: 2_000, now: () => time },
    );
    expect((await probe()).ready).toBe(false);
    time += 500;
    expect((await probe()).ready).toBe(false);
    expect(database).toHaveBeenCalledTimes(1);
  });
});
