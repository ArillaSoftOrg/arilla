import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  ImageRejectedError,
  MAX_REQUEST_TOKENS,
  preprocessImage,
} from "./preprocess-image.ts";

async function solid(width: number, height: number, alpha = false): Promise<Buffer> {
  const image = sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 200, g: 10, b: 10, alpha: 0.5 } : { r: 200, g: 10, b: 10 },
    },
  });
  return alpha ? image.png().toBuffer() : image.jpeg().toBuffer();
}

async function rejectionReason(input: Buffer): Promise<string | undefined> {
  try {
    await preprocessImage(input);
  } catch (error) {
    if (error instanceof ImageRejectedError) return error.reason;
    throw error;
  }
  return undefined;
}

describe("preprocessImage", () => {
  it("downscales landscape and portrait to a 512 longest edge, keeping aspect ratio", async () => {
    const landscape = await preprocessImage(await solid(2048, 1024));
    expect([landscape.width, landscape.height]).toEqual([512, 256]);
    expect([landscape.sourceWidth, landscape.sourceHeight]).toEqual([2048, 1024]);
    const portrait = await preprocessImage(await solid(1000, 2000));
    expect([portrait.width, portrait.height]).toEqual([256, 512]);
  });

  it("never upscales small images", async () => {
    const small = await preprocessImage(await solid(300, 200));
    expect([small.width, small.height]).toEqual([300, 200]);
  });

  it("applies EXIF orientation before resizing", async () => {
    // 1000x500 piksel, EXIF 6 = 90 derece dondurulmus: gorunen 500x1000.
    const rotated = await sharp(await solid(1000, 500))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const out = await preprocessImage(rotated);
    expect([out.width, out.height]).toEqual([256, 512]);
  });

  it("outputs JPEG without metadata, PNG only for real transparency", async () => {
    const withExif = await sharp(await solid(800, 600))
      .withMetadata({ exif: { IFD0: { Copyright: "kisisel" } } })
      .jpeg()
      .toBuffer();
    const jpeg = await preprocessImage(withExif);
    expect(jpeg.mimeType).toBe("image/jpeg");
    expect((await sharp(jpeg.bytes).metadata()).exif).toBeUndefined();

    const png = await preprocessImage(await solid(800, 600, true));
    expect(png.mimeType).toBe("image/png");
  });

  it("is deterministic", async () => {
    const input = await solid(1500, 900);
    const [a, b] = await Promise.all([preprocessImage(input), preprocessImage(input)]);
    expect(a.bytes.equals(b.bytes)).toBe(true);
  });

  it("rejects bytes that are not a decodable image, and unsupported formats", async () => {
    expect(await rejectionReason(Buffer.from("bu bir gorsel degil"))).toBe("decode");
    const gif = await sharp(await solid(10, 10))
      .gif()
      .toBuffer();
    expect(await rejectionReason(gif)).toBe("format");
  });

  it("rejects absurd pixel counts from the header, before decoding", async () => {
    const huge = await sharp({
      create: { width: 8000, height: 6000, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png({ compressionLevel: 1 })
      .toBuffer();
    expect(await rejectionReason(huge)).toBe("too_many_pixels");
  });

  it("keeps every request within one tile after preprocessing", async () => {
    expect(estimateTokens(512, 512)).toBe(MAX_REQUEST_TOKENS);
    expect(estimateTokens(2048, 1536)).toBe(48_000);
    const out = await preprocessImage(await solid(4000, 3000));
    expect(out.estimatedTokens).toBeLessThanOrEqual(MAX_REQUEST_TOKENS);
  });
});
