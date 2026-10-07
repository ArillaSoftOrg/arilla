/**
 * Medya gorseli optimizasyon hatti. Gercek decode ile dogrular (content-type
 * veya uzantiya guvenmez), EXIF yonunu uygular, metadata'yi (GPS dahil)
 * atar, buyutmez, WebP (varsayilan) ya da AVIF uretir. Cikti deterministik:
 * ayni girdi + ayni sharp surumu -> ayni bayt -> ayni sha256 -> ayni anahtar.
 * SVG ve canli icerik riski nedeniyle vektor formatlar kabul edilmez.
 */
import { createHash } from "node:crypto";
import sharp, { type Metadata } from "sharp";
import type { MediaExtension } from "./media-keys.ts";

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_SOURCE_PIXELS = 50_000_000;
export const MAX_LONG_EDGE = 2400;

const ALLOWED_INPUT_FORMATS = new Set(["jpeg", "png", "webp", "avif", "heif", "gif"]);

export type ImageRejection = "too_large" | "decode" | "format" | "too_many_pixels";

export class MediaImageRejectedError extends Error {
  readonly reason: ImageRejection;
  constructor(reason: ImageRejection) {
    super(`gorsel reddedildi: ${reason}`);
    this.reason = reason;
    this.name = "MediaImageRejectedError";
  }
}

export interface ProcessedImage {
  bytes: Buffer;
  contentType: "image/webp" | "image/avif";
  extension: MediaExtension;
  width: number;
  height: number;
  sha256: string;
}

export interface ProcessImageOptions {
  format?: MediaExtension | undefined;
  /** 1-100. Varsayilan: webp 82, avif 60. */
  quality?: number | undefined;
}

export async function processImage(
  input: Buffer,
  options: ProcessImageOptions = {},
): Promise<ProcessedImage> {
  if (input.byteLength === 0 || input.byteLength > MAX_SOURCE_BYTES) {
    throw new MediaImageRejectedError("too_large");
  }
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    throw new MediaImageRejectedError("decode");
  }
  if (!meta.format || !ALLOWED_INPUT_FORMATS.has(meta.format)) {
    throw new MediaImageRejectedError("format");
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w <= 0 || h <= 0) throw new MediaImageRejectedError("decode");
  if (w * h > MAX_SOURCE_PIXELS) throw new MediaImageRejectedError("too_many_pixels");

  const extension = options.format ?? "webp";
  try {
    const pipeline = sharp(input, { limitInputPixels: MAX_SOURCE_PIXELS, failOn: "error" })
      .rotate()
      .resize({
        width: MAX_LONG_EDGE,
        height: MAX_LONG_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      });
    const encoded =
      extension === "avif"
        ? pipeline.avif({ quality: options.quality ?? 60 })
        : pipeline.webp({ quality: options.quality ?? 82 });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    return {
      bytes: data,
      contentType: extension === "avif" ? "image/avif" : "image/webp",
      extension,
      width: info.width,
      height: info.height,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  } catch {
    throw new MediaImageRejectedError("decode");
  }
}
