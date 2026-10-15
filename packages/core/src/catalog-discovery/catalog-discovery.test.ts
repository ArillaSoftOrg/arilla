/**
 * Not: buradaki XML'ler SENTETIK test girdileridir (canli Hepsiburada verisi degil). Gercek
 * kaynaga istek atilmaz; ayristirici, sikistirma ve dongu kurallari sahte ortamla sinanir.
 */
import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { dedupeItems, itemFromSitemapEntry, validateDiscoveryItem } from "./items.ts";
import {
  networkLooksMetered,
  type RunnerEnv,
  runDiscovery,
  type SourceResponse,
} from "./runner.ts";
import {
  bodyToTextStream,
  detectEncoding,
  looksLikeHtml,
  MAX_ELEMENT_CHARS,
  SitemapIndexParser,
  SitemapParseError,
  SitemapUrlsetParser,
  xmlText,
} from "./sitemap-stream.ts";

const RULES = { urlHost: "hepsiburada.com", imageHost: "hepsiburada.net" };
const ORIGIN = "https://www.hepsiburada.com";

function urlEntry(code: string, title: string | null, kind: "pm" | "p" = "pm"): string {
  const image = title
    ? `<image:image><image:loc>https://productimages.hepsiburada.net/s/1/${code}.jpg</image:loc><image:title>${title}</image:title></image:image>`
    : "";
  return `<url><loc>${ORIGIN}/urun-adi-${kind}-${code}</loc>${image}</url>`;
}

