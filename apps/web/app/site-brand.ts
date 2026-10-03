/**
 * Yayindaki marka adi (karar 0008: isim koda dagitilmaz). Header, footer,
 * kok metadata, giris ekrani ve lansman oncesi landing buradan okur.
 * Yasal kimlik (`LEGAL_IDENTITY.brandName`) ayri bir karardir; yasal
 * metinler kendi kaynaklarindan okumaya devam eder.
 *
 * Bilerek bagimliliksiz: istemci bilesenleri (orn. `/geri-bildirim` formu)
 * bu dosyayi import eder; `site-config.ts` `@arilla/core` kokunu (sunucu
 * modulleri dahil) cektigi icin istemci paketine giremez.
 */
export const SITE_BRAND = "ManiCepte";
