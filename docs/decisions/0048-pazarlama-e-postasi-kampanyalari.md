# 0048 — Pazarlama e-postası kampanyaları

**Tarih:** 2 Ekim 2026
**Durum:** Kabul edildi (İYS entegrasyonu ve hukuk onayı bekliyor; üretimde gönderim kapalı)

## Karar

1. **Rıza tek kaynak.** Uygunluk `user_consent`'teki `marketing_email`
   türünün en son satırından okunur (`granted_at DESC, id DESC`, `/hesap` ile
   aynı tanım). İkinci bir abonelik/opt-out bayrağı yok; abonelik iptali de
   `setConsent` ile ret satırı yazar.
2. **Tek uygunluk kuralı** (`packages/core/src/marketing/eligibility.ts`, tek
   SQL sınıflandırması): e-posta var, biçimi geçerli, `email_verified_at`
   dolu, güncel `marketing_email` izni açık, aynı adresi (harf duyarsız)
   taşıyan daha küçük `id`'li uygun bir hesap yok. Önizleme sayımı,
   başlangıçtaki teslim satırları ve **gönderim anındaki yeniden denetim**
   aynı sorgudan geçer. Önizleme ya da başlangıç hiçbir adresi kalıcı olarak
   yetkilendirmez.
3. **Veri modeli (0035).** `marketing_campaign` (taslak → gönderiliyor →
   tamamlandı / kısmen başarısız / başarısız; taslak ya da gönderim sırasında
   iptal) ve `marketing_campaign_delivery` (alıcı başına tek satır, UNIQUE
   `(campaign_id, user_id)`). Alıcı adresi saklanmaz: gönderim anında
   `app_user.email`'den okunur; hesap silinince `user_id` NULL olur.
   `arilla_app` iki tabloda DELETE yapamaz.
4. **Çift gönderim motorda engellenir.** Başlatma `FOR UPDATE` + `draft`
   kontrolüyle tek işlem; ikinci istek `already_started` alır. Yönetici
   onayladığı içerik sürümünü gönderir; sürüm değiştiyse ya da o sürüm test
   edilmediyse başlatma reddedilir. Teslim `FOR UPDATE SKIP LOCKED` ile
   alınır, `sending` olarak işaretlenip işlem kapanır, sonra gönderilir.
   **En fazla bir kez:** sonucu belirsiz hata (veri aktarımında zaman aşımı,
   kopan bağlantı, süreç ölümü) yeniden denenmez, `unknown_outcome` olur.
   Yalnızca sağlayıcının kesin almadığı hatalar (4xx yanıt, bağlantı
   kurulamadı) geri çekilmeyle (5, 10, 20 … dk) en fazla
   `MARKETING_EMAIL_MAX_ATTEMPTS` kez denenir. Yapılandırma hatası teslimi
   tüketmez, işi durdurur ve kampanyada görünür.
5. **Tek web isteğinde toplu gönderim yok.** Her çağrı sınırlı bir parti
   işler (ileti sayısı + süre bütçesi + iletiler arası bekleme) ve döner.
   Kalıcı durum veritabanındadır; ilerletenler: başlatma anındaki ilk parti,
   `/api/cron/marketing-campaigns` (`CRON_SECRET`, mevcut 15 dakikalık
   GitHub Actions iş akışına eklenen adım) ve yönetim ekranındaki "sonraki
   partiyi şimdi işle". Yeni altyapı (kuyruk, worker) eklenmedi.
