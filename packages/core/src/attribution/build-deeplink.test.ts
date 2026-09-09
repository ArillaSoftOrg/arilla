import { describe, expect, it } from "vitest";
import { buildDeeplink } from "./build-deeplink.ts";

const SEED_SHAPED_TEMPLATE = "https://modadeposu.example/git?u={url}&ref={click_id}";
const TRACKING_TEMPLATE = "https://c3-fixture.test/git?u={url}&ref={click_id}&t={tracking_id}";

describe("buildDeeplink", () => {
  it("substitutes {url} and {click_id} for an active merchant with no creator tracking", () => {
    const result = buildDeeplink({
      affiliateStatus: "active",
      deeplinkTemplate: SEED_SHAPED_TEMPLATE,
      offerUrl: "https://modadeposu.example/p/123",
      clickId: "11111111-1111-1111-1111-111111111111",
    });
    expect(result).toBe(
      "https://modadeposu.example/git?u=https%3A%2F%2Fmodadeposu.example%2Fp%2F123&ref=11111111-1111-1111-1111-111111111111",
    );
    expect(result).not.toContain("{");
  });

  it("substitutes {tracking_id} when the template has it and a tracking id is provided", () => {
    const result = buildDeeplink({
      affiliateStatus: "active",
      deeplinkTemplate: TRACKING_TEMPLATE,
      offerUrl: "https://merchant.test/p/1",
      clickId: "click-1",
      trackingId: "creator-abc",
    });
    expect(result).toContain("t=creator-abc");
  });

  it("resolves {tracking_id} to an empty value when no tracking id is available", () => {
    const result = buildDeeplink({
      affiliateStatus: "active",
      deeplinkTemplate: TRACKING_TEMPLATE,
      offerUrl: "https://merchant.test/p/1",
      clickId: "click-1",
      trackingId: null,
    });
    expect(result).toContain("t=");
    expect(result).not.toContain("{tracking_id}");
  });

  it.each(["none", "pending", "suspended"] as const)(
    "returns the plain offer URL when affiliateStatus is %s",
    (affiliateStatus) => {
      const offerUrl = "https://merchant.test/p/1";
      const result = buildDeeplink({
        affiliateStatus,
        deeplinkTemplate: SEED_SHAPED_TEMPLATE,
        offerUrl,
        clickId: "click-1",
      });
      expect(result).toBe(offerUrl);
    },
  );

  it("returns the plain offer URL when the template is null even if active", () => {
    const offerUrl = "https://merchant.test/p/1";
    const result = buildDeeplink({
      affiliateStatus: "active",
      deeplinkTemplate: null,
      offerUrl,
      clickId: "click-1",
    });
    expect(result).toBe(offerUrl);
  });

  it("throws when the template is missing {click_id}", () => {
    expect(() =>
      buildDeeplink({
        affiliateStatus: "active",
        deeplinkTemplate: "https://merchant.test/git?u={url}",
        offerUrl: "https://merchant.test/p/1",
        clickId: "click-1",
      }),
    ).toThrow();
  });

  it("throws when the template is missing {url}", () => {
    expect(() =>
      buildDeeplink({
        affiliateStatus: "active",
        deeplinkTemplate: "https://merchant.test/git?ref={click_id}",
        offerUrl: "https://merchant.test/p/1",
        clickId: "click-1",
      }),
    ).toThrow();
  });

  it("encodes an offer URL that itself has a query string", () => {
    const offerUrl = "https://merchant.test/p?x=1&y=2";
    const result = buildDeeplink({
      affiliateStatus: "active",
      deeplinkTemplate: SEED_SHAPED_TEMPLATE,
      offerUrl,
      clickId: "click-1",
    });
    expect(result).toBe(
      `https://modadeposu.example/git?u=${encodeURIComponent(offerUrl)}&ref=click-1`,
    );
  });
});
