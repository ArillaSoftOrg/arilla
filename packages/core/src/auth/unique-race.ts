/**
 * Ilk giris yarisi: ayni kimlik (e-posta, Google/Apple `sub`, telefon) icin
 * esanli iki ilk giris ikisi de "yok" gorur ve ikisi de satir eklemeye
 * calisir. UNIQUE kisit (`app_user.email`, `user_identity (provider,
 * provider_subject)`) ikincisini 23505 ile reddeder; islemi geri alinir.
 *
 * Kaybeden taraf islemi bastan bir kez daha calistirir: bu kez kazananin
 * satiri gorunur ve mevcut kullaniciya baglanir. Kisit korunur, cift
 * kullanici olusmaz, istek 500 ile dusmez.
 *
 * Ayni yaris ayni `app_user` satirini guncelleyen islemler arasinda
 * kilitlenmeye (40P01) de donusebilir: Postgres birini geri alir. O islem de
 * bastan, yeni transaction'la yeniden denenir (bes esanli ilk giriste
 * gozlendi, karar 0050).
 */

const UNIQUE_VIOLATION = "23505";
const DEADLOCK_DETECTED = "40P01";

function hasPgCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth++) {
    if (typeof current === "object" && (current as { code?: unknown }).code === code) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** pg hatasi dogrudan ya da Drizzle sarmalayicisinin `cause`'unda gelir. */
export function isUniqueViolation(error: unknown): boolean {
  return hasPgCode(error, UNIQUE_VIOLATION);
}

/** Geri alinmis ve bastan denenebilir yaris: UNIQUE ihlali ya da kilitlenme. */
export function isRetryableRace(error: unknown): boolean {
  return isUniqueViolation(error) || hasPgCode(error, DEADLOCK_DETECTED);
}

/**
 * `run` bir islemin tamamidir (her denemede yeni transaction). Yalnizca
 * UNIQUE ihlali ve kilitlenme yeniden denenir (en fazla `retries` kez);
 * diger hatalar oldugu gibi iletilir.
 */
export async function retryOnUniqueViolation<T>(run: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= retries || !isRetryableRace(error)) throw error;
    }
  }
}
