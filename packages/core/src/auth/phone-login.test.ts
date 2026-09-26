import { describe, expect, it } from "vitest";
import { generatePhoneCode, normalizePhoneE164 } from "./phone-login.ts";
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
