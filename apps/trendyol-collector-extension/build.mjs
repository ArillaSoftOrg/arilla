// Eklenti paketi: core'daki tarayici-guvenli modulleri tek dosyalara paketler (dist/).
// `--dev`: yalniz yerel gelistirme icin yonetim sayfasi eslesmesine http://localhost:3000 eklenir.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const dev = process.argv.includes("--dev");
await mkdir("dist", { recursive: true });
await build({
  entryPoints: { capture: "src/capture.ts", relay: "src/relay.ts", scheduler: "src/scheduler.ts" },
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "chrome120",
  minify: false,
  legalComments: "none",
  logLevel: "info",
  // Zamanlayicinin actigi TEK yonetim adresi (karar 0221). `--dev` yalniz yerel gelistirme.
  define: {
    __ADMIN_SCHEDULE_URL__: JSON.stringify(
      dev
        ? "http://localhost:3000/yonetim/katalog/toplama/trendyol?otomatik=1"
        : "https://www.manicepte.com/yonetim/katalog/toplama/trendyol?otomatik=1",
    ),
  },
});
if (dev) {
  const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
  manifest.content_scripts[1].matches.push(
    "http://localhost:3000/yonetim/katalog/toplama/trendyol*",
  );
  await writeFile("dist/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
} else {
  await copyFile("manifest.json", "dist/manifest.json");
}