6. **Sağlayıcı değişmez.** Mevcut SMTP taşıyıcısı (nodemailer; yerelde
   Mailpit, üretimde sağlayıcının SMTP ucu). Ticari ileti yalnızca
   `marketing/` modülünden, ayrı gönderen adresiyle (`MARKETING_EMAIL_FROM`)
   gider; işlemsel yol (`send-login-email`, `send-alert-email`) değişmedi.
   Her ileti `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058) ve
   bizim ürettiğimiz `Message-ID` taşır (ileride bounce/şikâyet eşlemesi).
7. **Ortam kapısı.** Gerçek gönderim yalnızca SMTP yerel röle (Mailpit)
   iken ya da `VERCEL_ENV=production` VE `MARKETING_EMAIL_ENABLED=true`
   iken açık. Preview ve gerçek SMTP'li bir geliştirici makinesi gerçek
   kullanıcılara kampanya gönderemez. Test gönderimi her ortamda tek adrese.
8. **Abonelik iptali girişsiz.** Her gönderim denemesi 256 bit rastgele
   token üretir; yalnızca SHA-256 özeti saklanır. Token hesap kimliği ya da
   imza anahtarı içermez; tek yetkisi o teslimin sahibinin iznini geri
   almaktır. `/abonelik-iptali?t=…` GET'te hiçbir şey değiştirmez (bağlantı
   tarayıcıları), düğme POST eder; `/api/email/unsubscribe` tek tık POST.
   Kullanıcı başına danışma kilidi altında güncel durum okunur: tekrar
   yeni satır yazmaz. İşlemci de aynı kilidi alır.
9. **İçerik kontrollü.** Gövde düz metindir (boş satır paragraf, `https://`
   bağlantı); HTML yazılamaz, her parça kaçırılır. Altbilgi sabit: neden
   alındı, iptal bağlantısı, hesap izinleri, gönderen kimliği
   (`LEGAL_IDENTITY`). Renk yok.
10. **Yönetim.** `marketing.manage` yalnızca yöneticide; gerçek gönderim
    ayrıca taze giriş ister (0044 listesine eklendi). Test gönderimi
    zorunlu adımdır, kampanya alıcısı sayılmaz, yönetici başına saatte 10
    ile sınırlıdır (denetim kaydından sayılır, Redis yok). Ekranlar yalnızca
    sayı ve maskeli adres gösterir.
11. **Denetim kaydı:** `marketing.campaign_create`, `.campaign_update`,
    `.test_send`, `.send_start`, `.campaign_cancel`. Konu, gövde, test adresi,
    alıcı listesi ve sağlayıcı yanıtı yazılmaz; yalnızca sürüm, uzunluk,
    sayı, durum.

## Gerekçe

Ticari ileti her gönderimde yasal risk üretir. Kural kod incelemesine değil,
tek uygunluk sorgusuna, gönderim anı denetimine ve veritabanı kısıtlarına
verildi. Vercel'de uzun süren iş çalışmadığı ve worker barındırması yalnızca
Python tarafında olduğu için (CLAUDE.md mimari sınır) süreklilik kalıcı durum
ve sınırlı partilerle sağlandı.

## Reddedilen alternatifler

- **`feature/marketing-email-consent` dalını almak:** eski taban (0033 ve
  0046 numaraları başka iş için ayrılmış), `user_consent`'e kolon ekleyip
  rıza anlamını değiştiriyordu (eski satırlar "gösterilemez rıza" sayılıp
  bugünkü `/hesap` izinleri yok sayılırdı) ve kampanya/yönetim akışı yoktu.
  Token'ın yalnızca özetini saklama, RFC 8058 ve GET'te değişiklik yapmama
  fikirleri buraya uyarlandı.
- **Gönderimi tek istekte döngüyle yapmak:** zaman aşımında yarım kalır,
  yeniden deneme çift ileti üretir.
- **Redis kuyruğu / ayrı worker:** veritabanı zaten kalıcı durumu tutuyor;
  ikinci bir doğruluk kaynağı ve yeni barındırma gerekmez.
- **İmzalı (HMAC) iptal token'ı:** sır döndürülünce gelen kutusundaki
  bağlantılar bozulur; teslim kaydı zaten var.
- **Alıcı adresini teslim satırında saklamak:** gereksiz kişisel veri
  kopyası; rıza zaten gönderim anında güncel adres üzerinden denetleniyor.
- **Serbest HTML ya da Markdown editörü:** temizleme hattı ve yeni bağımlılık
  gerektirir; ilk sürüm için düz metin yeterli.
- **Ayrı 5 dakikalık iş akışı:** Actions dakikasını üçe katlardı.

## Açık

- İYS hesabı ve senkronu; rıza metninin sürümlenmesi ve hukuk onayı.
  Bunlar olmadan üretimde `MARKETING_EMAIL_ENABLED` açılmaz.
- Sağlayıcı olayları (teslim, bounce, şikâyet) için webhook ve adres
  bastırma; bugün "sağlayıcıya verildi" ile "teslim edildi" ayrı tutulur.
- Başlangıçtan sonra uygun hâle gelen hesaplar o kampanyaya eklenmez.
- İptalden önce sağlayıcıya verilmekte olan tek ileti geri çağrılamaz.
