/**
 * Ilk giris yarisi: ayni kimlik (e-posta, Google/Apple `sub`, telefon) icin
 * esanli iki ilk giris ikisi de "yok" gorur ve ikisi de satir eklemeye
 * calisir. UNIQUE kisit (`app_user.email`, `user_identity (provider,
 * provider_subject)`) ikincisini 23505 ile reddeder; islemi geri alinir.
 *
 * Kaybeden taraf islemi bastan bir kez daha calistirir: bu kez kazananin
 * satiri gorunur ve mevcut kullaniciya baglanir. Kisit korunur, cift
 * kullanici olusmaz, istek 500 ile dusmez.
 */

const UNIQUE_VIOLATION = "23505";

/** pg hatasi dogrudan ya da Drizzle sarmalayicisinin `cause`'unda gelir. */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth++) {
    if (typeof current === "object" && (current as { code?: unknown }).code === UNIQUE_VIOLATION) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * `run` bir islemin tamamidir (her denemede yeni transaction). Yalnizca
 * UNIQUE ihlali yeniden denenir; diger hatalar oldugu gibi iletilir.
 */
export async function retryOnUniqueViolation<T>(run: () => Promise<T>, retries = 1): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= retries || !isUniqueViolation(error)) throw error;
    }
  }
}
