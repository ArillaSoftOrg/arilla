import { describe, expect, it } from "vitest";
import { deriveConsentState, effectiveAnalyticsConsent } from "./account-consent.ts";
import { acceptAll, CONSENT_VERSION, type CookieConsent, rejectAll } from "./cookie-consent.ts";

const T0 = new Date("2026-10-01T10:00:00Z");
const T1 = new Date("2026-10-02T10:00:00Z");

function cookie(analytics: boolean, at: Date = T0, version = CONSENT_VERSION): CookieConsent {
  return {
    ...(analytics ? acceptAll(at) : rejectAll(at)),
    version,
  };
}

describe("effectiveAnalyticsConsent - muhafazakâr kapı", () => {
  it("çerez yok / eski sürüm / analytics false → izin yok", () => {
    expect(effectiveAnalyticsConsent(null, null)).toBe(false);
    expect(effectiveAnalyticsConsent(cookie(true, T0, CONSENT_VERSION + 1), null)).toBe(false);
    expect(effectiveAnalyticsConsent(cookie(false), null)).toBe(false);
  });

  it("geçerli çerez true ve hesapta daha yeni ret yok → izin var", () => {
    expect(effectiveAnalyticsConsent(cookie(true, T1), null)).toBe(true);
    expect(effectiveAnalyticsConsent(cookie(true, T1), { granted: false, grantedAt: T0 })).toBe(
      true,
    );
    expect(effectiveAnalyticsConsent(cookie(true, T0), { granted: true, grantedAt: T1 })).toBe(
      true,
    );
  });

  it("hesapta çerezden DAHA YENİ bir ret (başka cihazdan geri alma) → izin yok", () => {
    expect(effectiveAnalyticsConsent(cookie(true, T0), { granted: false, grantedAt: T1 })).toBe(
      false,
    );
  });

  it("hesap true ama bu tarayıcının çerezi false → izin yok", () => {
    expect(effectiveAnalyticsConsent(cookie(false, T1), { granted: true, grantedAt: T1 })).toBe(
      false,
    );
  });
});

describe("deriveConsentState", () => {
  const row = (granted: boolean, at: Date, textVersion: string | null = "cookie-v1", id = 0) => ({
    kind: "cookie_analytics" as const,
    granted,
    grantedAt: at,
    source: textVersion ? ("cookie_banner" as const) : null,
    textVersion,
    id,
  });

  it("kayıt yok → unknown", () => {
    expect(deriveConsentState("cookie_analytics", []).status).toBe("unknown");
  });
  it("son satır true → accepted", () => {
    expect(deriveConsentState("cookie_analytics", [row(false, T0), row(true, T1)]).status).toBe(
      "accepted",
    );
  });
  it("yalnızca false → rejected", () => {
    expect(deriveConsentState("cookie_analytics", [row(false, T0)]).status).toBe("rejected");
  });
  it("true sonra false → revoked", () => {
    expect(deriveConsentState("cookie_analytics", [row(true, T0), row(false, T1)]).status).toBe(
      "revoked",
    );
  });
  it("aynı anda iki satır: id eşitlik bozucu", () => {
    const state = deriveConsentState("cookie_analytics", [
      row(true, T0, null, 1),
      row(false, T0, null, 2),
    ]);
    expect(state.status).toBe("revoked");
  });
  it("sürümsüz eski satır GEÇERLİDİR; yalnızca etiketlenir", () => {
    const state = deriveConsentState("cookie_analytics", [row(true, T0, null)]);
    expect(state.status).toBe("accepted");
    expect(state.versionless).toBe(true);
  });
  it("başka türün satırları karışmaz", () => {
    const other = { ...row(true, T1), kind: "marketing_email" as const };
    expect(deriveConsentState("cookie_analytics", [other]).status).toBe("unknown");
  });
});
