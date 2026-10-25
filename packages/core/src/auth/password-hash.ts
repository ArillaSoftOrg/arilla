/**
 * Sifre ozeti: Argon2id (RFC 9106), Node'un yerlesik `crypto.argon2`'si
 * (Node >= 24.7; ek yerel bagimlilik yok). Cikti PHC dizgisidir:
 * `$argon2id$v=19$m=19456,t=2,p=1$<tuz>$<ozet>` - parametreler ozetin icinde
 * tasinir, ileride artirilirsa eski ozetler dogrulanir ve giriste yenilenir
 * (`passwordNeedsRehash`). Varsayilanlar OWASP Password Storage Cheat Sheet'in
 * Argon2id onerisidir (19 MiB, 2 gecis, 1 kulvar).
 *
 * Duz metin sifre bu dosyanin disina cikmaz: loglanmaz, hata mesajina girmez.
 * Sifre NFKC ile normalize edilir (ayni parolanin farkli cihaz klavyelerinde
 * farkli kod noktasi uretmesi girisi bozmasin).
 */
import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "argon2id";
const VERSION = 19;
const SALT_BYTES = 16;
const TAG_BYTES = 32;

export interface Argon2Params {
  /** KiB. */
  memory: number;
  passes: number;
  parallelism: number;
}

export const DEFAULT_ARGON2_PARAMS: Argon2Params = { memory: 19_456, passes: 2, parallelism: 1 };

export class PasswordHashUnavailableError extends Error {
  constructor() {
    super("crypto.argon2 yok: Node.js >= 24.7 gerekir");
    this.name = "PasswordHashUnavailableError";
  }
}

/** Node surumu `crypto.argon2`'yi sunuyor mu (>= 24.7). */
export function isPasswordHashingAvailable(): boolean {
  return typeof argon2 === "function";
}

function derive(
  message: Buffer,
  nonce: Buffer,
  params: Argon2Params,
  tagLength: number,
): Promise<Buffer> {
  if (typeof argon2 !== "function") return Promise.reject(new PasswordHashUnavailableError());
  return new Promise((resolve, reject) => {
    argon2(
      ALGORITHM,
      { message, nonce, ...params, tagLength },
      (error: Error | null, key: Buffer) => (error ? reject(error) : resolve(key)),
    );
  });
}

function passwordBytes(password: string): Buffer {
  return Buffer.from(password.normalize("NFKC"), "utf8");
}

export async function hashPassword(
  password: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(passwordBytes(password), salt, params, TAG_BYTES);
  const { memory, passes, parallelism } = params;
  return `$${ALGORITHM}$v=${VERSION}$m=${memory},t=${passes},p=${parallelism}$${salt.toString("base64url")}$${tag.toString("base64url")}`;
}

interface ParsedHash {
  params: Argon2Params;
  salt: Buffer;
  tag: Buffer;
}

const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

/** Ozet bozuksa ya da desteklenmeyen bir algoritmaysa `null`. */
export function parsePasswordHash(hash: string): ParsedHash | null {
  const match = PHC_PATTERN.exec(hash);
  if (!match) return null;
  const params = {
    memory: Number(match[1]),
    passes: Number(match[2]),
    parallelism: Number(match[3]),
  };
  // Kotu niyetli/bozuk satirin sunucuyu bellek ya da sureyle tuketmesini onler.
  if (
    params.memory < 8 * params.parallelism ||
    params.memory > 262_144 ||
    params.passes < 1 ||
    params.passes > 10 ||
    params.parallelism < 1 ||
    params.parallelism > 8
  ) {
    return null;
  }
  const salt = Buffer.from(match[4] ?? "", "base64url");
  const tag = Buffer.from(match[5] ?? "", "base64url");
  if (salt.length < 8 || tag.length < 16) return null;
  return { params, salt, tag };
}

/** Sabit zamanli karsilastirma. Bozuk ozet `false` doner, hata firlatmaz. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parsed = parsePasswordHash(hash);
  if (!parsed) return false;
  const candidate = await derive(
    passwordBytes(password),
    parsed.salt,
    parsed.params,
    parsed.tag.length,
  );
  return candidate.length === parsed.tag.length && timingSafeEqual(candidate, parsed.tag);
}

/** Parametreler varsayilanin altindaysa giris sonrasi ozet yenilenmelidir. */
export function passwordNeedsRehash(
  hash: string,
  target: Argon2Params = DEFAULT_ARGON2_PARAMS,
): boolean {
  const parsed = parsePasswordHash(hash);
  if (!parsed) return true;
  return (
    parsed.params.memory < target.memory ||
    parsed.params.passes < target.passes ||
    parsed.params.parallelism !== target.parallelism
  );
}

let dummyHash: Promise<string> | undefined;

/**
 * Var olmayan hesap icin de ayni maliyette bir dogrulama calistirmak icin:
 * yanit suresi hesabin varligini belli etmez. Sonuc her zaman `false` sayilir.
 */
export async function burnPasswordVerification(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await dummyHash);
}
