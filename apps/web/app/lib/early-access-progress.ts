import {
  type EarlyAccessProgress,
  getCachedEarlyAccessProgress,
  getEarlyAccessProgress,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";

/**
 * Herkese açık sayfalar için ilerleme sayısı (karar 0065). İş mantığı
 * `packages/core/src/access`te; burası yalnızca çağırır.
 *
 * - `loadEarlyAccessProgress`: her çağrıda veritabanından okur. Girişli
 *   kullanıcının gördüğü `/erken-erisim` için: kayıt olan kendi +1'ini anında görür.
 * - `loadCachedEarlyAccessProgress`: anonim ana sayfa için, Redis'te kısa
 *   önbellekli; anonim istek her seferinde veritabanına gitmez (karar 0043).
 *
 * Okunamazsa sayfa düşmez, çubuk gösterilmez (uydurma yedek sayı YOK).
 */
export async function loadEarlyAccessProgress(): Promise<EarlyAccessProgress | null> {
  try {
    return await getEarlyAccessProgress(getDatabase());
  } catch {
    return null;
  }
}

export function loadCachedEarlyAccessProgress(): Promise<EarlyAccessProgress | null> {
  return getCachedEarlyAccessProgress(getDatabase);
}
