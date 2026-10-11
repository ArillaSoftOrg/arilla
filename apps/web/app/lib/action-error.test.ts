import { describeError } from "@arilla/core/errors";
import { describe, expect, it, vi } from "vitest";
import { errorKindForStatus } from "../sohbet/chat-copy.ts";
import { actionError, errorFromLlmCode, SESSION_EXPIRED } from "./action-error.ts";

describe("actionError()", () => {
  it("kod + referans doner; mesaj, adres ve yigin istemciye gitmez", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = actionError(
      new Error("(EMAXCONNSESSION) max clients reached postgres://u:p@db.example.com:6543/x"),
      "sohbet.send",
    );
    spy.mockRestore();
    expect(result.code).toBe("db_capacity");
    expect(result.reference).toMatch(/^ARL-/);
    expect(JSON.stringify(result)).not.toMatch(/postgres|example\.com|stack/);
  });

  it("nedeni bilinmeyen hata unknown kalir (biliniyormus gibi siniflanmaz)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(actionError(new Error("ilginc"), "x").code).toBe("unknown");
    spy.mockRestore();
  });
});

describe("errorFromLlmCode()", () => {
  it("bilinen saglayici kodlarini eler, bilinmeyeni null birakir", () => {
    expect(errorFromLlmCode("rate_limited")).toEqual({ code: "ai_rate_limited" });
    expect(errorFromLlmCode("timeout")).toEqual({ code: "ai_timeout" });
    expect(errorFromLlmCode("unknown")).toBeNull();
  });
});

describe("oturum bitti", () => {
  it("girise yonlendirir ve yeniden denenebilir sayilmaz", () => {
    const info = describeError(SESSION_EXPIRED);
    expect(info.action).toBe("login");
    expect(info.retryable).toBe(false);
  });

  it("sohbet durumu hata turune cevrilir; taslak yalnizca basarida temizlenir", () => {
    // Istemci taslagi yalniz `errorKindForStatus(...) === null` iken siler (chat-client send()).
    expect(errorKindForStatus("session_expired")).not.toBeNull();
    expect(errorKindForStatus("error")).not.toBeNull();
    expect(errorKindForStatus("provider_error")).not.toBeNull();
    expect(errorKindForStatus("queued")).toBeNull();
  });
});
