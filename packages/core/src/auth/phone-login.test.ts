import type { Database } from "@arilla/db";
import { describe, expect, it } from "vitest";
import {
  allowedPhoneCountryCodes,
  generatePhoneCode,
  InvalidPhoneNumberError,
  isAllowedPhoneCountry,
  normalizePhoneE164,
  PhoneCodeInvalidError,
  requestPhoneLoginCode,
  signInWithPhone,
  UnsupportedPhoneCountryError,
} from "./phone-login.ts";
import { DevSmsSender, getSmsSender, maskPhone, SmsUnavailableError } from "./sms.ts";

describe("normalizePhoneE164", () => {
  it.each([
    ["0532 123 45 67", "+905321234567"],
    ["532 123 45 67", "+905321234567"],
    ["+90 (532) 123-45-67", "+905321234567"],
    ["0090 532 123 45 67", "+905321234567"],
    ["05321234567", "+905321234567"],
    ["+44 20 7946 0958", "+442079460958"],
  ])("normalizes %s", (raw, expected) => {
    expect(normalizePhoneE164(raw)).toBe(expected);
  });

  it.each(["", "abc", "123", "+90 532 123", "+9053212345678", "0532-123-45-67-89", "+0123456789"])(
    "rejects %j",
    (raw) => {
      expect(normalizePhoneE164(raw)).toBeNull();
    },
  );
});

describe("phone country allowlist", () => {
  it("defaults to Turkey only", () => {
    expect(allowedPhoneCountryCodes({})).toEqual(["90"]);
    expect(allowedPhoneCountryCodes({ PHONE_ALLOWED_COUNTRY_CODES: "  " })).toEqual(["90"]);
    expect(isAllowedPhoneCountry("+905321234567", {})).toBe(true);
    expect(isAllowedPhoneCountry("+442079460958", {})).toBe(false);
    expect(isAllowedPhoneCountry("+12025550123", {})).toBe(false);
  });

  it("reads an explicit comma separated list", () => {
    const env = { PHONE_ALLOWED_COUNTRY_CODES: "90, +44" };
    expect(allowedPhoneCountryCodes(env)).toEqual(["90", "44"]);
    expect(isAllowedPhoneCountry("+442079460958", env)).toBe(true);
    expect(isAllowedPhoneCountry("+4915112345678", env)).toBe(false);
  });

  it("fails closed when the configured list has no valid code", () => {
    const env = { PHONE_ALLOWED_COUNTRY_CODES: "abc,0,1234" };
    expect(allowedPhoneCountryCodes(env)).toEqual([]);
    expect(isAllowedPhoneCountry("+905321234567", env)).toBe(false);
  });

  it("rejects an unsupported country before touching the database or sending SMS", async () => {
    const sender = new DevSmsSender();
    let rateLimitChecked = false;
    // Veritabani hic kullanilmamali: erisilirse test patlar.
    const db = new Proxy({} as Database, {
      get() {
        throw new Error("veritabanina erisilmemeliydi");
      },
    });
    const attempt = requestPhoneLoginCode(db, { phone: "+44 20 7946 0958", ip: null }, sender, {
      checkRateLimit: async () => {
        rateLimitChecked = true;
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(UnsupportedPhoneCountryError);
    await expect(attempt).rejects.toBeInstanceOf(InvalidPhoneNumberError);
    expect(rateLimitChecked).toBe(false);
    expect(sender.outbox).toHaveLength(0);
  });

  it("rejects verification for an unsupported country", async () => {
    const db = new Proxy({} as Database, {
      get() {
        throw new Error("veritabanina erisilmemeliydi");
      },
    });
    await expect(
      signInWithPhone(
        db,
        { phone: "+442079460958", code: "123456", ip: null, userAgent: null },
        { checkRateLimit: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(PhoneCodeInvalidError);
  });
});

describe("generatePhoneCode", () => {
  it("is always six digits", () => {
    for (let i = 0; i < 200; i++) expect(generatePhoneCode()).toMatch(/^\d{6}$/);
  });
});

describe("sms sender", () => {
  it("uses the dev sender outside production", () => {
    expect(getSmsSender({ NODE_ENV: "development" })).toBeInstanceOf(DevSmsSender);
  });

  it("fails closed in production without a provider", () => {
    expect(() => getSmsSender({ NODE_ENV: "production" })).toThrow(SmsUnavailableError);
    expect(() => getSmsSender({ NODE_ENV: "production", SMS_PROVIDER: "dev" })).toThrow(
      SmsUnavailableError,
    );
  });

  it("masks the number in log lines", () => {
    expect(maskPhone("+905321234567")).toBe("+90532***4567");
  });
});
