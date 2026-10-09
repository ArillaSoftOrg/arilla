/**
 * Saglayici guvenlik tavani (TUM kullanicilar, Europe/Istanbul gunu): anlik
 * sorgu yorumu ve sohbet icin ayri, atomik Redis sayaclari. Kullanici urun
 * kotasindan (`redis-windows.ts`, `QUOTA_POLICY`) ayridir.
 *
 * Eskiden her istek `api_usage` uzerinde `count(*)` okuyup sonra saglayiciyi
 * cagiriyordu: esanli istekler tavani asabiliyor ve her kontrol bir DB okumasi
 * oluyordu. Simdi:
 *
 *   reserveProviderBudget(N)  -> saglayici (en fazla N HTTP denemesi)
 *   settleProviderBudget(gercek deneme sayisi)
 *
 * - Ayirma, saglayici cagrisindan ONCE ve tek Lua betiginde yapilir: sayac
 *   tavani hicbir esanlilikta asamaz; tavan doluysa hicbir sey yazilmaz.
 * - Kesinlestirme sayaci GERCEK deneme sayisina ceker: hic denenmediyse (on
 *   kontrol, kisi limiti, yerel hata) ayrilan tamamen iade edilir; saglayici
 *   cagrildiysa hata donse bile deneme sayilir (maliyet olustu).
 * - `api_usage` telemetri/denetim kaydi olarak aynen yazilmaya devam eder.
 *
 * Anahtar: `provider-budget:<islem>:<YYYY-MM-DD>` (Istanbul gunu); kullanici,
 * sorgu ya da IP icermez. Gun bitince + pay kadar yasar; sifirlama isi yoktur.
 *
 * Redis erisilemezse `RedisUnavailableError` firlatir; fail-safe karari
 * cagirandadir (anlik yorum: model yok; sohbet: eski DB sayimi tavani).
 */
import type Redis from "ioredis";
import { getRedis, RedisUnavailableError } from "../redis/client.ts";
import { quotaPeriod } from "./windows.ts";

/** Bu islem adlari `api_usage.operation` ile aynidir. */
export type ProviderBudgetOperation = "query_interpretation_realtime" | "chat_turn";

/** Gun bittikten sonra anahtarin okunabildigi pay (gec kesinlestirme, inceleme). */
const KEY_TTL_GRACE_SECONDS = 6 * 60 * 60;

/** KEYS[1]; ARGV: miktar, tavan, ttl. Donus: yeni deger ya da -1 (tavan; hicbir sey yazilmadi). */
const RESERVE_SCRIPT = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if used + amount > tonumber(ARGV[2]) then return -1 end
local value = redis.call('INCRBY', KEYS[1], amount)
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return value
`;

/**
 * KEYS[1]; ARGV: fark (negatif = iade), ttl. Tavan kontrolu YOK: gercek
 * denemeler sayilmak zorunda. Sifirin altina inmez.
 */
const SETTLE_SCRIPT = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local delta = tonumber(ARGV[1])
if delta < 0 and used + delta < 0 then delta = -used end
if delta == 0 then return used end
local value = redis.call('INCRBY', KEYS[1], delta)
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return value
`;

export type ProviderBudgetClient = Pick<Redis, "eval">;

export interface ProviderBudgetReservation {
  readonly operation: ProviderBudgetOperation;
  /** Ayirmanin yapildigi Istanbul gunu; kesinlestirme gun donse de AYNI anahtara yazar. */
  readonly key: string;
  readonly ttlSeconds: number;
  readonly reserved: number;
}

export type ProviderBudgetResult =
  | { allowed: true; reservation: ProviderBudgetReservation }
  | { allowed: false };

export function providerBudgetKey(operation: ProviderBudgetOperation, now: Date): string {
  return `provider-budget:${operation}:${quotaPeriod("day", now).id}`;
}

function ttlSeconds(now: Date): number {
  const remaining = Math.ceil((quotaPeriod("day", now).end.getTime() - now.getTime()) / 1000);
  return Math.max(1, remaining) + KEY_TTL_GRACE_SECONDS;
}

function resolveClient(client: ProviderBudgetClient | undefined): ProviderBudgetClient {
  try {
    return client ?? getRedis();
  } catch (error) {
    throw new RedisUnavailableError("saglayici butcesi (yapilandirma)", { cause: error });
  }
}

/**
 * Saglayici cagrisindan ONCE `amount` deneme ayirir. Tavan doluysa
 * `{ allowed: false }` ve hicbir sey yazilmaz.
 */
export async function reserveProviderBudget(
  input: { operation: ProviderBudgetOperation; amount: number; cap: number; now?: Date },
  client?: ProviderBudgetClient,
): Promise<ProviderBudgetResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error("ayrilacak deneme sayisi pozitif tamsayi olmali");
  }
  const now = input.now ?? new Date();
  const key = providerBudgetKey(input.operation, now);
  const ttl = ttlSeconds(now);
  const cap = Math.max(0, Math.floor(input.cap));
  const redis = resolveClient(client);
  let result: unknown;
  try {
    result = await redis.eval(
      RESERVE_SCRIPT,
      1,
      key,
      String(input.amount),
      String(cap),
      String(ttl),
    );
  } catch (error) {
    throw new RedisUnavailableError("saglayici butcesi", { cause: error });
  }
  const value = Number(result);
  if (!Number.isInteger(value)) throw new RedisUnavailableError("saglayici butcesi (yanit)");
  if (value < 0) return { allowed: false };
  return {
    allowed: true,
    reservation: { operation: input.operation, key, ttlSeconds: ttl, reserved: input.amount },
  };
}

/**
 * Ayirmayi gercek deneme sayisina ceker: `attempts < reserved` ise fark iade,
 * `attempts > reserved` ise fazlasi da sayilir (tavan kontrolsuz; maliyet
 * olustu). Hic denenmediyse `attempts = 0` ile tamami iade edilir.
 */
export async function settleProviderBudget(
  reservation: ProviderBudgetReservation,
  attempts: number,
  client?: ProviderBudgetClient,
): Promise<void> {
  const delta = Math.max(0, Math.floor(attempts)) - reservation.reserved;
  if (delta === 0) return;
  const redis = resolveClient(client);
  try {
    await redis.eval(
      SETTLE_SCRIPT,
      1,
      reservation.key,
      String(delta),
      String(reservation.ttlSeconds),
    );
  } catch (error) {
    throw new RedisUnavailableError("saglayici butcesi kesinlestirme", { cause: error });
  }
}

/** Testlerde ve cagiranlarda enjekte edilebilen butce islevleri. */
export interface ProviderBudgetHooks {
  reserve?: typeof reserveProviderBudget;
  settle?: typeof settleProviderBudget;
}
