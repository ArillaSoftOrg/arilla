import { describe, expect, it } from "vitest";
import { normalizeQueryText } from "./normalize.ts";
import { identifierOrSecretReason } from "./query-privacy.ts";

const reason = (raw: string) => identifierOrSecretReason(normalizeQueryText(raw));

describe("identifierOrSecretReason", () => {
  it.each([
    ["bolunmus kimlik", "tc 123 456 789 01"],
    ["bolunmus siparis no", "siparis 1234 5678 99"],
    ["spec yogun (9 rakam, bilinen yanlis pozitif)", "iphone 15 pro max 256 gb 2024"],
  ])("id_like: %s", (_label, raw) => {
    expect(reason(raw)).toBe("id_like");
  });

  it.each([
    ["AIza anahtari", "AIzaSyD-abcdefghijklmnopqrstuvwxyz12"],
    ["sk- anahtari", "sk-proj_abcdefgh"],
    ["ghp_ anahtari", "ghp_abcdefghij"],
    ["password=", "password=hunter2"],
    ["şifre:", "şifre: Gizli123"],
    ["api key", "api key: xyz"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"],
    ["uzun onaltilik", "deadbeefcafebabe0042"],
    ["uzun karisik parca", "galaxys24ultra512gb"],
  ])("secret_like: %s", (_label, raw) => {
    expect(reason(raw)).toBe("secret_like");
  });

  it.each([
    "siyah elbise",
    "iphone 15 pro max kılıf",
    "nike air force 1 42 numara",
    "samsung galaxy s24 ultra 512 gb",
    "rtx 4090 ekran kartı 24gb",
    "skechers koşu ayakkabısı",
    "iphone15promax",
    "sm-s928bzkctur",
    "hamile pantolonu",
    "",
  ])("kimlik/sir degil: %s", (raw) => {
    expect(reason(raw)).toBeNull();
  });
});
