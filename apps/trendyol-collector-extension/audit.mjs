// Guvenlik denetimi (karar 0118): `pnpm test` paketi derleyip calistirir. Herhangi bir ihlal
// cikis kodunu 1 yapar. Manifest ve derlenmis paket birlikte sinanir.
import { readFile } from "node:fs/promises";

const failures = [];
const fail = (msg) => failures.push(msg);
const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));

// Karar 0221: arka plan betigi yalniz sekme ac/guncelle/kapat yapar; bunlar izin gerektirmez.
// `tabs`, `alarms`, `host_permissions` YOK (adres/baslik okunmaz, eklenti kendiliginden uyanmaz).
if (JSON.stringify(manifest.permissions ?? []) !== JSON.stringify(["storage"])) {
  fail(`izinler yalniz ["storage"] olmali: ${JSON.stringify(manifest.permissions)}`);
}
if (JSON.stringify(manifest.background) !== JSON.stringify({ service_worker: "scheduler.js" })) {
  fail(`arka plan yalniz scheduler.js olmali: ${JSON.stringify(manifest.background)}`);
}
for (const key of [
  "host_permissions",
  "optional_permissions",
  "optional_host_permissions",
  "externally_connectable",
  "web_accessible_resources",
  "content_security_policy",
]) {
  if (key in manifest) fail(`manifestte olmamali: ${key}`);
}
const [capture, relay, ...rest] = manifest.content_scripts ?? [];
if (rest.length) fail("en fazla iki icerik betigi");
if (JSON.stringify(capture?.matches) !== JSON.stringify(["https://www.trendyol.com/*"])) {
  fail("capture yalniz https://www.trendyol.com/* eslesmeli");
}
for (const p of ["hesabim", "sepet", "odeme", "siparis", "giris"]) {
  if (!capture?.exclude_matches?.some((m) => m.includes(`/${p}`)))
    fail(`capture /${p} disarida birakmali`);
}
const allowedRelay = [
  "https://manicepte.com/yonetim/katalog/toplama/trendyol*",
  "https://www.manicepte.com/yonetim/katalog/toplama/trendyol*",
];
for (const m of relay?.matches ?? []) {
  if (!allowedRelay.includes(m)) fail(`relay izinsiz eslesme: ${m}`);
}

const NETWORK =
  /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts)\s*\(|new\s+(XMLHttpRequest|WebSocket|EventSource)\b|\beval\s*\(|new\s+Function\s*\(/;
for (const file of ["dist/capture.js", "dist/relay.js", "dist/scheduler.js"]) {
  const code = await readFile(file, "utf8");
  const hit = NETWORK.exec(code);
  if (hit) fail(`${file}: ag/dinamik kod API'si bulundu: ${hit[0]}`);
  if (/chrome\.(cookies|webRequest|scripting|identity|history|downloads)\b/.test(code)) {
    fail(`${file}: izinsiz chrome API'si`);
  }
  // Sekme API'si yalniz arka plan zamanlayicisinda ve yalniz ac/guncelle/kapat.
  const tabs = [...code.matchAll(/chrome\.tabs\.([A-Za-z]+)/g)].map((m) => m[1]);
  if (file !== "dist/scheduler.js" && tabs.length) fail(`${file}: icerik betiginde sekme API'si`);
  for (const t of tabs) {
    if (!["create", "update", "remove"].includes(t)) fail(`${file}: izinsiz sekme API'si ${t}`);
  }
}
// Arka plan betigi yalniz Trendyol adresi acar; baska sabit adres tasimaz.
{
  const code = await readFile("dist/scheduler.js", "utf8");
  const urls = [...code.matchAll(/https?:\/\/[^"'`\s]+/g)].map((m) => m[0]);
  for (const u of urls) {
    if (!u.startsWith("https://www.trendyol.com")) fail(`dist/scheduler.js: izinsiz adres ${u}`);
  }
  if (/chrome\.alarms\b/.test(code)) fail("dist/scheduler.js: alarms kullanilmamali");
}

if (failures.length) {
  console.error(`Eklenti denetimi BASARISIZ:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(
  "Eklenti denetimi gecti: yalniz storage izni, ag istegi yok, izinli sayfalar; arka plan yalniz Trendyol sekmesi acar.",
);
