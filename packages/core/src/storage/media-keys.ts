/**
 * Medya obje anahtari sozlesmesi (docs/decisions/0062). Saf, bagimliliksiz:
 * hem sunucu hem istemci tarafi guvenle import edebilir.
 *
 * Anahtar bicimi: `<namespace>/[<scope>/]<sha256 ilk 32 hex>.<uzanti>`.
 * Icerik-adresli: ayni baytlar ayni anahtari uretir (dedup), farkli icerik
 * asla ezilmez (collision-safe), nesneler degismez oldugu icin sinirsiz
 * onbellek (immutable) guvenlidir.
 */
export const MEDIA_NAMESPACES = ["blog", "products", "categories", "brands", "other"] as const;
export type MediaNamespace = (typeof MEDIA_NAMESPACES)[number];

export const MEDIA_EXTENSIONS = ["webp", "avif"] as const;
export type MediaExtension = (typeof MEDIA_EXTENSIONS)[number];

const SCOPE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const KEY_PATTERN = new RegExp(
  `^(${MEDIA_NAMESPACES.join("|")})/([a-z0-9][a-z0-9-]{0,63}/)?[0-9a-f]{32}\\.(${MEDIA_EXTENSIONS.join("|")})$`,
);

export interface MediaKeyInput {
  namespace: MediaNamespace;
  /** Opsiyonel gruplama (ornegin urun slug'i). Kucuk harf, rakam, tire. */
  scope?: string | undefined;
  /** Icerigin tam sha256 hex'i (kucuk harf). */
  sha256: string;
  extension: MediaExtension;
}

export function buildMediaKey(input: MediaKeyInput): string {
  if (!MEDIA_NAMESPACES.includes(input.namespace)) {
    throw new Error(`medya anahtari: bilinmeyen namespace "${input.namespace}"`);
  }
  if (!HASH_PATTERN.test(input.sha256)) throw new Error("medya anahtari: sha256 gecersiz");
  if (input.scope !== undefined && !SCOPE_PATTERN.test(input.scope)) {
    throw new Error(`medya anahtari: scope gecersiz "${input.scope}"`);
  }
  const scope = input.scope === undefined ? "" : `${input.scope}/`;
  return `${input.namespace}/${scope}${input.sha256.slice(0, 32)}.${input.extension}`;
}

export function isValidMediaKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}
