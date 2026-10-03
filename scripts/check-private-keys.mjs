#!/usr/bin/env node
/**
 * Özel anahtar koruması (docs/decisions/0050). Depoya hiçbir özel anahtar
 * girmez: Apple `.p8`, PEM, PKCS#12, SSH anahtarı. Anahtarlar ortam
 * değişkeninden okunur (docs/ops.md).
 *
 * İki denetim:
 * 1. İzlenen ya da sahnelenmiş (staged) dosyalar arasında anahtar adı veya
 *    PEM özel anahtar başlığı varsa hata.
 * 2. `.gitignore` bu adları gerçekten yok sayıyor mu (kural silinirse hata).
 *
 * Çıktıda yalnızca dosya YOLU yazılır, içerik asla.
 *
 *   node scripts/check-private-keys.mjs     (CI ve `pnpm check:secrets`)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const KEY_NAME =
  /(^|\/)(AuthKey_[^/]*|[^/]+\.(p8|pem|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\.[^/]*)?)$/i;
const PEM_PRIVATE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** `.gitignore` bunları yok saymalı. */
const MUST_IGNORE = [
  "AuthKey_TESTKEY01.p8",
  "apps/web/AuthKey_TESTKEY01.p8",
  "server.pem",
  "certs/client.p12",
  "store.pfx",
  "id_rsa",
  "id_ed25519",
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const problems = [];

const files = new Set(
  [
    ...git(["ls-files", "-z"]).split("\0"),
    ...git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).split("\0"),
  ].filter(Boolean),
);

for (const file of files) {
  if (KEY_NAME.test(file)) {
    problems.push(`anahtar dosyasi izleniyor: ${file}`);
    continue;
  }
  let content;
  try {
    content = readFileSync(file);
  } catch {
    continue; // silinmiş ya da alt modül
  }
  if (content.length > 2 * 1024 * 1024 || content.includes(0)) continue; // ikili/büyük
  if (PEM_PRIVATE.test(content.toString("utf8"))) {
    problems.push(`PEM ozel anahtar basligi iceriyor: ${file}`);
  }
}

for (const name of MUST_IGNORE) {
  try {
    git(["check-ignore", "--no-index", "-q", name]);
  } catch {
    problems.push(`.gitignore bu adi yok saymiyor: ${name}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`[check-private-keys] ${problem}`);
  console.error(
    "[check-private-keys] Anahtari depodan cikar, gerekiyorsa dondur (rotate). Bkz. docs/ops.md.",
  );
  process.exit(1);
}
console.log(`[check-private-keys] tamam (${files.size} dosya tarandi)`);
