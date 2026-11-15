/**
 * Web imajına derlenen sonda paketi (`pnpm probe:bundle`, `apps/web/Dockerfile`) üretimde
 * `SyntaxError: Identifier 'createRequire' has already been declared` ile açılmıyordu: paketlenen
 * bir bağımlılık da `createRequire` içe aktarıyordu ve `--banner` aynı adı yeniden bildiriyordu.
 * Hata yalnız üretimde (konteynerde çalıştırınca) görülüyordu; bu test paketin AYNI komutla
 * derlenip geçerli bir ES modülü olduğunu CI'da doğrular.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

describe("search-probe bundle", () => {
  it("compiles with the production command and parses as an ES module", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-bundle-"));
    try {
      const out = join(dir, "search-probe.mjs");
      const command = pkg.scripts["probe:bundle"]?.replace(
        "--outfile=dist/search-probe.mjs",
        `--outfile=${out}`,
      );
      expect(command).toBeTruthy();
      const build = spawnSync(`pnpm exec ${command}`, {
        cwd: new URL("..", import.meta.url),
        shell: true,
        encoding: "utf8",
      });
      expect(build.status, build.stderr).toBe(0);
      const check = spawnSync(process.execPath, ["--check", out], { encoding: "utf8" });
      expect(check.status, check.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
