import { describe, expect, it } from "vitest";
import {
  explainSignals,
  humanReviewReasons,
  identifierAgreement,
  MATCH_AUTO_ACCEPT_THRESHOLD,
  MATCH_QUEUE_THRESHOLD,
  reviewReasonText,
  scoreBand,
  waitedText,
} from "./match-evidence.ts";
import type { MatchExplain } from "./matching-queue.ts";

const explain = (over: Partial<MatchExplain> = {}): MatchExplain => ({
  method: "text",
  score: 0.7,
  text_similarity: 0.7,
  review: null,
  auto_eligible: false,
  brand_known_both: true,
  brand_equal: true,
  queue_threshold: 0.63,
  auto_accept_threshold: 0.84,
  ...over,
});

const noIds = {
  offer: { gtin: null, mpn: null, variantGtins: [] },
  product: { gtin: null, mpn: null },
  candidateGtins: [],
  candidateGtinSetComplete: false,
  siblingMpns: [],
};

describe("scoreBand", () => {
  it("uses the row's own thresholds when explain has them", () => {
    const band = scoreBand(0.8, explain({ queue_threshold: 0.6, auto_accept_threshold: 0.9 }));
    expect(band).toMatchObject({
      queueThreshold: 0.6,
      autoAcceptThreshold: 0.9,
      thresholdsFrom: "explain",
      position: "review_band",
    });
  });

  it("falls back to score.py defaults for rows without explain", () => {
    const band = scoreBand(0.7, null);
    expect(band.queueThreshold).toBe(MATCH_QUEUE_THRESHOLD);
    expect(band.autoAcceptThreshold).toBe(MATCH_AUTO_ACCEPT_THRESHOLD);
    expect(band.thresholdsFrom).toBe("default");
  });

  it("classifies the three bands at the boundaries", () => {
    expect(scoreBand(0.62, null).position).toBe("below_queue");
    expect(scoreBand(0.63, null).position).toBe("review_band");
    expect(scoreBand(0.84, null).position).toBe("auto_band");
  });
});

describe("humanReviewReasons (inverse of score.auto_eligible)", () => {
  it("explains a missing explain without inventing components", () => {
    expect(humanReviewReasons("text", 0.7, null)).toHaveLength(1);
    expect(explainSignals("text", 0.7, null)).toEqual([]);
  });

  it("score below auto threshold", () => {
    const reasons = humanReviewReasons("text", 0.7, explain());
    expect(reasons.join(" ")).toContain("otomatik kabul eşiğinin");
  });

  it("score above threshold but brand unknown on one side", () => {
    const reasons = humanReviewReasons(
      "hybrid",
      0.9,
      explain({ brand_known_both: false, brand_equal: false }),
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("Marka iki tarafta bilinmediği");
  });

  it("review reason from the resolver is explained and kept verbatim", () => {
    const review = "renk dogrulanamadi: spring-green";
    const reasons = humanReviewReasons("text", 0.9, explain({ review }));
    expect(reasons[0]).toContain("0029");
    expect(reasons[0]).toContain(review);
    expect(reviewReasonText("hacim varyanti dogrulanamadi: 50ml / ['100ml']")).toContain("0033");
    expect(reviewReasonText("baska bir not")).toBe("Resolver notu: baska bir not");
  });
});

describe("explainSignals", () => {
  it("marks brand agreement as supporting and names the bonus", () => {
    const signals = explainSignals("text", 0.7, explain());
    expect(signals.find((s) => s.key === "brand")?.tone).toBe("supports");
    expect(signals.find((s) => s.key === "text")?.text).toContain("0,08");
  });

  it("does not claim an image similarity value for hybrid rows", () => {
    const signals = explainSignals("hybrid", 0.8, explain({ method: "hybrid" }));
    const hybrid = signals.find((s) => s.key === "hybrid");
    expect(hybrid?.text).toContain("Görsel benzerliği ayrıca kaydedilmez");
  });

  it("flags known-different brands as weakening (resolver vetoes these today)", () => {
    const signals = explainSignals("text", 0.7, explain({ brand_equal: false }));
    expect(signals.find((s) => s.key === "brand")).toMatchObject({ tone: "weakens" });
  });
});

describe("identifierAgreement", () => {
  it("missing on both sides", () => {
    const r = identifierAgreement(noIds);
    expect(r.gtin.state).toBe("missing");
    expect(r.mpn.state).toBe("missing");
  });

  it("equal via a sibling variant barcode", () => {
    const r = identifierAgreement({
      ...noIds,
      offer: { gtin: null, mpn: null, variantGtins: ["8690000000017"] },
      candidateGtins: ["8690000000017", "8690000000024"],
    });
    expect(r.gtin).toMatchObject({ state: "equal", shared: ["8690000000017"] });
  });

  it("offer vs product barcode difference is a conflict (score.veto_reason)", () => {
    const r = identifierAgreement({
      ...noIds,
      offer: { gtin: "8690000000017", mpn: null, variantGtins: [] },
      product: { gtin: "8690000000024", mpn: null },
    });
    expect(r.gtin.state).toBe("conflict");
  });

  it("disjoint against a complete candidate set is a conflict, incomplete is only different", () => {
    const base = {
      ...noIds,
      offer: { gtin: null, mpn: null, variantGtins: ["8690000000017"] },
      candidateGtins: ["8690000000024"],
    };
    expect(identifierAgreement({ ...base, candidateGtinSetComplete: true }).gtin.state).toBe(
      "conflict",
    );
    expect(identifierAgreement(base).gtin.state).toBe("different");
  });

  it("MPN equal vs different", () => {
    const equal = identifierAgreement({
      ...noIds,
      offer: { gtin: null, mpn: "AB-1", variantGtins: [] },
      siblingMpns: ["AB-1"],
    });
    expect(equal.mpn.state).toBe("equal");
    const different = identifierAgreement({
      ...noIds,
      offer: { gtin: null, mpn: "AB-1", variantGtins: [] },
      product: { gtin: null, mpn: "AB-2" },
    });
    expect(different.mpn.state).toBe("different");
  });
});

describe("waitedText", () => {
  it("rounds down to minutes, hours, days", () => {
    expect(waitedText(5 * 60_000)).toBe("5 dakika");
    expect(waitedText(3 * 3_600_000)).toBe("3 saat");
    expect(waitedText(3 * 86_400_000)).toBe("3 gün");
    expect(waitedText(-1)).toBe("0 dakika");
  });
});
