// Kaydedilmis GERCEK bir sayfa HTML'i uzerinde cikariciyi calistirir.
// Canli arama kaniti DEGILDIR; yalnizca cikarici gercek isaretlemeyi okuyabiliyor mu sinar.
//   node apps/live-search-extension/verify-capture.mjs <dosya.html> <origin> "<sorgu>"
import { readFileSync } from "node:fs";
import { extractFromPage } from "./extract.js";

const [file, origin, query] = process.argv.slice(2);
const html = readFileSync(file, "utf8");
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
const isLd = (attrs) => /application\/ld\+json/i.test(attrs);
const result = extractFromPage({
  scriptTexts: scripts.filter((m) => !isLd(m[1])).map((m) => m[2]),
  jsonLdTexts: scripts.filter((m) => isLd(m[1])).map((m) => m[2]),
  origin,
  query,
  checkedAt: new Date().toISOString(),
});
console.log(JSON.stringify(result, null, 2));
