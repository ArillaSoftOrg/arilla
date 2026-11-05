import { EARLY_ACCESS_PATH } from "@arilla/core/product-access";
import { CREDENTIAL_COPY as COPY } from "../credential-copy.ts";

/**
 * Kayıt ekranı başlığı: erken erişim akışından gelen (`next=/erken-erisim`)
 * kullanıcı neye kaydolduğunu görür; diğer her durumda "Hesap oluştur".
 * Yalnızca metin seçimi: `next` zaten `safeRedirectPath`'ten geçmiştir ve
 * yönlendirme, doğrulama ve listeye katılım davranışı değişmez.
 */
export function registerTitle(safeNext: string): string {
  return safeNext === EARLY_ACCESS_PATH ? COPY.registerEarlyAccessTitle : COPY.registerTitle;
}
