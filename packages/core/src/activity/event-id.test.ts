import { describe, expect, it } from "vitest";
import { ACTIVITY_SCHEMA_VERSION, merchantExitEventId } from "./record.ts";

const CLICK = "0b5f2c1e-8a4d-4f0a-9d3e-1c2b3a4d5e6f";

describe("merchantExitEventId", () => {
  it("is deterministic per click and case-insensitive", () => {
    expect(merchantExitEventId(CLICK)).toBe(merchantExitEventId(CLICK.toUpperCase()));
  });
  it("differs between clicks", () => {
    expect(merchantExitEventId(CLICK)).not.toBe(
      merchantExitEventId("0b5f2c1e-8a4d-4f0a-9d3e-1c2b3a4d5e70"),
    );
  });
  it("is a well-formed UUID that does not embed the click id", () => {
    const id = merchantExitEventId(CLICK);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toContain(CLICK.slice(0, 13));
  });
});

describe("ACTIVITY_SCHEMA_VERSION", () => {
  it("is 2 (1 is reserved for legacy rows without event_id)", () => {
    expect(ACTIVITY_SCHEMA_VERSION).toBe(2);
  });
});
