/**
 * Sabit pencereli sayaç - arama duvarı, giriş oran sınırı ve görsel arama
 * günlük limiti ortak kullanır.
 *
 * Eski desen `INCR` sonra ayrı bir `EXPIRE` idi: iki komut arasında süreç
 * çökerse (ya da `EXPIRE` zaman aşımına uğrarsa) anahtar TTL'siz kalır ve
 * sayaç hiç sıfırlanmaz - duvar kalıcı bir engele dönüşür. Burada
 * `SET key 0 EX w NX` + `INCR` tek bir MULTI içinde çalışır: anahtar ya TTL
 * ile doğar ya hiç doğmaz; `INCR` mevcut TTL'yi korur.
 */
import type Redis from "ioredis";
import { getRedis, RedisUnavailableError } from "./client.ts";

type CounterClient = Pick<Redis, "multi" | "expire">;

export async function incrementFixedWindow(
  key: string,
  windowSeconds: number,
  client?: CounterClient,
): Promise<number> {
  // Istemci try icinde cozulur: REDIS_URL eksik/gecersizse (RedisConfigError)
  // de cagiran taraf ayni "Redis kullanilamiyor" yolundan gecer - /ara duvari
  // acik kalir, giris ve gorsel arama kapali kalir. Asil hata `cause`'ta.
  let redis: CounterClient;
  try {
    redis = client ?? getRedis();
  } catch (error) {
    throw new RedisUnavailableError("sayac (yapilandirma)", { cause: error });
  }

  let results: [Error | null, unknown][] | null;
  try {
    results = await redis
      .multi()
      .set(key, "0", "EX", windowSeconds, "NX")
      .incr(key)
      .ttl(key)
      .exec();
  } catch (error) {
    throw new RedisUnavailableError("sayac", { cause: error });
  }
  if (!results) {
    throw new RedisUnavailableError("sayac (MULTI iptal edildi)");
  }
  const [, incrResult, ttlResult] = results;
  if (!incrResult || incrResult[0] || !ttlResult || ttlResult[0]) {
    throw new RedisUnavailableError("sayac", { cause: incrResult?.[0] ?? ttlResult?.[0] });
  }

  // Eski (atomik olmayan) koddan TTL'siz kalmış bir anahtar: bir kez onar.
  if (ttlResult[1] === -1) {
    try {
      await redis.expire(key, windowSeconds);
    } catch (error) {
      throw new RedisUnavailableError("sayac TTL onarimi", { cause: error });
    }
  }

  return Number(incrResult[1]);
}
