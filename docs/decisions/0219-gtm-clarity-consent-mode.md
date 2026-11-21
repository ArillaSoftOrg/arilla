# 0219 — GTM, Clarity ve Consent Mode v2

**Tarih:** 21 Kasım 2026 · **Durum:** kabul edildi (kod bu kararla birlikte; üretimde etkinleştirme env ile)

## Karar

CLAUDE.md'deki iki üçüncü taraf betik istisnasına (GA4 0087, Umami 0116) üçüncüsü ve
dördüncüsü eklenir:

1. **Google Tag Manager** (`GTM_CONTAINER_ID`). GA4 etiketi GTM içindedir; sitede ayrıca
   doğrudan `gtag.js` yüklenmez (`Ga4Client` kalkar, çift sayım olmaz).
2. **Microsoft Clarity** (`CLARITY_PROJECT_ID`). Yalnızca analitik rızasından SONRA yüklenir.

Kurallar:

- Consent Mode v2 varsayılanı `<head>`'de GTM'den önce: `ad_storage`, `analytics_storage`,
  `ad_user_data`, `ad_personalization` = `denied`, `wait_for_update: 500`. Reklam sinyalleri
  kalıcı `denied`; yalnızca `analytics_storage` rızayla `granted` olur. Önceki tercih
  (sunucunun okuduğu rıza çerezi, karar 0038) GTM yüklenmeden `consent update` ile uygulanır;
  ikinci bir depolama (localStorage) açılmaz.
- **GTM yükleme (karar: 21 Kasım 2026, kullanıcı):** `GTM_LOAD_BEFORE_CONSENT` varsayılanı
  **true**: GTM kapsayıcısı rızadan önce, Consent Mode denied varsayılanıyla yüklenir (çerezsiz
  ping modeli). Bu, "rızadan önce hiçbir üçüncü taraf istek yok" ilkesinden bilinçli bir
  sapmadır; hukuki değerlendirme kullanıcıdadır ve `/cerez` sayfasında açıkça yazılıdır.
  `GTM_LOAD_BEFORE_CONSENT=false` (`false`/`0`/`off`/`no`) ise GTM ve GA4 yalnızca analitik
  rızasından sonra (`ConsentGate` içinde) yüklenir; `<noscript>` iframe de basılmaz. Consent
  varsayılanı iki durumda da `<head>`'de basılır. Rıza geri alınırsa `consent update denied`
  gider; yüklenmiş kapsayıcı sayfa ömrü boyunca kalır.
- Clarity betiği rıza yokken hiç yüklenmez; rıza geri alınınca `clarity('consent', false)`.
  Arama kutusu, sohbet mesajı alanı ve giriş/kayıt alanları `data-clarity-mask="True"`.
- dataLayer olayları yalnızca `docs/events.md` "GTM / dataLayer" tablosundaki adlar ve
  parametrelerdir; tek yardımcı `trackEvent` (`@arilla/core/gtm`), her push'ta 9 anahtar.
- Kişisel veri (sohbet içeriği, e-posta, telefon, ad, kullanıcı kimliği, IP) hiçbir olaya
  girmez; GA4'e `user_id` gitmez. Yönetim alanı (`/yonetim`) GTM/Clarity almaz.
- CSP yalnızca ilgili kimlik tanımlıyken Google/Clarity kökenleri ile genişler.

## Gerekçe

Panel tarafı (GTM kapsayıcısı, GA4, Clarity) hazır; olay adları GTM tetikleyicisinde regex
ile eşleşiyor. Mevcut rıza altyapısı (ConsentProvider/ConsentGate) genişletilir.

## Bilinen risk

GTM'in otomatik `page_view`'u tam adresi gönderirdi. Çözüm panel tarafında yapıldı (GTM sürüm 3:
sorgu parametresini atan değişken Google etiketinde `page_location`); kodda ayrıca arındırılmış
adres push'lanmaz.

## Reddedilen

- Doğrudan gtag + GTM birlikte (çift sayım).
- Rıza varsayılanını localStorage'dan okumak (rıza zaten sunucu çerezinde; ikinci kaynak çelişir).