function urlset(entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${entries.join("")}</urlset>`;
}

function sitemapIndex(locs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<sitemap><loc>${l}</loc><lastmod>2026-10-15T00:00:00+03:00</lastmod></sitemap>`)
    .join("")}</sitemapindex>`;
}

function streamOf(bytes: Uint8Array, chunk = 7): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

async function readAll(stream: ReadableStream<string>): Promise<string> {
  let out = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += value;
  }
}

describe("sitemap ayristirma", () => {
  it("urun sitemap'inden adres, gorsel ve gorsel basligini cikarir", () => {
    const parser = new SitemapUrlsetParser();
    const out = parser.push(urlset([urlEntry("HBC0000ABC1", "Apple iPhone 15 128 GB")]));
    expect(out).toEqual([
      {
        loc: `${ORIGIN}/urun-adi-pm-HBC0000ABC1`,
        imageLoc: "https://productimages.hepsiburada.net/s/1/HBC0000ABC1.jpg",
        imageTitle: "Apple iPhone 15 128 GB",
      },
    ]);
    expect(parser.end()).toEqual({ truncated: false, rootSeen: true });
  });

  it("her parca sinirinda ayni sonucu verir (akisli besleme)", () => {
    const xml = urlset([
      urlEntry("HBC0000ABC1", "Bir &amp; İki"),
      urlEntry("HBC0000ABC2", "<![CDATA[Üç <dört>]]>"),
      urlEntry("HBCV00009Z3XOE", null, "p"),
    ]);
    const whole = new SitemapUrlsetParser().push(xml);
    for (const size of [1, 2, 3, 5, 13, 64]) {
      const parser = new SitemapUrlsetParser();
      const got = [];
      for (let i = 0; i < xml.length; i += size) got.push(...parser.push(xml.slice(i, i + size)));
      expect(got).toEqual(whole);
      expect(parser.end().truncated).toBe(false);
    }
    expect(whole.map((e) => e.imageTitle)).toEqual(["Bir & İki", "Üç <dört>", null]);
  });

  it("baslik yoksa adresten uydurmaz", () => {
    const [entry] = new SitemapUrlsetParser().push(urlset([urlEntry("HBC0000ABC3", null)]));
    expect(entry?.imageTitle).toBeNull();
    expect(itemFromSitemapEntry(entry as never, RULES)?.title).toBeNull();
  });

  it("varlik ve sayisal karakter referanslarini cozer", () => {
    expect(xmlText("Kalem &#304;stanbul &#x15F;ekil &quot;x&quot;")).toBe(
      'Kalem İstanbul şekil "x"',
    );
  });

  it("indeks dosyalarini ve lastmod'u okur", () => {
    const parser = new SitemapIndexParser();
    const out = parser.push(sitemapIndex([`${ORIGIN}/sitemaps/product/sitemap-1.xml`]));
    expect(out).toEqual([
      { loc: `${ORIGIN}/sitemaps/product/sitemap-1.xml`, lastmod: "2026-10-15T00:00:00+03:00" },
    ]);
    expect(parser.end().rootSeen).toBe(true);
  });

  it("kesilmis dosyayi bildirir, yarim ogeyi dondurmez", () => {
    const xml = urlset([urlEntry("HBC0000ABC1", "A"), urlEntry("HBC0000ABC2", "B")]);
    const parser = new SitemapUrlsetParser();
    const out = parser.push(xml.slice(0, xml.length - 40));
    expect(out).toHaveLength(1);
    expect(parser.end().truncated).toBe(true);
  });

  it("tampon tek oge boyutunu asarsa durur (bellek siniri)", () => {
    const parser = new SitemapUrlsetParser();
    expect(() => parser.push(`<urlset><url><loc>${"x".repeat(MAX_ELEMENT_CHARS + 10)}`)).toThrow(
      SitemapParseError,
    );
  });

  it("HTML/dogrulama sayfasini tanir", () => {
    expect(looksLikeHtml("<!DOCTYPE html><html><body>captcha</body>")).toBe(true);
    expect(looksLikeHtml('<?xml version="1.0"?><urlset>')).toBe(false);
  });
});

describe("sikistirma", () => {
  const xml = urlset([urlEntry("HBC0000ABC1", "Ürün başlığı")]);
  const raw = new TextEncoder().encode(xml);

  it("sikistirilmamis govdeyi aynen okur ve bayt sayar", async () => {
    const r = await bodyToTextStream(streamOf(raw), `${ORIGIN}/s.xml`, { maxDecodedBytes: 1e6 });
    expect(await readAll(r.stream)).toBe(xml);
    expect(r.decodedBytes()).toBe(raw.byteLength);
  });

  it("gzip dosyasini sihirli bayttan tanir ve acar", async () => {
    const gz = new Uint8Array(gzipSync(raw));
    expect(detectEncoding(`${ORIGIN}/s.xml.gz`, gz)).toBe("gzip");
    const r = await bodyToTextStream(streamOf(gz), `${ORIGIN}/s.xml.gz`, { maxDecodedBytes: 1e6 });
    expect(await readAll(r.stream)).toBe(xml);
    expect(r.decodedBytes()).toBe(raw.byteLength);
  });

  it("Brotli (.br) dosyasini acar", async () => {
    const br = new Uint8Array(brotliCompressSync(raw));
    expect(detectEncoding(`${ORIGIN}/s.xml.br`, br)).toBe("br");
    const r = await bodyToTextStream(streamOf(br), `${ORIGIN}/s.xml.br`, { maxDecodedBytes: 1e6 });
    expect(await readAll(r.stream)).toBe(xml);
  });

  it("acilmis bayt siniri asilirsa durur (sikistirma bombasi)", async () => {
    const big = new TextEncoder().encode(
      urlset(Array.from({ length: 200 }, (_, i) => urlEntry(`HBC${1000 + i}X`, "a"))),
    );
    const gz = new Uint8Array(gzipSync(big));
    const r = await bodyToTextStream(streamOf(gz, 64), `${ORIGIN}/s.xml.gz`, {
      maxDecodedBytes: 500,
    });
    await expect(readAll(r.stream)).rejects.toMatchObject({ code: "decoded_limit" });
  });

  it("desteklenmeyen bicimde decode_unsupported verir", async () => {
    const br = new Uint8Array(brotliCompressSync(raw));
    await expect(
      bodyToTextStream(streamOf(br), `${ORIGIN}/s.xml.br`, {
        maxDecodedBytes: 1e6,
        decompressor: () => {
          throw new SitemapParseError("decode_unsupported");
        },
      }),
    ).rejects.toMatchObject({ code: "decode_unsupported" });
  });
});

describe("urun kimligi", () => {
  it("pm ve p kodlarini cikarir; urun olmayan adresi atar", () => {
    const pm = itemFromSitemapEntry(
      { loc: `${ORIGIN}/apple-iphone-15-pm-HBC0000ABC1?x=1`, imageLoc: null, imageTitle: "iPhone" },
      RULES,
    );
    expect(pm).toEqual({
      externalId: "HBC0000ABC1",
      codeKind: "pm",
      urlPath: "/apple-iphone-15-pm-HBC0000ABC1",
      title: "iPhone",
      imageUrl: null,
    });
    expect(
      itemFromSitemapEntry(
        { loc: `${ORIGIN}/kilif-p-HBCV00009Z3XOE`, imageLoc: null, imageTitle: null },
        RULES,
      )?.codeKind,
    ).toBe("p");
    expect(
      itemFromSitemapEntry(
        { loc: `${ORIGIN}/kategori-c-123`, imageLoc: null, imageTitle: null },
        RULES,
      ),
    ).toBeNull();
    expect(
      itemFromSitemapEntry(
        { loc: "https://evil.example/x-pm-HBC0000ABC1", imageLoc: null, imageTitle: null },
        RULES,
      ),
    ).toBeNull();
  });

  it("baska alan adindaki gorseli almaz", () => {
    const item = itemFromSitemapEntry(
      {
        loc: `${ORIGIN}/a-pm-HBC0000ABC1`,
        imageLoc: "https://cdn.evil.example/a.jpg",
        imageTitle: "A",
      },
      RULES,
    );
    expect(item?.imageUrl).toBeNull();
  });

  it("sunucu dogrulamasi kimligi yoldan yeniden cikarir (istemciye guvenmez)", () => {
    const base = {
      externalId: "HBC0000ABC1",
      codeKind: "pm",
      urlPath: "/a-pm-HBC0000ABC1",
      title: "A",
      imageUrl: null,
    };
    expect(validateDiscoveryItem(base, RULES).ok).toBe(true);
    expect(validateDiscoveryItem({ ...base, externalId: "HBC0000XXXX" }, RULES)).toEqual({
      ok: false,
      code: "external_id",
    });
    expect(validateDiscoveryItem({ ...base, codeKind: "p" }, RULES)).toEqual({
      ok: false,
      code: "code_kind",
    });
    expect(
      validateDiscoveryItem({ ...base, urlPath: "//evil.example/a-pm-HBC0000ABC1" }, RULES),
    ).toEqual({ ok: false, code: "url" });
    expect(validateDiscoveryItem({ ...base, urlPath: "/a-pm-HBC0000ABC1?x=1" }, RULES)).toEqual({
      ok: false,
      code: "url",
    });
    expect(validateDiscoveryItem({ ...base, title: "x".repeat(501) }, RULES)).toEqual({
      ok: false,
      code: "title",
    });
    // Fiyat alani kabul edilmez: bilinmeyen alan atilir.
    const r = validateDiscoveryItem({ ...base, priceMinor: 1 }, RULES);
    expect(r.ok && "priceMinor" in r.item).toBe(false);
  });

  it("parti icindeki tekrari ayiklar", () => {
    const a = {
      externalId: "A1234",
      codeKind: "pm" as const,
      urlPath: "/a-pm-A1234",
      title: null,
      imageUrl: null,
    };
    const { unique, duplicates } = dedupeItems([a, { ...a, title: "Yeni" }]);
    expect(unique).toHaveLength(1);
    expect(unique[0]?.title).toBe("Yeni");
    expect(duplicates).toBe(1);
  });
});

describe("ag beyani", () => {
  it("mobil ve veri tasarrufu belirtisini tanir", () => {
    expect(networkLooksMetered({ type: "cellular" })).toBe(true);
    expect(networkLooksMetered({ saveData: true })).toBe(true);
    expect(networkLooksMetered({ type: "wifi", effectiveType: "4g" })).toBe(false);
    expect(networkLooksMetered(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dongu (sahte sunucu + sahte kaynak)
// ---------------------------------------------------------------------------

interface FakeUnit {
  seq: number;
  unitKind: "index" | "file";
  url: string;
}

function fakeEnv(opts: {
  units: FakeUnit[];
  responses: Record<string, SourceResponse | Error>;
  waits?: { waitMs: number; reason: string }[];
  maxFiles?: number;
  stopAfter?: number;
}) {
  const calls: Record<string, unknown>[] = [];
  const fetched: string[] = [];
  const sleeps: number[] = [];
  const queue = [...opts.units];
  const waits = [...(opts.waits ?? [])];
  let claims = 0;
  const env: RunnerEnv = {
    operationId: 1,
    clientId: "client-0001",
    rules: RULES,
    batchSize: 2,
    maxFilesThisSession: opts.maxFiles ?? 100,
    maxWaitMs: 60_000,
    log: () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    shouldStop: () => opts.stopAfter !== undefined && claims >= opts.stopAfter,
    async fetchSource(url) {
      fetched.push(url);
      const r = opts.responses[url];
      if (r instanceof Error) throw r;
      if (!r) return { status: 404, contentType: null, contentLength: null, body: null };
      return r;
    },
    async api(body) {
      calls.push(body);
      if (body.op === "claim") {
        claims += 1;
        const w = waits.shift();
        if (w) return { ok: true, status: 200, data: { kind: "wait", ...w } };
        const u = queue.shift();
        if (!u) return { ok: true, status: 200, data: { kind: "done", status: "completed" } };
        return {
          ok: true,
          status: 200,
          data: { kind: "unit", ...u, attempt: 1, maxDecodedBytes: 1e7 },
        };
      }
      if (body.op === "items") {
        return {
          ok: true,
          status: 200,
          data: { inserted: (body.items as unknown[]).length, rejected: 0 },
        };
      }
      if (body.op === "plan") {
        return {
          ok: true,
          status: 200,
          data: { filesPlanned: (body.files as unknown[]).length, rejected: 0 },
        };
      }
      return { ok: true, status: 200, data: {} };
    },
  };
  return { env, calls, fetched, sleeps };
}

function xmlResponse(xml: string): SourceResponse {
  const bytes = new TextEncoder().encode(xml);
  return {
    status: 200,
    contentType: "application/xml",
    contentLength: bytes.byteLength,
    body: streamOf(bytes, 50),
  };
}

const INDEX_URL = `${ORIGIN}/sitemaps/product/sitemap.xml`;
const FILE1 = `${ORIGIN}/sitemaps/product/sitemap-1.xml`;
const FILE2 = `${ORIGIN}/sitemaps/product/sitemap-2.xml`;

describe("kesif dongusu", () => {
  it("indeksi planlar, dosyalari partiler halinde gonderir ve tamamlar", async () => {
    const { env, calls } = fakeEnv({
      units: [
        { seq: 0, unitKind: "index", url: INDEX_URL },
        { seq: 1, unitKind: "file", url: FILE1 },
      ],
      responses: {
        [INDEX_URL]: xmlResponse(sitemapIndex([FILE1, FILE2])),
        [FILE1]: xmlResponse(
          urlset([
            urlEntry("HBC0000AA01", "A"),
            urlEntry("HBC0000AA02", "B"),
            urlEntry("HBC0000AA03", "C"),
          ]),
        ),
      },
    });
    expect(await runDiscovery(env)).toBe("completed");
    const plan = calls.find((c) => c.op === "plan");
    expect(plan?.files).toHaveLength(2);
    expect(plan?.final).toBe(true);
    const items = calls.filter((c) => c.op === "items");
    // batchSize 2: iki parti; ikinci parti final ve istatistik tasir.
    expect(items.map((c) => [c.batchIndex, (c.items as unknown[]).length, c.final])).toEqual([
      [0, 2, false],
      [1, 1, true],
    ]);
    expect(items[1]?.stats).toMatchObject({ itemsFound: 3 });
    // Fiyat alani gonderilmez.
    expect(JSON.stringify(items)).not.toMatch(/price/i);
  });

  it("403'te engel bildirir ve durur; yeniden denemez", async () => {
    const { env, calls, fetched } = fakeEnv({
      units: [
        { seq: 1, unitKind: "file", url: FILE1 },
        { seq: 2, unitKind: "file", url: FILE2 },
      ],
      responses: {
        [FILE1]: { status: 403, contentType: "text/html", contentLength: 1755, body: null },
      },
    });
    expect(await runDiscovery(env)).toBe("blocked");
    expect(fetched).toEqual([FILE1]);
    expect(calls.find((c) => c.op === "fail")).toMatchObject({
      outcome: "blocked",
      errorCode: "http_403",
    });
  });

  it("429 de engeldir", async () => {
    const { env, calls } = fakeEnv({
      units: [{ seq: 1, unitKind: "file", url: FILE1 }],
      responses: { [FILE1]: { status: 429, contentType: null, contentLength: null, body: null } },
    });
    expect(await runDiscovery(env)).toBe("blocked");
    expect(calls.find((c) => c.op === "fail")).toMatchObject({ errorCode: "http_429" });
  });

  it("200 ile gelen dogrulama sayfasi engeldir", async () => {
    const html = new TextEncoder().encode(
      "<!DOCTYPE html><html><body>Lütfen captcha doğrulayın</body></html>",
    );
    const { env, calls } = fakeEnv({
      units: [{ seq: 1, unitKind: "file", url: FILE1 }],
      responses: {
        [FILE1]: {
          status: 200,
          contentType: "application/xml",
          contentLength: null,
          body: streamOf(html, 100),
        },
      },
    });
    expect(await runDiscovery(env)).toBe("blocked");
    expect(calls.find((c) => c.op === "fail")).toMatchObject({ errorCode: "challenge_page" });
  });

  it("ag hatasi engel sayilmaz; dosya hatali, oturum durur (operasyon acik)", async () => {
    const err = new TypeError("Failed to fetch");
    const { env, calls } = fakeEnv({
      units: [{ seq: 1, unitKind: "file", url: FILE1 }],
      responses: { [FILE1]: err },
    });
    expect(await runDiscovery(env)).toBe("network");
    expect(calls.find((c) => c.op === "fail")).toMatchObject({
      outcome: "failed",
      errorCode: "network_error",
    });
    expect(calls.some((c) => c.op === "pause")).toBe(false);
  });

  it("404 dosyayi hatali yapar, sonrakine gecer", async () => {
    const { env, calls } = fakeEnv({
      units: [
        { seq: 1, unitKind: "file", url: FILE1 },
        { seq: 2, unitKind: "file", url: FILE2 },
      ],
      responses: { [FILE2]: xmlResponse(urlset([urlEntry("HBC0000AA01", "A")])) },
    });
    expect(await runDiscovery(env)).toBe("completed");
    expect(calls.find((c) => c.op === "fail")).toMatchObject({ seq: 1, errorCode: "http_404" });
    expect(calls.some((c) => c.op === "items" && c.seq === 2 && c.final === true)).toBe(true);
  });

  it("art arda hatalarda durur", async () => {
    const { env } = fakeEnv({
      units: [1, 2, 3, 4].map((seq) => ({
        seq,
        unitKind: "file" as const,
        url: `${ORIGIN}/sitemaps/product/x-${seq}.xml`,
      })),
      responses: {},
    });
    expect(await runDiscovery(env)).toBe("error");
  });

  it("kesilmis dosyayi hatali bildirir; gonderilen partiler idempotent", async () => {
    const xml = urlset([
      urlEntry("HBC0000AA01", "A"),
      urlEntry("HBC0000AA02", "B"),
      urlEntry("HBC0000AA03", "C"),
    ]);
    const { env, calls } = fakeEnv({
      units: [{ seq: 1, unitKind: "file", url: FILE1 }],
      responses: { [FILE1]: xmlResponse(xml.slice(0, xml.length - 30)) },
    });
    await runDiscovery(env);
    expect(calls.find((c) => c.op === "fail")).toMatchObject({
      outcome: "failed",
      errorCode: "truncated",
    });
    expect(calls.some((c) => c.op === "items" && c.final === true)).toBe(false);
  });

  it("sunucunun bekleme istegine uyar; uzun beklemede (gunluk tavan) durur", async () => {
    const short = fakeEnv({
      units: [],
      responses: {},
      waits: [{ waitMs: 5000, reason: "interval" }],
    });
    expect(await runDiscovery(short.env)).toBe("completed");
    expect(short.sleeps).toEqual([5000]);
    const long = fakeEnv({
      units: [],
      responses: {},
      waits: [{ waitMs: 3_600_000, reason: "daily_limit" }],
    });
    expect(await runDiscovery(long.env)).toBe("daily_limit");
    expect(long.sleeps).toEqual([]);
  });

  it("oturum dosya sinirinda duraklatir", async () => {
    const { env, calls } = fakeEnv({
      units: [
        { seq: 1, unitKind: "file", url: FILE1 },
        { seq: 2, unitKind: "file", url: FILE2 },
      ],
      responses: {
        [FILE1]: xmlResponse(urlset([urlEntry("HBC0000AA01", "A")])),
        [FILE2]: xmlResponse(urlset([urlEntry("HBC0000AA02", "B")])),
      },
      maxFiles: 1,
    });
    expect(await runDiscovery(env)).toBe("session_limit");
    expect(calls.at(-1)?.op).toBe("pause");
  });

  it("durdurma isteginde duraklatir", async () => {
    const { env, calls } = fakeEnv({
      units: [{ seq: 1, unitKind: "file", url: FILE1 }],
      responses: {},
      stopAfter: 0,
    });
    expect(await runDiscovery(env)).toBe("paused");
    expect(calls.map((c) => c.op)).toEqual(["pause"]);
  });
});
