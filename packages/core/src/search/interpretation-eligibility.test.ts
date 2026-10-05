import { describe, expect, it } from "vitest";
import {
  INTERPRETATION_MIN_OCCURRENCES,
  interpretationIneligibility,
  isEligibleForInterpretation,
} from "./interpretation-eligibility.ts";

const ok = (queryNorm: string, occurrences = 5) => ({ queryNorm, occurrences });

describe("yorum adayi uygunlugu", () => {
  it("esik en az 3 arama", () => {
    expect(INTERPRETATION_MIN_OCCURRENCES).toBe(3);
    expect(interpretationIneligibility(ok("bisiklet kaski", 2))).toBe("too_few");
    expect(interpretationIneligibility(ok("bisiklet kaski", 0))).toBe("too_few");
    expect(interpretationIneligibility(ok("bisiklet kaski", 3))).toBeNull();
    expect(interpretationIneligibility({ queryNorm: "kask", occurrences: "5" })).toBe("too_few");
    expect(interpretationIneligibility({ queryNorm: "kask", occurrences: 3.5 })).toBe("too_few");
  });

  it.each([
    "bisiklet kaski",
    "kablosuz-bluetooth-kulaklik",
    "iphone15promax kilif",
    "42 numara kosu ayakkabisi 2000 tl alti",
    "skechers spor ayakkabi",
    "babama hediye",
  ])("normal toplu sorgu kabul: %s", (q) => {
    expect(isEligibleForInterpretation(ok(q))).toBe(true);
  });

  it("yalnizca normalize sorgu", () => {
    expect(interpretationIneligibility(ok("  Kask  "))).toBe("not_normalized");
    expect(interpretationIneligibility(ok("kask  siyah"))).toBe("not_normalized");
    expect(interpretationIneligibility({ queryNorm: 42, occurrences: 5 })).toBe("not_normalized");
  });

  it("uzunluk sinirlari", () => {
    expect(interpretationIneligibility(ok("k"))).toBe("length");
    expect(interpretationIneligibility(ok("a".repeat(121)))).toBe("length");
  });

  it.each(["ali.veli@ornek.com", "mail ali@x kask", "https://site.com/urun", "www.ornek.com.tr"])(
    "e-posta/URL reddedilir: %s",
    (q) => {
      expect(interpretationIneligibility(ok(q))).toBe("personal_data");
    },
  );

  it.each(["0532 123 45 67", "+90 532 123 45 67", "(212) 555-12-34", "kask 05321234567"])(
    "telefon benzeri reddedilir: %s",
    (q) => {
      expect(interpretationIneligibility(ok(q))).not.toBeNull();
    },
  );

  it.each([
    ["12345678901", "personal_data"],
    ["tc 123 456 789 01", "id_like"],
    ["siparis 1234 5678 99", "id_like"],
  ])("uzun rakam/kimlik benzeri reddedilir: %s", (q, reason) => {
    expect(interpretationIneligibility(ok(q))).toBe(reason);
  });

  it.each([
    "sk-proj-abc123def456",
    "ghp_abcdefghijkl12",
    "xoxb-123456-abcdef",
    "aizasyabcdefghijklmnopqrstuvw",
    "eyjhbgcioijiuzi1niis",
    "password=hunter2",
    "sifre: gizli123",
    "şifre: gizli",
    "api key = abcdef",
    "token: abc",
    "a1b2c3d4xyzwqrstuv",
    "deadbeefcafebabe0011",
    "x7k9p2m4q8r1t5w3",
  ])("sir/token benzeri reddedilir: %s", (q) => {
    expect(interpretationIneligibility(ok(q))).toBe("secret_like");
  });
});
