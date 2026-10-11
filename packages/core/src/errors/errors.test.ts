import { describe, expect, it, vi } from "vitest";
import {
  buildErrorLog,
  classifyError,
  describeError,
  ERROR_CATALOG,
  ERROR_CODES,
  newErrorReference,
  reportError,
  scrubMessage,
} from "./index.ts";

function named(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const error = Object.assign(new Error(message), extra);
  error.name = name;
  return error;
}

describe("classifyError()", () => {
  it("Supabase EMAXCONNSESSION -> db_capacity (sarilmis cause dahil)", () => {
    const driver = new Error(
      "(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15",
    );
    expect(classifyError(driver)).toBe("db_capacity");
    expect(classifyError(new Error("Failed query: select 1", { cause: driver }))).toBe(
      "db_capacity",
    );
  });

  it("Postgres 53300 -> db_capacity", () => {
    expect(classifyError(Object.assign(new Error("x"), { code: "53300" }))).toBe("db_capacity");
  });

  it("baglanti hatalari -> db_unavailable", () => {
    expect(classifyError(new Error("Connection terminated unexpectedly"))).toBe("db_unavailable");
    expect(classifyError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(
      "db_unavailable",
    );
    expect(classifyError(new Error("timeout exceeded when trying to connect"))).toBe(
      "db_unavailable",
    );
  });

  it("Failed to find Server Action ve chunk hatasi -> deployment_mismatch", () => {
    expect(classifyError(new Error('Failed to find Server Action "abc123".'))).toBe(
      "deployment_mismatch",
    );
    expect(classifyError(named("ChunkLoadError", "Loading chunk 4 failed."))).toBe(
      "deployment_mismatch",
    );
  });

  it("LlmError kodlari", () => {
    expect(classifyError(named("LlmError", "x", { code: "rate_limited" }))).toBe("ai_rate_limited");
    expect(classifyError(named("LlmError", "x", { code: "timeout" }))).toBe("ai_timeout");
    expect(classifyError(named("LlmError", "x", { code: "server_error" }))).toBe("ai_unavailable");
    expect(classifyError(named("LlmError", "x", { code: "invalid_json" }))).toBe("ai_bad_response");
  });

  it("Redis erisilemiyor -> cache_unavailable; AbortError -> request_timeout", () => {
    expect(classifyError(named("RedisUnavailableError", "redis erisilemedi: get"))).toBe(
      "cache_unavailable",
    );
    expect(classifyError(named("AbortError", "aborted"))).toBe("request_timeout");
    expect(classifyError(named("TimeoutError", "t"))).toBe("request_timeout");
  });

  it("ag hatasi yalnizca istemcide siniflanir", () => {
    const fetchFailed = new TypeError("Failed to fetch");
    expect(classifyError(fetchFailed, { client: true })).toBe("network");
    expect(classifyError(fetchFailed)).toBe("unknown");
  });

  it("kanit yoksa uydurmaz: unknown", () => {
    expect(classifyError(new Error("beklenmeyen"))).toBe("unknown");
    expect(classifyError("metin")).toBe("unknown");
    expect(classifyError(null)).toBe("unknown");
    expect(classifyError(undefined)).toBe("unknown");
    // Ucuncu tarafin `code` alani benzer gorunse de baglanti hatasi sayilmaz.
    expect(classifyError(Object.assign(new Error("x"), { code: "E_SOMETHING" }))).toBe("unknown");
  });

  it("dongusel cause zinciri sonsuz donmez", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    a.cause = a;
    expect(classifyError(a)).toBe("unknown");
  });
});

describe("hata katalogu", () => {
  it("her kodun metni dolu; yasak kelime ve ALL CAPS yok", () => {
    for (const code of ERROR_CODES) {
      const def = ERROR_CATALOG[code];
      expect(def.title.length).toBeGreaterThan(0);
      expect(def.message.length).toBeGreaterThan(0);
      const text = `${def.title} ${def.message}`;
      expect(text).not.toMatch(/satın al|dupe|ucuz/i);
      expect(text.replace(/JPEG|PNG/g, "")).not.toMatch(/(?<![\p{L}])[A-ZÇĞİÖŞÜ]{4,}(?![\p{L}])/u);
    }
  });

  it("metinler teknik ayrinti sizdirmaz", () => {
    for (const code of ERROR_CODES) {
      const { title, message } = ERROR_CATALOG[code];
      expect(`${title} ${message}`).not.toMatch(
        /EMAXCONN|postgres|SELECT |stack|api[_ ]?key|Server Action|supabase|gemini/i,
      );
    }
  });

  it("yeniden denenebilir kodlar `retry` eylemi sunar; oturum kodu girise yonlendirir", () => {
    expect(ERROR_CATALOG.db_capacity.retryable).toBe(true);
    expect(ERROR_CATALOG.db_capacity.action).toBe("retry");
    expect(ERROR_CATALOG.deployment_mismatch.action).toBe("reload");
    expect(ERROR_CATALOG.session_expired.action).toBe("login");
    expect(ERROR_CATALOG.invalid_image.retryable).toBe(false);
  });

  it("describeError bilinmeyen kodu unknown yapar ve referansi tasir", () => {
    expect(describeError({ code: "uydurma" }).code).toBe("unknown");
    expect(describeError({ code: "network", reference: "ARL-ABCD2345" }).reference).toBe(
      "ARL-ABCD2345",
    );
    expect(describeError({ code: "network" }).reference).toBeUndefined();
  });
});

describe("referans ve log", () => {
  it("referans kimligi bicimli ve benzersiz", () => {
    const a = newErrorReference();
    expect(a).toMatch(/^ARL-[A-HJ-NP-Z2-9]{8}$/);
    expect(newErrorReference()).not.toBe(a);
  });

  it("log kaydi adres, anahtar ve uzun belirtec icermez", () => {
    const error = new Error(
      "connect ECONNREFUSED postgresql://arilla_app:s3cr3tpassword@db.abc.supabase.co:6543/postgres key=AIzaSyA1234567890abcdefghijklmnop",
      { cause: undefined },
    );
    const record = buildErrorLog(error, "db_unavailable", "ARL-TEST2345", "sohbet.send");
    const line = JSON.stringify(record);
    expect(line).not.toMatch(/s3cr3t|supabase|AIzaSy|postgresql:/);
    expect(record.message.length).toBeLessThanOrEqual(200);
    expect(record).toMatchObject({ event: "app_error", code: "db_unavailable" });
  });

  it("reportError siniflar, loglar, digest'i referans yapar ve firlatmaz", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = reportError(new Error("(EMAXCONNSESSION) max clients reached"), {
      surface: "test",
      digest: "1234567890",
    });
    expect(result).toEqual({ code: "db_capacity", reference: "1234567890" });
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(logged.reference).toBe("1234567890");
    spy.mockRestore();
  });

  it("scrubMessage kullanici metnini kisaltir", () => {
    expect(scrubMessage("a".repeat(500)).length).toBeLessThanOrEqual(200);
  });
});
