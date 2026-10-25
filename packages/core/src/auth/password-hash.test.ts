import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  burnPasswordVerification,
  DEFAULT_ARGON2_PARAMS,
  hashPassword,
  parsePasswordHash,
  passwordNeedsRehash,
  verifyPassword,
} from "./password-hash.ts";

describe("password-hash (Argon2id)", () => {
  it("PHC dizgisi üretir, her seferinde farklı tuz kullanır ve düz metni içermez", async () => {
    const a = await hashPassword("Mavi-Kedi-Pazar-42");
    const b = await hashPassword("Mavi-Kedi-Pazar-42");
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[\w-]+\$[\w-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("Mavi-Kedi");
  });

  it("doğru şifreyi kabul eder, yanlışı reddeder", async () => {
    const hash = await hashPassword("Mavi-Kedi-Pazar-42");
    expect(await verifyPassword("Mavi-Kedi-Pazar-42", hash)).toBe(true);
    expect(await verifyPassword("Mavi-Kedi-Pazar-43", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("NFKC normalizasyonu: aynı parolanın farklı kod noktası biçimleri eşleşir", async () => {
    const hash = await hashPassword("Şifre-Özel-123"); // birleşik karakterler
    expect(await verifyPassword("Şifre-Özel-123", hash)).toBe(true); // ayrışık (S + cedilla)
  });

  it("bozuk ya da desteklenmeyen özet false döner, hata fırlatmaz", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "$bcrypt$12$abc")).toBe(false);
    expect(await verifyPassword("x", "$argon2id$v=19$m=19456,t=2,p=1$ab$cd")).toBe(false);
  });

  it("aşırı bellek/geçiş isteyen özeti reddeder (hizmet reddi koruması)", () => {
    const salt = "c29tZXNhbHRzb21lc2FsdA";
    const tag = "c29tZWhhc2hzb21laGFzaHNvbWVoYXNoc29tZWhhc2g";
    expect(parsePasswordHash(`$argon2id$v=19$m=4194304,t=2,p=1$${salt}$${tag}`)).toBeNull();
    expect(parsePasswordHash(`$argon2id$v=19$m=19456,t=500,p=1$${salt}$${tag}`)).toBeNull();
    expect(parsePasswordHash(`$argon2id$v=19$m=19456,t=2,p=1$${salt}$${tag}`)).not.toBeNull();
  });

  it("parametreler varsayılanın altındaysa yeniden özetlenmesi gerekir", async () => {
    const weak = await hashPassword("Mavi-Kedi-Pazar-42", {
      memory: 8192,
      passes: 1,
      parallelism: 1,
    });
    expect(passwordNeedsRehash(weak)).toBe(true);
    expect(passwordNeedsRehash(await hashPassword("Mavi-Kedi-Pazar-42"))).toBe(false);
    expect(passwordNeedsRehash("bozuk")).toBe(true);
    expect(DEFAULT_ARGON2_PARAMS.memory).toBeGreaterThanOrEqual(19_456);
  });

  it("burnPasswordVerification hata fırlatmadan tamamlanır", async () => {
    await expect(burnPasswordVerification("herhangi bir sey")).resolves.toBeUndefined();
  });

  it("Argon2id parametreleri OWASP alt sınırının altına düşmez ve tuz/özet boyutları yeterlidir", async () => {
    // OWASP Password Storage Cheat Sheet: Argon2id, en az 19 MiB, 2 geçiş, 1 kulvar.
    expect(DEFAULT_ARGON2_PARAMS.memory).toBeGreaterThanOrEqual(19_456);
    expect(DEFAULT_ARGON2_PARAMS.passes).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_ARGON2_PARAMS.parallelism).toBe(1);
    const parsed = parsePasswordHash(await hashPassword("Mavi-Kedi-Pazar-42"));
    expect(parsed?.salt.length).toBeGreaterThanOrEqual(16);
    expect(parsed?.tag.length).toBeGreaterThanOrEqual(32);
  });

  it("kaynakta sabit zamanlı karşılaştırma kullanılır ve auth dosyaları şifre/token loglamaz", () => {
    const read = (name: string) =>
      readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
    expect(read("./password-hash.ts")).toContain("timingSafeEqual");
    for (const name of ["./password-hash.ts", "./email-password.ts", "./password-policy.ts"]) {
      const logLines = read(name)
        .split(String.fromCharCode(10))
        .filter((line) => /console\.(log|info|warn|error|debug)/.test(line));
      for (const line of logLines) {
        // Yalnızca hata kodu loglanabilir; şifre, özet ya da token değil.
        expect(line, `${name}: ${line}`).not.toMatch(/password|hash|rawToken|token/i);
      }
    }
  });
});
