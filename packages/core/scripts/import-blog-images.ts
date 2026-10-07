/**
 * Blog gorsellerini `blog-sources.json` listesindeki kaynak URL'lerden indirir, optimize eder (WebP), R2'ye
 * yukler ve `apps/web/app/blog/blog-images.json` manifestini yazar. Blog
 * kayitlari (`blog-posts.ts`) gorseli bu manifestteki obje anahtarindan,
 * `R2_PUBLIC_BASE_URL` ile uretir.
 *
 * Kullanim:
 *   pnpm --filter @arilla/core media:import-blog --dry-run   # indir + optimize + manifest; R2'ye DOKUNMAZ
 *   pnpm --filter @arilla/core media:import-blog             # + R2'ye yukle (R2_* ortam degiskenleri gerekir)
 *
 * Idempotent: anahtar icerik hash'inden turer; nesne zaten varsa yuklenmez.
 * Yalnizca asagidaki izinli kaynak host'larindan indirir (SSRF yuzeyi yok).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SOURCE_BYTES } from "../src/storage/image-pipeline.ts";
import { prepareImageUpload, uploadImage } from "../src/storage/media-service.ts";
import { createObjectStorage, readStorageConfig } from "../src/storage/object-storage.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const MANIFEST_PATH = join(repoRoot, "apps/web/app/blog/blog-images.json");

const ALLOWED_SOURCE_HOSTS = new Set(["us-west-2.graphassets.com"]);

const SOURCES_PATH = join(repoRoot, "apps/web/app/blog/blog-sources.json");

interface BlogSource {
  id: string;
  url: string;
}

const SOURCES: readonly BlogSource[] = JSON.parse(readFileSync(SOURCES_PATH, "utf8"));

function loadDotEnv(): void {
  for (const candidate of [join(repoRoot, ".env"), join(repoRoot, ".env.local")]) {
    let raw: string;
    try {
      raw = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (key === undefined || rawValue === undefined) continue;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
    }
  }
}

async function download(rawUrl: string): Promise<Buffer> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || !ALLOWED_SOURCE_HOSTS.has(url.hostname)) {
    throw new Error(`izinli olmayan kaynak host: ${url.hostname}`);
  }
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`indirme basarisiz: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_SOURCE_BYTES) throw new Error("kaynak cok buyuk");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error("kaynak cok buyuk");
  return bytes;
}

async function main(): Promise<void> {
  loadDotEnv();
  const dryRun = process.argv.includes("--dry-run");
  const storage = dryRun ? undefined : createObjectStorage(readStorageConfig());

  const manifest: Record<string, unknown> = {};
  for (const source of SOURCES) {
    const input = { namespace: "blog", source: await download(source.url) } as const;
    let entry: Record<string, unknown>;
    if (storage) {
      const { url: _url, ...result } = await uploadImage(storage, input);
      entry = result;
      console.log(`${source.id}: ${result.key} (${result.uploaded ? "yuklendi" : "zaten vardi"})`);
    } else {
      const { body: _body, ...result } = await prepareImageUpload(input);
      entry = result;
      console.log(`${source.id}: ${result.key} (dry-run, yuklenmedi)`);
    }
    manifest[source.id] = { ...entry, sourceUrl: source.url };
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
