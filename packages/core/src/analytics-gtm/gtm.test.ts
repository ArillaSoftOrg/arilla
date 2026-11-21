import { describe, expect, it } from "vitest";
import {
  buildDataLayerPush,
  consentBootstrapScript,
  consentModeState,
  GTM_PARAM_KEYS,
  gtmLoadsBeforeConsent,
  parseClarityId,
  parseGtmId,
  sanitizeSearchTerm,
} from "./gtm.ts";

describe("gtm ids", () => {
  it("accepts the configured ids and rejects junk", () => {
    expect(parseGtmId("GTM-WQ95FXS9")).toBe("GTM-WQ95FXS9");
    expect(parseGtmId("G-ZXVZ2HG58K")).toBeNull();
    expect(parseGtmId("'); alert(1)//")).toBeNull();
    expect(parseClarityId("zh78e7c34p")).toBe("zh78e7c34p");
    expect(parseClarityId("x'y")).toBeNull();
  });
});

describe("consent mode", () => {
  it("keeps ad signals denied permanently", () => {
    expect(consentModeState(true)).toEqual({
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "granted",
    });
  });
  it("defaults to denied with wait_for_update and applies a prior grant before GTM", () => {
    const denied = consentBootstrapScript(false);
    expect(denied).toContain('"wait_for_update":500');
    expect(denied).not.toContain('"update"');
    const granted = consentBootstrapScript(true);
    expect(granted).toContain('"update"');
    expect(granted.indexOf('"default"')).toBeLessThan(granted.indexOf('"update"'));
  });
});

describe("GTM_LOAD_BEFORE_CONSENT", () => {
  it("defaults to true; only an explicit off value disables it", () => {
    expect(gtmLoadsBeforeConsent(undefined)).toBe(true);
    expect(gtmLoadsBeforeConsent("")).toBe(true);
    expect(gtmLoadsBeforeConsent("true")).toBe(true);
    expect(gtmLoadsBeforeConsent("false")).toBe(false);
    expect(gtmLoadsBeforeConsent(" OFF ")).toBe(false);
  });
});

describe("search_term", () => {
  it("lowercases (tr), trims, caps at 100", () => {
    expect(sanitizeSearchTerm("  IŞIK Lambası ")).toBe("ışık lambası");
    expect(sanitizeSearchTerm("a".repeat(300))?.length).toBe(100);
  });
  it("drops email and phone-like terms", () => {
    expect(sanitizeSearchTerm("ali@example.com")).toBeNull();
    expect(sanitizeSearchTerm("0532 123 45 67")).toBeNull();
    expect(sanitizeSearchTerm("+90 (532) 123-45-67")).toBeNull();
    expect(sanitizeSearchTerm("iphone 15 128 gb")).toBe("iphone 15 128 gb");
  });
});

describe("buildDataLayerPush", () => {
  it("always carries all 9 keys, unused ones null", () => {
    const push = buildDataLayerPush("select_category", { category_name: "Ayakkabı" });
    expect(Object.keys(push ?? {}).sort()).toEqual(["event", ...GTM_PARAM_KEYS].sort());
    expect(push?.search_term).toBeNull();
    expect(push?.item_id).toBeNull();
    expect(push?.category_name).toBe("Ayakkabı");
  });
  it("does not leak earlier params: the next push resets them", () => {
    const a = buildDataLayerPush("search", { search_term: "Kulaklık" });
    const b = buildDataLayerPush("sign_up", { method: "google" });
    expect(a?.search_term).toBe("kulaklık");
    expect(b?.search_term).toBeNull();
  });
  it("sends no event for a PII-looking search or a bad item id", () => {
    expect(buildDataLayerPush("search", { search_term: "a@b.co" })).toBeNull();
    expect(buildDataLayerPush("view_item", { item_id: "bad id!" })).toBeNull();
  });
  it("drops params outside the event's allow-list", () => {
    const push = buildDataLayerPush("login", { method: "email", search_term: "x" } as never);
    expect(push?.search_term).toBeNull();
  });
});
