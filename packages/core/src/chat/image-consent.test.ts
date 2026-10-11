import { describe, expect, it } from "vitest";
import { CHAT_IMAGE_CONSENT_VERSION, deriveChatImageConsent } from "./image-consent.ts";

describe("deriveChatImageConsent", () => {
  it("kayit yok: riza yok, karar verilmemis", () => {
    expect(deriveChatImageConsent(undefined)).toEqual({ granted: false, decided: false });
  });

  it("guncel surume kabul: riza var", () => {
    expect(
      deriveChatImageConsent({ granted: true, textVersion: CHAT_IMAGE_CONSENT_VERSION }),
    ).toEqual({ granted: true, decided: true });
  });

  it("eski metin surumune verilmis kabul gecersiz (yeniden sorulur)", () => {
    expect(deriveChatImageConsent({ granted: true, textVersion: "chat-image-2000-01-01" })).toEqual(
      { granted: false, decided: true },
    );
    expect(deriveChatImageConsent({ granted: true, textVersion: null })).toEqual({
      granted: false,
      decided: true,
    });
  });

  it("ret ya da geri cekme: riza yok", () => {
    expect(
      deriveChatImageConsent({ granted: false, textVersion: CHAT_IMAGE_CONSENT_VERSION }),
    ).toEqual({ granted: false, decided: true });
  });
});
