import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESERVED_SLUGS, SLUG_PATTERN } from "@arilla/core";
import { describe, expect, it } from "vitest";

const appDir = dirname(fileURLToPath(import.meta.url));

/** Altında herhangi bir `page`/`route` dosyası olan klasör gerçek bir rotadır. */
function hasRoute(dir: string): boolean {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (hasRoute(path)) return true;
    } else if (/^(page|route)\.(t|j)sx?$/.test(name)) {
      return true;
    }
  }
  return false;
}

describe("takip bağlantısı slug'ları: sistem rotaları rezerve", () => {
  const routeFolders = readdirSync(appDir)
    .filter((name) => statSync(join(appDir, name)).isDirectory())
    // Dinamik/grup/özel klasörler ve paylaşılan kod klasörleri slug alanına girmez.
    .filter((name) => !/^[[(_]/.test(name))
    .filter((name) => hasRoute(join(appDir, name)))
    // Noktalı adlar (sitemap.xml) zaten slug biçimine uymaz.
    .filter((name) => SLUG_PATTERN.test(name));

  it("apps/web/app altındaki her üst düzey rota RESERVED_SLUGS'ta (yeni rota eklenince bu test kırılır)", () => {
    expect(routeFolders.length).toBeGreaterThan(20);
    expect(routeFolders.filter((name) => !RESERVED_SLUGS.has(name))).toEqual([]);
  });

  it("next.config yönlendirmelerinin tek parçalı kaynakları rezerve (yönlendirme rotadan önce çalışır)", () => {
    const config = readFileSync(join(appDir, "..", "next.config.ts"), "utf8");
    const sources = [...config.matchAll(/source:\s*"\/([a-z0-9-]+)"/g)].map((m) => m[1] as string);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.filter((name) => !RESERVED_SLUGS.has(name))).toEqual([]);
  });

  it("kök catch-all ve takip bağlantısı rotası birlikte var; çok parçalı link öneki catch-all'da kalır", () => {
    expect(existsSync(join(appDir, "[...link]", "page.tsx"))).toBe(true);
    expect(existsSync(join(appDir, "[slug]", "route.ts"))).toBe(true);
  });
});
