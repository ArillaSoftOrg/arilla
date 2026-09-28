/**
 * Oran siniri ve kayitlar (giris, riza) icin istemci IP'si. `x-forwarded-for`
 * zincirinin ILK elemani istemcinin kendi yazdigi degerdir, ona guvenilmez.
 *
 * - Vercel (`VERCEL=1`): platformun kendisinin yazdigi `x-real-ip`. Vercel
 *   istemciden gelen `x-forwarded-for`'u disari atip yeniden yazar; yine de
 *   `x-real-ip` yoksa zincirin SON elemani kullanilir.
 * - Diger ortamlar (yerel `next dev`, tek proxy arkasi): zincirin SON elemani,
 *   yani istemciye en yakin proxy'nin ekledigi adres. Istemci zincirin basina
 *   deger ekleyebilir ama sonunu belirleyemez.
 *
 * Gecerli bir IP degilse `null`: bozuk deger `inet` kolonuna yazilip istegi
 * dusurmez.
 */
import { isIP } from "node:net";

export interface HeaderReader {
  get(name: string): string | null;
}

function validIp(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && isIP(trimmed) !== 0 ? trimmed : null;
}

function lastForwardedFor(headers: HeaderReader): string | null {
  const entries = headers.get("x-forwarded-for")?.split(",") ?? [];
  return validIp(entries[entries.length - 1]);
}

export function resolveClientIp(
  headers: HeaderReader,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.VERCEL === "1") {
    return validIp(headers.get("x-real-ip")) ?? lastForwardedFor(headers);
  }
  return lastForwardedFor(headers);
}
