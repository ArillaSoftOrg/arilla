/**
 * Medya yukleme servisi: dogrula + optimize et + icerik-adresli anahtar +
 * dedup. Uygulamanin gorsel yuklemek icin cagirdigi tek yer; SDK'ya
 * dogrudan erismez (`ObjectStorage` arayuzu uzerinden).
 *
 * Presigned/direct-upload gerekirse ayni `processImage` + `buildMediaKey`
 * ciftinin ustune eklenir; bugun yok (gereksiz).
 */
import { type ProcessImageOptions, processImage } from "./image-pipeline.ts";
import { buildMediaKey, type MediaNamespace } from "./media-keys.ts";
import type { ObjectStorage } from "./object-storage.ts";

/** Anahtar icerige bagli oldugu icin nesne degismez; 1 yil immutable. */
export const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface UploadImageInput extends ProcessImageOptions {
  namespace: MediaNamespace;
  scope?: string | undefined;
  source: Buffer;
}

export interface PreparedUpload {
  key: string;
  body: Buffer;
  contentType: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface UploadedImage extends Omit<PreparedUpload, "body"> {
  url: string;
  /** false: ayni icerik zaten depodaydi, yeniden yuklenmedi. */
  uploaded: boolean;
}

/** Depoya dokunmadan: optimize et ve anahtari hesapla (dry-run, test). */
export async function prepareImageUpload(input: UploadImageInput): Promise<PreparedUpload> {
  const image = await processImage(input.source, input);
  const key = buildMediaKey({
    namespace: input.namespace,
    scope: input.scope,
    sha256: image.sha256,
    extension: image.extension,
  });
  return {
    key,
    body: image.bytes,
    contentType: image.contentType,
    width: image.width,
    height: image.height,
    bytes: image.bytes.byteLength,
    sha256: image.sha256,
  };
}

export async function uploadImage(
  storage: ObjectStorage,
  input: UploadImageInput,
): Promise<UploadedImage> {
  const { body, ...prepared } = await prepareImageUpload(input);
  const uploaded = !(await storage.exists(prepared.key));
  if (uploaded) {
    await storage.put({
      key: prepared.key,
      body,
      contentType: prepared.contentType,
      cacheControl: MEDIA_CACHE_CONTROL,
      metadata: { sha256: prepared.sha256 },
    });
  }
  return { ...prepared, url: storage.publicUrl(prepared.key), uploaded };
}
