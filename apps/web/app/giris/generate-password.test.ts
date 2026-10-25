import { checkPasswordPolicy } from "@arilla/core";
import { describe, expect, it, vi } from "vitest";
import { GENERATED_PASSWORD_LENGTH, generatePassword, randomBelow } from "./generate-password.ts";

const AMBIGUOUS = /[0OIl1o]/;

describe("generatePassword", () => {
  it("20 karakterlik şifre üretir ve backend parola politikasını her zaman karşılar", () => {
    for (let i = 0; i < 500; i++) {
      const password = generatePassword();
      expect(password).toHaveLength(GENERATED_PASSWORD_LENGTH);
      expect(checkPasswordPolicy(password, { email: "kisi@example.test" })).toBeNull();
    }
  });

  it("her üretimde küçük, büyük harf, rakam ve sembol içerir; karışan karakterler yok", () => {
    for (let i = 0; i < 200; i++) {
      const password = generatePassword();
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[2-9]/);
      expect(password).toMatch(/[!@#$%^&*\-_=+?]/);
      expect(password).not.toMatch(AMBIGUOUS);
    }
  });

  it("tekrar etmez (kriptografik rastgelelik)", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassword()));
    expect(seen.size).toBe(500);
  });

  it("Math.random kullanmaz; yalnızca crypto.getRandomValues", () => {
    const math = vi.spyOn(Math, "random");
    const crypto = vi.spyOn(globalThis.crypto, "getRandomValues");
    generatePassword();
    expect(math).not.toHaveBeenCalled();
    expect(crypto).toHaveBeenCalled();
    math.mockRestore();
    crypto.mockRestore();
  });

  it("çok kısa uzunluğu reddeder", () => {
    expect(() => generatePassword(3)).toThrow(RangeError);
  });
});

describe("randomBelow", () => {
  it("modulo yanlılığını önlemek için sınırın üstündeki değerleri atar", () => {
    // max=3: limit 4294967295; 0xffffffff reddedilir, sonraki değer (7) kullanılır.
    const values = [0xffffffff, 7];
    const source = vi.fn((array: Uint32Array) => {
      array[0] = values.shift() as number;
      return array;
    });
    expect(randomBelow(3, source)).toBe(7 % 3);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("geçersiz sınırı reddeder", () => {
    expect(() => randomBelow(0)).toThrow(RangeError);
    expect(() => randomBelow(1.5)).toThrow(RangeError);
  });

  it("sonuç her zaman [0, max) içindedir", () => {
    for (let i = 0; i < 1000; i++) {
      const value = randomBelow(26);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(26);
    }
  });
});
