import { describe, expect, it } from "vitest";
import type { UserRole } from "../auth/types.ts";
import {
  AdminForbiddenError,
  assertCapability,
  type Capability,
  hasCapability,
} from "./capabilities.ts";

const MODERATOR: Capability[] = [
  "admin.access",
  "matching.review",
  "dictionary.write",
  "catalog.read",
  "diagnostics.read",
  "merchant.read",
  "ingest.read",
];
const ADMIN_ONLY: Capability[] = ["merchant.manage", "catalog.write", "audit.read", "users.read"];
const ALL: Capability[] = [...MODERATOR, ...ADMIN_ONLY];

describe("yetki haritası", () => {
  it.each<UserRole>(["user", "creator"])("%s hiçbir yönetim yetkisi almaz", (role) => {
    for (const capability of ALL) {
      expect(hasCapability(role, capability)).toBe(false);
    }
  });

  it("moderator: kuyruk, sözlük ve okuma yetkileri var; yönetici yetkileri yok", () => {
    for (const capability of MODERATOR) expect(hasCapability("moderator", capability)).toBe(true);
    for (const capability of ADMIN_ONLY) expect(hasCapability("moderator", capability)).toBe(false);
  });

  it("admin: tüm yetkiler", () => {
    for (const capability of ALL) expect(hasCapability("admin", capability)).toBe(true);
  });

  it("tanımsız rol hiçbir yetki almaz", () => {
    expect(hasCapability("superuser" as UserRole, "admin.access")).toBe(false);
  });

  it("assertCapability yetkisizde AdminForbiddenError fırlatır", () => {
    expect(() => assertCapability({ userId: 1, role: "moderator" }, "audit.read")).toThrow(
      AdminForbiddenError,
    );
    expect(() => assertCapability({ userId: 1, role: "admin" }, "audit.read")).not.toThrow();
  });
});
