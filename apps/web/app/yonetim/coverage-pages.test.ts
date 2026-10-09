/**
 * Kapsam kaydı ve menü gerçek sayfalara işaret eder (karar 0082). Kayıt
 * "görünür" dediği bir sayfayı gösteremiyorsa ya da menüde sayfası olmayan bir
 * bağlantı varsa kırılır. Yetki matrisinin eksiksizliği ayrıca
 * `authorization.integration.test.ts`'te.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_SUBSYSTEMS, AUDIT_TARGET_TYPES } from "@arilla/core";
import { describe, expect, it } from "vitest";
import { ADMIN_NAV } from "./admin-nav.ts";
import { TARGET_TYPE_LABELS } from "./format.ts";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `/yonetim/katalog/urunler` → `app/yonetim/katalog/urunler/page.tsx` var mı. */
function pageExists(route: string): boolean {
  return existsSync(join(appDir, route.replace(/^\//, ""), "page.tsx"));
}

describe("yönetim kapsamı - sayfalar", () => {
  it("kayıttaki her yönetim yolu gerçek bir sayfa", () => {
    const paths = ADMIN_SUBSYSTEMS.flatMap((s) => s.adminPaths.map((path) => [s.id, path]));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter(([, path]) => !pageExists(path as string))).toEqual([]);
  });

  it("menüdeki her bağlantı gerçek bir sayfa", () => {
    const hrefs = ADMIN_NAV.flatMap((group) => group.items.map((item) => item.href));
    expect(hrefs.filter((href) => !pageExists(href))).toEqual([]);
  });

  it("her denetim hedef türünün Türkçe etiketi var", () => {
    for (const target of AUDIT_TARGET_TYPES) {
      expect(TARGET_TYPE_LABELS[target]).toMatch(/\S/);
    }
  });
});
