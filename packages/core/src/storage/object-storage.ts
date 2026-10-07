/**
 * Obje deposu soyutlamasi - uygulamada AWS/R2 SDK'sini import eden TEK dosya.
 * Bilesenler ve is mantigi bu arayuze (`ObjectStorage`) baglanir; saglayici
 * degisirse yalnizca burasi degisir. Cloudflare R2, S3 uyumlu API ile
 * kullanilir (region "auto", hesap-ozel endpoint).
 */
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mediaUrl, normalizePublicBaseUrl } from "./media-url.ts";

export interface StorageConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
}

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface ObjectHead {
  size: number;
  contentType: string | undefined;
}

export interface ObjectStorage {
  put(input: PutObjectInput): Promise<void>;
  delete(key: string): Promise<void>;
  /** Yoksa null; baska hatalar firlatilir. */
  head(key: string): Promise<ObjectHead | null>;
  exists(key: string): Promise<boolean>;
  publicUrl(key: string): string;
}

const REQUIRED = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_PUBLIC_BASE_URL",
] as const;

/** Eksik/gecersiz ortam degiskeninde, DEGER yazmadan yalnizca AD ile hata verir. */
export function readStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`R2 yapilandirmasi eksik: ${missing.join(", ")}`);
  }
  const production = env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
  const publicBaseUrl = normalizePublicBaseUrl(env.R2_PUBLIC_BASE_URL, { production });
  if (publicBaseUrl === undefined) throw new Error("R2 yapilandirmasi eksik: R2_PUBLIC_BASE_URL");
  return {
    accountId: (env.R2_ACCOUNT_ID as string).trim(),
    accessKeyId: (env.R2_ACCESS_KEY_ID as string).trim(),
    secretAccessKey: (env.R2_SECRET_ACCESS_KEY as string).trim(),
    bucket: (env.R2_BUCKET_NAME as string).trim(),
    publicBaseUrl,
  };
}

export function createObjectStorage(config: StorageConfig, client?: S3Client): ObjectStorage {
  const s3 =
    client ??
    new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  const Bucket = config.bucket;

  async function head(key: string): Promise<ObjectHead | null> {
    try {
      const out = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
      return { size: out.ContentLength ?? 0, contentType: out.ContentType };
    } catch (error) {
      if (error instanceof NotFound || (error as { name?: string }).name === "NotFound") {
        return null;
      }
      throw error;
    }
  }

  return {
    async put({ key, body, contentType, cacheControl, metadata }) {
      await s3.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: cacheControl,
          Metadata: metadata,
        }),
      );
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    head,
    async exists(key) {
      return (await head(key)) !== null;
    },
    publicUrl: (key) => mediaUrl(config.publicBaseUrl, key),
  };
}
