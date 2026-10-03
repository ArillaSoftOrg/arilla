import { describe, expect, it } from "vitest";
import {
  classifyUnmatchedOffer,
  defectSeverity,
  isMostlyUnmatched,
  isValidGtin,
  missingFieldSeverity,
  NO_CANDIDATE_WARN_MS,
  noCandidateSeverity,
  noticeSeverity,
} from "./catalog-quality.ts";

describe("isValidGtin (collect/identifiers.py gtin_valid)", () => {
  it("accepts valid GTIN-8/12/13/14", () => {
    expect(isValidGtin("96385074")).toBe(true);
    expect(isValidGtin("036000291452")).toBe(true);
    expect(isValidGtin("8690000000012")).toBe(true);
    expect(isValidGtin("4006381333931")).toBe(true);
    expect(isValidGtin("10012345678902")).toBe(true);
  });

  it("rejects wrong check digit, length or non-digits", () => {
    expect(isValidGtin("8690000000017")).toBe(false);
    expect(isValidGtin("869000000001")).toBe(false);
    expect(isValidGtin("12345678901")).toBe(false);
    expect(isValidGtin("86900000A0017")).toBe(false);
    expect(isValidGtin("")).toBe(false);
    expect(isValidGtin(null)).toBe(false);
  });
});

describe("severities are not exaggerated", () => {
  it("missing fields: info below share, warning at/above 20%", () => {
    expect(missingFieldSeverity(0, 100)).toBe("healthy");
    expect(missingFieldSeverity(19, 100)).toBe("info");
    expect(missingFieldSeverity(20, 100)).toBe("warning");
  });

  it("defects warn, notices inform", () => {
    expect(defectSeverity(0)).toBe("healthy");
    expect(defectSeverity(1)).toBe("warning");
    expect(noticeSeverity(0)).toBe("healthy");
    expect(noticeSeverity(5)).toBe("info");
  });

  it("no-candidate offers warn only once one waited 48 hours", () => {
    expect(noCandidateSeverity(0, null)).toBe("healthy");
    expect(noCandidateSeverity(3, NO_CANDIDATE_WARN_MS - 1)).toBe("info");
    expect(noCandidateSeverity(3, NO_CANDIDATE_WARN_MS)).toBe("warning");
  });
});

describe("classifyUnmatchedOffer", () => {
  it("orders decided > pending > rejected > none", () => {
    expect(classifyUnmatchedOffer({ pending: 1, rejected: 1, decided: 1 })).toBe(
      "decided_unlinked",
    );
    expect(classifyUnmatchedOffer({ pending: 1, rejected: 2, decided: 0 })).toBe("in_queue");
    expect(classifyUnmatchedOffer({ pending: 0, rejected: 2, decided: 0 })).toBe("rejected_only");
    expect(classifyUnmatchedOffer({ pending: 0, rejected: 0, decided: 0 })).toBe("no_candidate");
  });
});

describe("isMostlyUnmatched", () => {
  it("needs a minimum size and more than half unmatched", () => {
    expect(isMostlyUnmatched(19, 19)).toBe(false);
    expect(isMostlyUnmatched(20, 10)).toBe(false);
    expect(isMostlyUnmatched(20, 11)).toBe(true);
  });
});
