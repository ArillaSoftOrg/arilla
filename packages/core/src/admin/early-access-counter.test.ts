import { describe, expect, it } from "vitest";
import {
  COUNTER_REASON_MAX,
  EarlyAccessCounterValidationError,
  parseCounterUpdate,
  setOffPlatformCount,
} from "./early-access-counter.ts";

describe("parseCounterUpdate", () => {
  it("geçerli sayı ve gerekçeyi kabul eder, boşlukları kırpar", () => {
    expect(parseCounterUpdate(" 90 ", "  E-postayla gelen 12 başvuru, 6 Ekim ")).toEqual({
      count: 90,
      reason: "E-postayla gelen 12 başvuru, 6 Ekim",
    });
    expect(parseCounterUpdate(0, "Sayaç sıfırlandı")).toMatchObject({ count: 0 });
  });

  it.each(["", "-1", "1.5", "abc", "1e3", "1000001", "12345678", null, undefined, {}])(
    "geçersiz sayıyı reddeder: %j",
    (value) => {
      expect(() => parseCounterUpdate(value, "Geçerli gerekçe")).toThrow(
        EarlyAccessCounterValidationError,
      );
    },
  );

  it("gerekçe zorunlu: kısa, boş ve çok uzun reddedilir", () => {
    for (const reason of ["", "   ", "abc", "x".repeat(COUNTER_REASON_MAX + 1), 5, null]) {
      expect(() => parseCounterUpdate(80, reason)).toThrow(EarlyAccessCounterValidationError);
    }
  });
});

describe("setOffPlatformCount yetki", () => {
  it("moderatör ve normal kullanıcı veritabanına dokunmadan reddedilir", async () => {
    const neverCalled = new Proxy({}, { get: () => () => Promise.reject(new Error("db")) });
    for (const role of ["moderator", "user", "creator"] as const) {
      await expect(
        setOffPlatformCount(neverCalled as never, { userId: 1, role }, 80, "Geçerli gerekçe"),
      ).rejects.toThrow();
    }
  });
});
