# 0046 — Pazarlama e-postası, rıza geçmişi ve abonelik iptali

**Tarih:** 29 Eylül 2026
**Durum:** Kabul edildi (İYS entegrasyonu ve hukuk onayı bekliyor)

## Karar

1. **İki e-posta türü kesin ayrı.**
   - *İşlemsel* (giriş bağlantısı, fiyat alarmı, hesap/güvenlik bildirimi):
     `sendTransactionalEmail` (`packages/core/src/email/send.ts`), `EMAIL_FROM`.
     Pazarlama rızasına bakmaz; tanıtım metni ve iptal bağlantısı içermez.
   - *Ticari* (duyuru, kampanya, özellik tanıtımı, öneri/yeniden etkinleştirme):
     yalnızca `sendMarketingEmail` (`packages/core/src/marketing`),
     `MARKETING_EMAIL_FROM`. Özellik kodu taşıyıcıyı doğrudan çağırmaz.
2. **Sağlayıcı değişmez.** Mevcut SMTP taşıyıcısı (nodemailer) kullanılır;
   üretimde Resend'in SMTP ucu. Yeni SDK ve `RESEND_API_KEY` eklenmedi: aynı
   bağlantı havuzu, aynı hata sarmalayıcı (`EmailDeliveryError`, adres/token
   loglanmaz).
3. **Rıza = append-only olay geçmişi.** `user_consent` (0009) korunur, 0033 ile
   `source`, `text_version`, `email`, `recorded_at` eklenir ve tablo
   veritabanında append-only olur (`arilla_app`: SELECT + INSERT). Güncel durum
   `granted_at` sırasıyla son satırdır. Geçerli (gösterilebilir) pazarlama
   rızası = kaynak, metin sürümü ve adres dolu `granted` satırı.
   - Rıza metni sürümlü tek kaynaktan gelir
     (`marketing/consent-text.ts`); metin değişirse sürüm değişir.
   - Kaynaklar açık: `signup`, `early_access`, `account_settings`,
     `feedback`, `admin_import` (onay); `account_settings`,
     `unsubscribe_link`, `iys` (ret).
   - **0033 öncesi satırlar geçerli rıza sayılmaz.** Mevcut kullanıcılar,
     erken erişim listesi ve geri bildirim gönderenler sessizce aboneye
     dönüşmez; veri taşınmadı.
   - Genel `setConsent` `marketing_email` yazamaz (tip + çalışma zamanı).
4. **Abonelik iptali girişsiz, anında, idempotent.** Her gönderim kendi
   256 bitlik token'ını üretir; yalnızca SHA-256 özeti saklanır
   (`marketing_email_send`). `SESSION_SECRET` pepper'ı bilerek kullanılmaz:
   sır döndürülünce gelen kutusundaki iptal bağlantıları çalışmaya devam
   etmeli. İptal tek işlemde bir ret olayı (`unsubscribe_link`) ve adres
   bastırması (`email_suppression`, adresin SHA-256 özeti, append-only) yazar.
   - `/abonelik-iptali?t=…`: GET hiçbir şey değiştirmez (bağlantı
     tarayıcıları), iptal düğmeyle (POST) yapılır.
   - `/api/email/unsubscribe?t=…`: RFC 8058 tek tık (`List-Unsubscribe` +
     `List-Unsubscribe-Post` başlıkları). Posta sağlayıcısından geldiği için
     aynı-köken denetimi yok; yetki token'dır ve yalnızca iptal eder.
   - Bastırma yalnızca kendisinden SONRA verilmiş geçerli bir rızayla aşılır;
     geriye tarihli bir `admin_import` iptal edilmiş adresi geri ekleyemez.
5. **Tek uygunluk kapısı.** `decideMarketingEligibility` (saf) +
   `loadMarketingFacts`: kullanıcı var, adres var/geçerli/doğrulanmış, son
   olay geçerli onay, rıza güncel adrese ait, bastırma yok, kip izinli, canlı
   kipte İYS `synced`. İstemciden gelen hiçbir bayrak karara girmez.
   Gönderim talebi kullanıcı + adres danışma kilidi altında alınır; iptal ve
   rıza yazımı aynı kilitleri aynı sırayla alır. İptal işlendikten sonra
   hiçbir talep eski rızayı göremez. `(campaign_key, email_hash)` tekil:
   yeniden deneme ikinci e-posta üretmez; yalnızca `failed` kayıt yeniden
   denenir. SMTP beklerken kilit tutulmaz.
