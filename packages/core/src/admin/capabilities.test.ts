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
const ADMIN_ONLY: Capability[] = [
  "merchant.manage",
  "catalog.write",
  "audit.read",
  "users.read",
  "operations.read",
  // Karar 0043: lansman öncesi önizleme yalnızca yöneticinin.
  "product.preview",
  "marketing.manage",
  "forms.manage",
  // Karar 0061: gelen kutusu ad ve e-posta icerir.
  "messages.read",
  // Karar 0079: sohbet geri bildirimi yorumlari.
  "feedback.chat.read",
  // Karar 0049: moderatör kullanıcı aktivitesini ve tam iletişim bilgisini göremez.
  "users.activity.read",
  "users.contact.reveal",
  // Karar 0050: oturum kapatma yalnızca yöneticinin.
  "users.sessions.revoke",
  // Karar 0065: herkese görünen erken erişim sayısı yalnızca yöneticinin.
  "early_access.manage",
];
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
