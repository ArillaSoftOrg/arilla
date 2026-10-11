/**
 * Dis (uceuncu taraf) sayfalar icin SSRF-guvenli, sinirli HTTP istemcisi
 * (docs/decisions/0102, gorsel cozumleme). Yalnizca `store-image.ts` kullanir.
 *
 * - yalnizca https, standart port, kimliksiz (`toSafePublicUrl`);
 * - DNS cozumu BAGLANTI ANINDA dogrulanir (`lookup`): ozel/loopback/link-local
 *   adresler reddedilir; cozum ile baglanti arasinda adres degisemez (rebinding);
 * - yonlendirme elle, en fazla 2 adim; her adim yeniden dogrulanir;
 * - govde `maxBytes`'ta kesilir, sikistirma istenmez (bomba yok), zaman asimi;
 * - cerez/kimlik gonderilmez; acik bir User-Agent ile kimlik verilir.
 */
import { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import { toSafePublicUrl } from "./url-safety.ts";

export const WEB_FETCH_USER_AGENT = "ManiCepteBot/1.0 (+https://manicepte.com)";
const MAX_REDIRECTS = 2;

/** Genel (yonlendirilebilir) bir IP mi; ozel/ayrilmis araliklar `false`. */
export function isPublicIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const p = address.split(".").map(Number);
    const [a = 0, b = 0] = p;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && p[2] === 0) || (b === 0 && p[2] === 2)))
      return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && p[2] === 100))) return false;
    if (a === 203 && b === 0 && p[2] === 113) return false;
    return true;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPublicIp(mapped[1]);
    if (lower === "::" || lower === "::1") return false;
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff")) return false;
    if (lower.startsWith("2001:db8") || lower.startsWith("64:ff9b")) return false;
    return true;
  }
  return false;
}

export interface SafeResponse {
  status: number;
  contentType: string;
  contentLength: number | null;
  /** Kesilmis govde (`maxBytes` kadar). Yalnizca baslik istendiyse bos. */
  body: Buffer;
  finalUrl: string;
}

export interface SafeGetOptions {
  maxBytes: number;
  timeoutMs: number;
  accept: string;
  /** `true`: govde okunmaz, yalnizca basliklar (gorsel turu/boyut denetimi). */
  headersOnly?: boolean;
  signal?: AbortSignal;
  /** Test icin: DNS cozumu. */
  lookup?: typeof dnsLookup;
}

function once(
  rawUrl: string,
  options: SafeGetOptions,
): Promise<SafeResponse & { location: string | null }> {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const resolver = options.lookup ?? dnsLookup;
    const req = request(
      url,
      {
        method: "GET",
        timeout: options.timeoutMs,
        headers: {
          "User-Agent": WEB_FETCH_USER_AGENT,
          Accept: options.accept,
          "Accept-Encoding": "identity",
          "Accept-Language": "tr-TR,tr;q=0.9",
        },
        lookup: (hostname, lookupOptions, callback) => {
          resolver(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
            if (error) return callback(error, "", 4);
            const list = Array.isArray(addresses) ? addresses : [];
            const first = list[0];
            if (!first || list.some((a) => !isPublicIp(a.address))) {
              return callback(new Error("blocked_address"), "", 4);
            }
            if ((lookupOptions as { all?: boolean }).all) {
              return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
            }
            callback(null, first.address, first.family);
          });
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
        const lengthHeader = Number(res.headers["content-length"]);
        const contentLength = Number.isFinite(lengthHeader) ? lengthHeader : null;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        const finish = (body: Buffer) =>
          resolve({ status, contentType, contentLength, body, finalUrl: rawUrl, location });
        if (options.headersOnly || (status >= 300 && status < 400)) {
          res.destroy();
          finish(Buffer.alloc(0));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          chunks.push(chunk);
          if (size >= options.maxBytes) res.destroy();
        });
        res.on("close", () => finish(Buffer.concat(chunks).subarray(0, options.maxBytes)));
        res.on("error", () => finish(Buffer.concat(chunks).subarray(0, options.maxBytes)));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    options.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")), {
      once: true,
    });
    req.end();
  });
}

/** Guvenli GET; gecersiz adres/hedef/yonlendirme icin `null` doner (asla firlatmaz). */
export async function safeGet(
  rawUrl: string,
  options: SafeGetOptions,
): Promise<SafeResponse | null> {
  let current = toSafePublicUrl(rawUrl)?.url ?? null;
  for (let hop = 0; hop <= MAX_REDIRECTS && current !== null; hop++) {
    let response: Awaited<ReturnType<typeof once>>;
    try {
      response = await once(current, options);
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      let next: string | null = null;
      try {
        next = response.location ? new URL(response.location, current).toString() : null;
      } catch {
        next = null;
      }
      current = next === null ? null : (toSafePublicUrl(next)?.url ?? null);
      continue;
    }
    const { location: _location, ...rest } = response;
    return { ...rest, finalUrl: current };
  }
  return null;
}
