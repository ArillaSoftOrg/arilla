import { describe, expect, it } from "vitest";
import { REMOVAL_MISSED_SCANS, verifyFullScan } from "./discovery-presence.ts";

const done = (n: number) => Array.from({ length: n }, () => ({ kind: "sitemap_file", status: "done" }));

describe("verifyFullScan (karar 0140)", () => {
  it("accepts a run whose every sitemap file is done", () => {
    expect(verifyFullScan(done(3))).toEqual({ complete: true, units: 3 });
  });

  it("rejects a run with no discovery units", () => {
    expect(verifyFullScan([{ kind: "listing_page", status: "done" }])).toEqual({
      complete: false,
      reason: "no_discovery_units",
    });
    expect(verifyFullScan([])).toEqual({ complete: false, reason: "no_discovery_units" });
  });

  it("rejects a partial run when any file is still pending", () => {
    const units = [...done(2), { kind: "sitemap_file", status: "pending" }];
    expect(verifyFullScan(units)).toEqual({ complete: false, reason: "unit_pending" });
  });

  it("rejects a run with a failed or blocked file (no removal from a flaky scan)", () => {
    expect(verifyFullScan([...done(2), { kind: "sitemap_file", status: "failed" }])).toEqual({
      complete: false,
      reason: "unit_failed",
    });
    expect(verifyFullScan([...done(2), { kind: "sitemap_file", status: "blocked" }])).toEqual({
      complete: false,
      reason: "unit_blocked",
    });
  });

  it("treats an empty file as incomplete: a transient error can look like an empty sitemap", () => {
    expect(verifyFullScan([...done(2), { kind: "sitemap_file", status: "empty" }])).toEqual({
      complete: false,
      reason: "unit_empty",
    });
  });

  it("ignores non-discovery units when judging completeness", () => {
    const units = [...done(1), { kind: "listing_page", status: "pending" }];
    expect(verifyFullScan(units)).toEqual({ complete: true, units: 1 });
  });

  it("requires two consecutive verified misses before removal", () => {
    expect(REMOVAL_MISSED_SCANS).toBe(2);
  });
});
