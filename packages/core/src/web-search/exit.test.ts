import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signWebExit, verifyWebExit, type WebExitPayload } from "./exit.ts";

const payload: WebExitPayload = {
  url: "https://shop.com.tr/urun/abc?renk=siyah",
  kind: "exact",
  price: 129_990,
  priceStatus: "verified",
  surface: "search",
  position: 3,
};
const NOW = new Date("2026-10-11T10:00:00Z");

describe("web exit token", () => {
  const previous = process.env.SESSION_SECRET;
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  });

  it("imzali token dogrulanir ve ayni yuku verir", () => {
    expect(verifyWebExit(signWebExit(payload, NOW), NOW)).toEqual(payload);
  });

  it("suresi dolan token reddedilir", () => {
    const token = signWebExit(payload, NOW, 60);
    expect(verifyWebExit(token, new Date(NOW.getTime() + 61_000))).toBeNull();
    expect(verifyWebExit(token, new Date(NOW.getTime() + 30_000))).not.toBeNull();
  });

  it("govdesi degistirilmis (baska adres / fiyat) token reddedilir", () => {
    const token = signWebExit(payload, NOW);
    const [body, sig] = token.split(".");
    const wire = JSON.parse(Buffer.from(body as string, "base64url").toString("utf8"));
    wire.u = "https://evil.example.com/x";
    const forged = `${Buffer.from(JSON.stringify(wire)).toString("base64url")}.${sig}`;
    expect(verifyWebExit(forged, NOW)).toBeNull();
    wire.u = payload.url;
    wire.p = 1;
    expect(
      verifyWebExit(`${Buffer.from(JSON.stringify(wire)).toString("base64url")}.${sig}`, NOW),
    ).toBeNull();
  });

  it("baska sirla imzalanan token reddedilir", () => {
    const token = signWebExit(payload, NOW);
    process.env.SESSION_SECRET = "baska-bir-sir-baska-bir-sir-baska-bir";
    expect(verifyWebExit(token, NOW)).toBeNull();
  });

  it("cop girdi reddedilir", () => {
    for (const bad of ["", "abc", ".", "a.b", "x".repeat(5000)]) {
      expect(verifyWebExit(bad, NOW)).toBeNull();
    }
  });

  it("imzali olsa da guvensiz adres yonlendirmez", () => {
    const token = signWebExit({ ...payload, url: "http://10.0.0.1/admin" }, NOW);
    expect(verifyWebExit(token, NOW)).toBeNull();
    const nonCanonical = signWebExit(
      { ...payload, url: "https://shop.com.tr/urun/abc/?utm_source=x" },
      NOW,
    );
    expect(verifyWebExit(nonCanonical, NOW)).toBeNull();
  });

  it("dogrulanmamis fiyat tokenda fiyat tasimaz", () => {
    const token = signWebExit({ ...payload, priceStatus: "unverified", price: null }, NOW);
    expect(verifyWebExit(token, NOW)).toMatchObject({ price: null, priceStatus: "unverified" });
  });
});
