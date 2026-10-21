import { INITIAL_STATUS } from "@arilla/core/maintenance";
import { readSystemStatus } from "@arilla/core/maintenance-service";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getStatus } from "./app/api/system-status/route.ts";
import { GET as getDocument } from "./app/durum/route.ts";
import { proxy } from "./proxy.ts";

vi.mock("@arilla/core/maintenance-service", () => ({ readSystemStatus: vi.fn() }));
const read = vi.mocked(readSystemStatus);
beforeEach(() => {
  vi.stubEnv("PRODUCT_ACCESS", "open");
  vi.stubEnv("ADMIN_HOST", "");
  read.mockResolvedValue({ ...INITIAL_STATUS, mode: "maintenance", message: "Bakım sürüyor." });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("maintenance request integration", () => {
  it("blocks HTML before rendering the application and returns 503 with no-store", async () => {
    const result = await proxy(new NextRequest("https://manicepte.com/ara"));
    expect(result.status).toBe(503);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(result.headers.get("retry-after")).toBe("30");
    expect(result.headers.get("x-robots-tag")).toContain("noindex");
    expect(await result.text()).toContain("Bakım sürüyor.");
  });
  it("does not treat a session cookie as a maintenance bypass", async () => {
    expect(
      (
        await proxy(
          new NextRequest("https://manicepte.com/ara", { headers: { cookie: "session=fake" } }),
        )
      ).status,
    ).toBe(503);
  });
  it("returns JSON for server actions and RSC instead of invalid HTML", async () => {
    for (const options of [{ method: "POST" }, { headers: { rsc: "1" } }]) {
      const result = await proxy(new NextRequest("https://manicepte.com/ara", options));
      expect(result.status).toBe(503);
      expect((await result.json()).error).toBe("maintenance");
    }
  });
  it("allows admin login with original authentication gates intact", async () => {
    const result = await proxy(new NextRequest("https://manicepte.com/yonetim/bakim"));
    expect(result.headers.get("location")).toContain("/yonetim/giris");
    expect(read).not.toHaveBeenCalled();
  });
  it("leaves independent polling, callbacks and scheduled jobs reachable", async () => {
    for (const path of [
      "/api/system-status",
      "/durum",
      "/api/cron/cleanup-auth",
      "/giris/google/callback",
    ]) {
      expect((await proxy(new NextRequest(`https://manicepte.com${path}`))).status).toBe(200);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("partial outage blocks only affected services; planned mode leaves traffic open", async () => {
    read.mockResolvedValue({
      ...INITIAL_STATUS,
      mode: "partial",
      message: "Görsel arama kesintisi",
      services: ["image"],
    });
    expect((await proxy(new NextRequest("https://manicepte.com/ara/gorsel"))).status).toBe(503);
    expect((await proxy(new NextRequest("https://manicepte.com/ara/link"))).status).toBe(200);
    read.mockResolvedValue({ ...INITIAL_STATUS, mode: "planned", message: "Bu gece bakım var." });
    expect((await proxy(new NextRequest("https://manicepte.com/ara"))).status).toBe(200);
  });
  it("unknown source does not fabricate normal public status", async () => {
    read.mockResolvedValue(null);
    const result = await getStatus(new Request("https://manicepte.com/api/system-status"));
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "unavailable" });
  });
  it("status endpoint reports whether the return path has recovered", async () => {
    read.mockResolvedValue({
      ...INITIAL_STATUS,
      mode: "partial",
      message: "Kesinti",
      services: ["image"],
    });
    const result = await getStatus(
      new Request("https://manicepte.com/api/system-status?path=%2Fara%2Flink"),
    );
    expect((await result.json()).blocked).toBe(false);
  });
  it("status document is independent of layouts and sanitizes the return destination", async () => {
    const result = await getDocument(
      new Request("https://manicepte.com/durum?next=%2F%2Fevil.test"),
    );
    const html = await result.text();
    expect(html).toContain('"returnPath":"/"');
    expect(html).not.toContain("evil.test");
    expect(result.headers.get("cache-control")).toContain("no-store");
  });
});