6. **Ortam kapısı (`MARKETING_EMAIL_MODE`).** `off` varsayılan. `allowlist`
   yalnızca listedeki adreslere (rıza kontrolleri yine geçerli). `live`
   yalnızca `NODE_ENV=production` ve `VERCEL_ENV=production` iken ve
   `legal-identity.ts` tamamken kabul edilir; canlıda İYS senkronu şarttır.
   Yerel, test ve preview gerçek kullanıcılara kampanya gönderemez.
7. **İYS sınırı, entegrasyon değil.** Hesap/marka kodu/API erişimi yok; kod
   bir entegrasyon iddia etmez. Adresi olan her rıza olayı
   `consent_external_sync` içinde `pending` açılır; gelecekteki senkron işi
   `listPendingConsentSync` / `recordConsentSyncResult` kullanır. Yerel iptal
   senkronu beklemez. Bugün bu yüzden `live` kipte hiçbir alıcı uygun değildir
   — bilinçli.
8. **Arayüz.** `/hesap` pazarlama anahtarı iyimser değil: sunucunun döndürdüğü
   durumu gösterir, işlem sürerken kilitlidir. Erken erişim ekranında
   (kayıttan sonraki ilk ekran) işaretsiz, isteğe bağlı kutu; kullanım
   koşulları kabulüyle birleşmez, erken erişimi engellemez. Yönetim kullanıcı
   ayrıntısında salt okunur özet (etkin durum, kaynak/tarih/sürüm, iptal,
   İYS durumu, gönderim sayısı).

## Gerekçe

Ticari ileti izni kullanıcı sayısıyla değil, her gönderimle risk üretir:
tek bir atlanmış kontrol, yanlış ortam değişkeni ya da geri eklenen bir iptal
yasal ihlal demektir. Bu yüzden kural kod incelemesine değil tek bir kapıya,
veritabanı yetkisine (append-only) ve tekil kısıtlara verildi.

## Reddedilen alternatifler

- **`app_user.marketing_opt_in` boolean'ı:** denetlenemez (ne zaman, hangi
  metinle, nereden), geri alma geçmişini kaybeder.
- **Resend HTTP SDK'sı:** mevcut SMTP yolu üretime hazır; ikinci bir sağlayıcı
  yolu ve anahtarı eklemek yüzeyi büyütür.
- **İmzalı (HMAC) durumsuz iptal token'ı:** sır döndürülünce eski e-postalardaki
  bağlantılar bozulur; gönderim kaydı zaten gerekli.
- **Kayıt ekranına (giriş formu) onay kutusu:** giriş = kayıt tek akış ve
  OAuth yönlendirmesi arasında kutunun durumunu taşımak ayrı bir çerez/durum
  ister; `feature/auth-social-only-ux` o ekranı yeniden yazıyor. Kayıt sonrası
  ilk ekran (erken erişim) aynı anı yakalar. `signup` kaynağı ileride için
  CHECK'te duruyor.
- **Onay e-postası (double opt-in):** adresler Google/Apple ya da giriş
  bağlantısıyla doğrulanmış olmalı (`email_verified_at` kapıda şart);
  doğrulanmamış adres uygun değildir. Hukuk onayı gerekli görürse eklenir.

## Açık

- İYS hesabı, marka kodu, API erişimi ve kaynak/izin türü eşlemesi.
- Rıza metni ve ticari ileti alt bilgisinin hukukçu onayı; onaydan sonra
  sürüm artırılır.
- Hesap silindiğinde İYS'ye ret senkronu: bugün rıza satırları cascade ile
  siliniyor, adres bastırması (özet) kalıyor. Entegrasyonla birlikte
  tasarlanmalı.
- `user_consent` için `marketing_email` satırlarında `source`/`text_version`
  NOT NULL kısıtı: bu kod dağıtıldıktan sonra ayrı migration (kural 14).
- Erken erişim "açıldığında haber vereceğiz" bildiriminin işlemsel mi ticari
  mi sayıldığı hukuk sorusu; o gönderim yazılırken netleşmeli.
