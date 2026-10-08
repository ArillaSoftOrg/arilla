/**
 * Cok pencereli kullanici kotasi (Redis): saat/gun/hafta/ay sayaclari TEK bir
 * Lua betiginde kontrol edilir ve ya hepsi birden artar ya hicbiri. Boylece
 * reddedilen istek hicbir pencereyi yakmaz (saatlik siniri dolan kullanici
 * aylik hakkini tuketmez) ve esanli istekler sinirin ustune cikamaz.
 *
 * Anahtar: `quota:<havuz>:<pencere>:<donem>:<ozne>`; ozne `user:<id>` ya da
 * `ip:<sha256>` (kisisel veri yok). Her anahtar donem bitince + pay kadar
 * yasar; gece sifirlama isi yoktur.
 *
 * Redis erisilemezse `RedisUnavailableError` firlatir; fail-open/closed
 * karari cagirandadir (anlik yorum: model yok; sohbet: mevcut DB saatlik
 * sayimina duser).
 */
import type Redis from "ioredis";
import { getRedis, RedisUnavailableError } from "../redis/client.ts";
import { QUOTA_POLICY, QUOTA_WINDOWS, type QuotaPool, type QuotaWindow } from "./policy.ts";
import { quotaPeriod } from "./windows.ts";

/** Donem bittikten sonra anahtarin yasadigi pay (saat kaymasi, gec okuma). */
const KEY_TTL_GRACE_SECONDS = 60 * 60;

/**
 * KEYS: pencere anahtarlari. ARGV[1..n]: limitler, ARGV[n+1..2n]: TTL (sn),
 * ARGV[2n+1]: miktar. Donus: 0 = harcandi, i = i'inci pencere dolu (hicbiri
 * artmadi). TTL'siz kalmis anahtar (eski kod) burada onarilir.
 */
const CONSUME_SCRIPT = `
local n = #KEYS
local amount = tonumber(ARGV[2 * n + 1])
for i = 1, n do
  local used = tonumber(redis.call('GET', KEYS[i]) or '0')
  if used + amount > tonumber(ARGV[i]) then return i end
end
for i = 1, n do
  redis.call('INCRBY', KEYS[i], amount)
  if redis.call('TTL', KEYS[i]) < 0 then redis.call('EXPIRE', KEYS[i], ARGV[n + i]) end
end
return 0
`;

/** Harcamayi geri alir (yazma basarisiz oldu); sifirin altina inmez. */
const RELEASE_SCRIPT = `
local amount = tonumber(ARGV[1])
for i = 1, #KEYS do
  local used = tonumber(redis.call('GET', KEYS[i]) or '0')
  if used > 0 then redis.call('DECRBY', KEYS[i], math.min(used, amount)) end
end
return 0
`;

export type QuotaEvalClient = Pick<Redis, "eval">;

export type QuotaConsumeResult = { allowed: true } | { allowed: false; window: QuotaWindow };

export interface QuotaSubjectInput {
  pool: QuotaPool;
  /** `user:<id>` ya da `ip:<ozet>`; cagiran kurar, ham IP girmez. */
  subject: string;
  now?: Date;
}

export function quotaKey(pool: QuotaPool, window: QuotaWindow, now: Date, subject: string): string {
  return `quota:${pool}:${window}:${quotaPeriod(window, now).id}:${subject}`;
}

function keysAndTtls(input: QuotaSubjectInput): { keys: string[]; ttls: number[] } {
  const now = input.now ?? new Date();
  const keys: string[] = [];
  const ttls: number[] = [];
  for (const window of QUOTA_WINDOWS) {
    keys.push(quotaKey(input.pool, window, now, input.subject));
    const remaining = Math.ceil((quotaPeriod(window, now).end.getTime() - now.getTime()) / 1000);
    ttls.push(Math.max(1, remaining) + KEY_TTL_GRACE_SECONDS);
  }
  return { keys, ttls };
}

function resolveClient(client: QuotaEvalClient | undefined, what: string): QuotaEvalClient {
  try {
    return client ?? getRedis();
  } catch (error) {
    throw new RedisUnavailableError(`${what} (yapilandirma)`, { cause: error });
  }
}

/**
 * Havuzun dort penceresinden `amount` harcar ya da hicbirine dokunmaz.
 * `limits` yalnizca testler ve hak havuzunun ortam ayari icindir; varsayilan
 * `QUOTA_POLICY[pool]`.
 */
export async function consumeQuota(
  input: QuotaSubjectInput & { amount?: number; limits?: Readonly<Record<QuotaWindow, number>> },
  client?: QuotaEvalClient,
): Promise<QuotaConsumeResult> {
  const limits = input.limits ?? QUOTA_POLICY[input.pool];
  const amount = input.amount ?? 1;
  const redis = resolveClient(client, "kota");
  const { keys, ttls } = keysAndTtls(input);
  let result: unknown;
  try {
    result = await redis.eval(
      CONSUME_SCRIPT,
      keys.length,
      ...keys,
      ...QUOTA_WINDOWS.map((window) => String(limits[window])),
      ...ttls.map(String),
      String(amount),
    );
  } catch (error) {
    throw new RedisUnavailableError("kota", { cause: error });
  }
  const blocked = Number(result);
  if (!Number.isInteger(blocked) || blocked < 0 || blocked > QUOTA_WINDOWS.length) {
    throw new RedisUnavailableError("kota (beklenmeyen yanit)");
  }
  if (blocked === 0) return { allowed: true };
  return { allowed: false, window: QUOTA_WINDOWS[blocked - 1] as QuotaWindow };
}

/** `consumeQuota`'nin harcadigini geri verir (sonrasindaki yazma basarisiz olduysa). */
export async function releaseQuota(
  input: QuotaSubjectInput & { amount?: number },
  client?: QuotaEvalClient,
): Promise<void> {
  const redis = resolveClient(client, "kota iadesi");
  const { keys } = keysAndTtls(input);
  try {
    await redis.eval(RELEASE_SCRIPT, keys.length, ...keys, String(input.amount ?? 1));
  } catch (error) {
    throw new RedisUnavailableError("kota iadesi", { cause: error });
  }
}

/** Testlerde ve cagiranlarda enjekte edilebilen harcayici. */
export type QuotaConsumer = (
  input: QuotaSubjectInput & { limits?: Readonly<Record<QuotaWindow, number>> },
) => Promise<QuotaConsumeResult>;
export type QuotaReleaser = (input: QuotaSubjectInput) => Promise<void>;
