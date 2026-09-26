/**
 * Kullanici yuklemesinin Jina'ya gitmeden once on islenmesi (docs/decisions/0030).
 *
 * Katalog tarafinin (`services/ingest/enrich/images.py`, `img512-v1`) ayni
 * sozlesmesi: `image-preprocess-contract.json`. Uygulama runtime'a gore ayri
 * (Pillow / sharp), degerler tek kaynaktan.
 *
 * - Gercek decode: `content-type` degil, piksel verisi dogrulanir.
 * - Asiri piksel (decompression bomb) decode'dan ONCE, basliktan reddedilir.
 * - EXIF yonu uygulanir, en-boy korunur, en uzun kenar <= 512, BUYUTULMEZ.
 * - Cikti JPEG (kalite 90), yalnizca gercek saydamlikta PNG. Metadata
 *   (EXIF/GPS dahil) cikarilir: sharp varsayilan olarak yazmaz.
 * - Deterministik: ayni girdi, ayni sharp surumu -> ayni bayt.
 * - Hicbir sey diske yazilmaz; tamamen bellekte (docs/kvkk.md).
 */
import sharp, { type Metadata } from "sharp";
import contract from "./image-preprocess-contract.json" with { type: "json" };

export const PREPROCESS_VERSION: string = contract.version;
export const TARGET_LONG_EDGE: number = contract.target_long_edge;
export const MAX_SOURCE_PIXELS: number = contract.max_source_pixels;

const ALLOWED_FORMATS = new Set<string>(contract.allowed_formats);

export class ImageRejectedError extends Error {
  constructor(readonly reason: "decode" | "format" | "too_many_pixels" | "token_guard") {
    super(`görsel reddedildi: ${reason}`);
    this.name = "ImageRejectedError";
  }
}

export interface PreparedImage {
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Saglayicinin karo formulu: 4000 x ceil(w/512) x ceil(h/512). */
  estimatedTokens: number;
}

export function estimateTokens(width: number, height: number): number {
  return (
    contract.tokens_per_tile *
    Math.ceil(width / contract.tile_edge) *
    Math.ceil(height / contract.tile_edge)
  );
}

/**
 * Tek istekte izin verilen en fazla tahmini token. On islemeden sonra her
 * gorsel tek karodur (4.000); bunun ustu sozlesmenin kirildigi anlamina gelir
 * ve istek saglayiciya GITMEZ.
 */
export const MAX_REQUEST_TOKENS = contract.tokens_per_tile;

export async function preprocessImage(input: Buffer): Promise<PreparedImage> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    throw new ImageRejectedError("decode");
  }
  if (!meta.format || !ALLOWED_FORMATS.has(meta.format === "heif" ? "avif" : meta.format)) {
    throw new ImageRejectedError("format");
  }
  const sourceWidth = meta.width ?? 0;
  const sourceHeight = meta.height ?? 0;
  if (sourceWidth <= 0 || sourceHeight <= 0) throw new ImageRejectedError("decode");
  if (sourceWidth * sourceHeight > MAX_SOURCE_PIXELS) {
    throw new ImageRejectedError("too_many_pixels");
  }

  try {
    const pipeline = sharp(input, { limitInputPixels: MAX_SOURCE_PIXELS, failOn: "error" })
      .rotate()
      .resize({
        width: TARGET_LONG_EDGE,
        height: TARGET_LONG_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      });
    const hasAlpha =
      meta.hasAlpha === true &&
      !(await sharp(input, { limitInputPixels: MAX_SOURCE_PIXELS }).stats()).isOpaque;
    const { data, info } = await (hasAlpha
      ? pipeline.png({ compressionLevel: 9 })
      : pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: contract.jpeg_quality })
    ).toBuffer({ resolveWithObject: true });

    const estimatedTokens = estimateTokens(info.width, info.height);
    if (estimatedTokens > MAX_REQUEST_TOKENS) throw new ImageRejectedError("token_guard");
    return {
      bytes: data,
      mimeType: hasAlpha ? "image/png" : "image/jpeg",
      width: info.width,
      height: info.height,
      sourceWidth,
      sourceHeight,
      estimatedTokens,
    };
  } catch (error) {
    if (error instanceof ImageRejectedError) throw error;
    throw new ImageRejectedError("decode");
  }
}
