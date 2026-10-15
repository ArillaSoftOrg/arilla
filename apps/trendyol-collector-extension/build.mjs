// Eklenti paketi: core'daki tarayici-guvenli modulleri tek dosyalara paketler (dist/).
import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });
await build({
  entryPoints: { capture: "src/capture.ts", relay: "src/relay.ts" },
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "chrome120",
  minify: false,
  legalComments: "none",
  logLevel: "info",
});
await copyFile("manifest.json", "dist/manifest.json");
