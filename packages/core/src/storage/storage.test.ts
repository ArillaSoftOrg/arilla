import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { MediaImageRejectedError, processImage } from "./image-pipeline.ts";
import { buildMediaKey, isValidMediaKey } from "./media-keys.ts";
import { uploadImage } from "./media-service.ts";
import { mediaUrl, mediaUrlOr, normalizePublicBaseUrl } from "./media-url.ts";
import { createObjectStorage, type ObjectStorage, readStorageConfig } from "./object-storage.ts";

const HASH = "a".repeat(64);

async function png(width = 40, height = 20): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 10, b: 10 } },
  })
    .png()
    .toBuffer();
}

describe("buildMediaKey", () => {
  it("namespace + hash on eki ile deterministik anahtar uretir", () => {
    const key = buildMediaKey({ namespace: "blog", sha256: HASH, extension: "webp" });
    expect(key).toBe(`blog/${"a".repeat(32)}.webp`);
    expect(isValidMediaKey(key)).toBe(true);
  });

  it("scope'u anahtara katar", () => {
    const key = buildMediaKey({
      namespace: "products",
      scope: "kanepe-1",
      sha256: HASH,
      extension: "avif",
    });
    expect(key).toBe(`products/kanepe-1/${"a".repeat(32)}.avif`);
    expect(isValidMediaKey(key)).toBe(true);
  });

  it("gecersiz hash, scope ve namespace'i reddeder", () => {
    expect(() => buildMediaKey({ namespace: "blog", sha256: "x", extension: "webp" })).toThrow();
    expect(() =>
      buildMediaKey({ namespace: "blog", scope: "../x", sha256: HASH, extension: "webp" }),
    ).toThrow();
    expect(() =>
      buildMediaKey({ namespace: "evil" as "blog", sha256: HASH, extension: "webp" }),
    ).toThrow();
  });

  it("yol gecisi iceren anahtari gecersiz sayar", () => {
    expect(isValidMediaKey(`blog/../${"a".repeat(32)}.webp`)).toBe(false);
    expect(isValidMediaKey("blog/x.webp")).toBe(false);
  });
});

describe("media url", () => {
  it("sondaki slash'i kaldirir ve URL uretir", () => {
    const base = normalizePublicBaseUrl("https://media.example.com/", { production: true });
    expect(base).toBe("https://media.example.com");
    const key = buildMediaKey({ namespace: "blog", sha256: HASH, extension: "webp" });
    expect(mediaUrl(base as string, key)).toBe(`https://media.example.com/${key}`);
  });

  it("uretimde r2.dev ve http'yi reddeder, gelistirmede izin verir", () => {
    expect(() => normalizePublicBaseUrl("https://pub-x.r2.dev", { production: true })).toThrow(
      /r2\.dev/,
    );
    expect(() => normalizePublicBaseUrl("http://media.example.com", { production: true })).toThrow(
      /https/,
    );
    expect(normalizePublicBaseUrl("https://pub-x.r2.dev", { production: false })).toBeDefined();
  });

  it("baz URL yoksa fallback doner", () => {
    const key = buildMediaKey({ namespace: "blog", sha256: HASH, extension: "webp" });
    expect(mediaUrlOr(key, "/blog/x.svg", {})).toBe("/blog/x.svg");
    expect(mediaUrlOr(key, "/blog/x.svg", { R2_PUBLIC_BASE_URL: "https://m.example.com" })).toBe(
      `https://m.example.com/${key}`,
    );
  });
});

describe("readStorageConfig", () => {
  it("eksik degiskenleri yalnizca adlariyla bildirir", () => {
    const env = { R2_ACCOUNT_ID: "gizli-deger" };
    expect(() => readStorageConfig(env)).toThrow(
      /R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL/,
    );
    try {
      readStorageConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain("gizli-deger");
    }
  });

  it("tam ortami okur", () => {
    const config = readStorageConfig({
      R2_ACCOUNT_ID: "acc",
      R2_ACCESS_KEY_ID: "id",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET_NAME: "bucket",
      R2_PUBLIC_BASE_URL: "https://media.example.com/",
    });
    expect(config.publicBaseUrl).toBe("https://media.example.com");
  });
});

describe("processImage", () => {
  it("WebP uretir, deterministiktir, buyutmez", async () => {
    const source = await png();
    const a = await processImage(source);
    const b = await processImage(source);
    expect(a.contentType).toBe("image/webp");
    expect(a.sha256).toBe(b.sha256);
    expect([a.width, a.height]).toEqual([40, 20]);
  });

  it("AVIF secenegini destekler", async () => {
    const out = await processImage(await png(), { format: "avif" });
    expect(out.contentType).toBe("image/avif");
    expect(out.extension).toBe("avif");
  });

  it("gorsel olmayan, SVG ve bos girdiyi reddeder", async () => {
    await expect(processImage(Buffer.from("merhaba"))).rejects.toBeInstanceOf(
      MediaImageRejectedError,
    );
    await expect(
      processImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')),
    ).rejects.toMatchObject({ name: "MediaImageRejectedError" });
    await expect(processImage(Buffer.alloc(0))).rejects.toMatchObject({ reason: "too_large" });
  });

  it("boyut limitini asan girdiyi reddeder", async () => {
    await expect(processImage(Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toMatchObject({
      reason: "too_large",
    });
  });
});

function fakeStorage(existing: Set<string>): ObjectStorage & { put: ReturnType<typeof vi.fn> } {
  return {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    head: vi.fn(async () => null),
    exists: vi.fn(async (key: string) => existing.has(key)),
    publicUrl: (key: string) => `https://m.example.com/${key}`,
  };
}

describe("uploadImage", () => {
  it("yeni nesneyi immutable cache ile yukler", async () => {
    const storage = fakeStorage(new Set());
    const result = await uploadImage(storage, { namespace: "blog", source: await png() });
    expect(result.uploaded).toBe(true);
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(storage.put.mock.calls[0]?.[0]).toMatchObject({
      key: result.key,
      contentType: "image/webp",
      cacheControl: expect.stringContaining("immutable"),
    });
    expect(result.url).toBe(`https://m.example.com/${result.key}`);
  });

  it("ayni icerik zaten varsa yeniden yuklemez (dedup)", async () => {
    const source = await png();
    const first = await uploadImage(fakeStorage(new Set()), { namespace: "blog", source });
    const storage = fakeStorage(new Set([first.key]));
    const second = await uploadImage(storage, { namespace: "blog", source });
    expect(second.key).toBe(first.key);
    expect(second.uploaded).toBe(false);
    expect(storage.put).not.toHaveBeenCalled();
  });
});

describe("createObjectStorage", () => {
  const config = {
    accountId: "acc",
    accessKeyId: "id",
    secretAccessKey: "secret",
    bucket: "bucket",
    publicBaseUrl: "https://m.example.com",
  };

  it("head: NotFound -> null, exists false", async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { name: "NotFound" }));
    const storage = createObjectStorage(config, { send } as never);
    expect(await storage.head("blog/x")).toBeNull();
    expect(await storage.exists("blog/x")).toBe(false);
  });

  it("head: diger hatalari firlatir", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    const storage = createObjectStorage(config, { send } as never);
    await expect(storage.exists("blog/x")).rejects.toThrow("denied");
  });
});
