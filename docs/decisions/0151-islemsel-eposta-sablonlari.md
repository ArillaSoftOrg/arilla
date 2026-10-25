# 0151 — Merkezi işlemsel e-posta şablonları

Durum: kabul (karar 0150'nin devamı)

## Karar

Hesap e-postaları tek bir şablon sisteminden üretilir
(`packages/core/src/email/layout.ts`, `transactional-templates.ts`, `theme.ts`):

| Şablon | Konu | Tetikleyici | Bağlantı / süre |
| --- | --- | --- | --- |
| Hesap doğrulama | ManiCepte hesabını doğrula | e-posta + şifre kaydı, "yeniden gönder" | `verify_email`, 60 dk |
| Hoş geldin | ManiCepte'ye hoş geldin | doğrulama tamamlanıp hesap açılınca (yeni tetikleyici) | `/` bağlantısı, süre yok |
| Şifre sıfırlama | ManiCepte şifreni sıfırla | "şifremi unuttum" (şifresi olan hesap) | `reset_password`, 30 dk |
| Şifre değişikliği bildirimi | ManiCepte şifren değiştirildi | sıfırlama/ekleme tamamlanınca, oturum açıkken şifre değişince (yeni tetikleyici) | bağlantı yok |
| Hesaba şifre ekleme | ManiCepte hesabına şifre ekle | "şifremi unuttum" ama hesabın şifresi yok (Google/Apple) | `reset_password`, 30 dk |
| Hesap zaten var | ManiCepte hesabın zaten var | kayıt formu, adres zaten hesaba bağlı | `reset_password`, 30 dk |

- **Yeni migration/token türü yok.** "Şifre ekle" aynı `reset_password` token'ını
  kullanır; yalnızca şablon `hasPasswordCredential`'a göre seçilir. Hesap birleşmesi
  yoktur: bağlantı e-posta sahipliğini kanıtlar, `app_user` aynı kalır (karar 0150).
- **Süreler tek kaynaktan:** `auth/token-ttl.ts` hem `issueToken` hem metinleri besler.
- **Gönderen:** `EMAIL_FROM` (örn. `ManiCepte <team@manicepte.com>`). **Yanıt adresi:**
  `EMAIL_REPLY_TO`; boşsa `EMAIL_FROM` içindeki adres. Adres kodda sabitlenmez.
- **Bilgilendirme e-postaları (hoş geldin, şifre değişti) en iyi çabayla gider**
  (`sendCredentialNoticeBestEffort`): işlem zaten tamamlanmıştır, SMTP hatası kullanıcıya
  yansımaz; yalnızca hata kodu loglanır. Doğrulama/sıfırlama e-postaları eskisi gibi
  hatayı yüzeye çıkarır ve oran sınırı hakkını geri verir. Hoş geldin ve değişiklik
  bildirimi kendi başına yeni bir istek yolu açmaz (zaten sınırlı bir işlemin sonucudur).
- **Hoş geldin ilk hesap oluşturmada gider** (e-posta+şifre, Google, Apple, e-posta giriş
  bağlantısı): `isNewUser=true` dönen girişin commit sonrasında `welcome-email.ts` ile. Gitmeyen
  durumlar: tekrar giriş, mevcut hesapla eşleşme (Google ile aynı e-posta `isNewUser=false`),
  doğrulanmamış e-posta, Apple gizli aktarma adresi (kayıtlı gönderen olmadan düşer, itibarı
  bozar), e-postasız Apple/telefon girişi. Geçmişe dönük toplu gönderim yoktur. Tek seferlik
  garanti için ek tablo/migration gerekmedi: garanti "en fazla bir kez"dir (gönderim sırasında
  süreç ölürse ileti kaybolur, ikinci kez gitmez); hoş geldin kritik değildir.
- **Bekleme sınırı:** bilgilendirme e-postaları yanıtı en fazla 4 sn bekletir; takılan SMTP
  bağlantısı arka planda sürer, hatası yalnızca kodla loglanır.
- **İçerik kuralları:** şifre ya da ham token bildirim e-postalarında asla yer almaz;
  hoş geldin e-postası pazarlama içeriği/izin gerektiren öğe taşımaz, erken erişim
  durumunu belirtir (`docs/copy.md` `early_access.*` ile uyumlu).
- **Logo:** `docs/brand.md`'e göre mevcut logo dosyası geçici yer tutucudur ve üretimde
  kullanılmaz; bu yüzden marka kelime işareti **metin** olarak (italik, 600) yazılır.
  Görsel yüklenmesi gerekmez, resim engelleyen istemcilerde bozulmaz. Yeni logo
  yayımlandığında `layout.ts`'teki `wordmarkHtml` değişir.
- **Renk istisnası:** CLAUDE.md "hiçbir renk koda gömülmez" der; ancak e-posta istemcileri
  `var()` desteklemez. Renkler yalnızca `email/theme.ts`'te durur, değerleri
  `docs/design.md` belirteçlerinin kopyasıdır ve `theme.test.ts` her çalıştırmada
  belgeyle eşleştiklerini doğrular. Şablon dosyaları renk yazmaz.
- **Uyumluluk:** tablo yerleşimi, satır içi stil, `max-width:600px` mobil daraltma,
  `prefers-color-scheme: dark` (Apple Mail, Gmail uygulamaları) + `[data-ogsc]` (Outlook.com)
  koyu mod, harici görsel/font/betik yok, her ileti HTML + düz metin (multipart).

## Gerekçe

Eski tek şablon üç türü kapsıyordu, renksizdi ve koyu modda/Outlook'ta kırılgandı.
Tek bir `renderEmail` her e-postayı aynı çatıda üretir; HTML kaçırma, süre, düz metin
eşleşmesi tek yerde test edilir.

## Reddedilen

- **Resend panelinde şablon oluşturmak:** Resend'i yalnızca SMTP rölesi olarak
  kullanıyoruz; şablonlar kodda sürümlenir, testlenir ve sağlayıcıya bağımlı kalmaz.
  Resend'de ayrıca şablon tanımlamak gerekmez.
- **MJML/react-email bağımlılığı:** altı küçük şablon için yeni derleme bağımlılığı
  gerekçesiz; elle yazılmış tablo yerleşimi test edildi.
- **Logo için uzak görsel:** yer tutucu logo üretimde yasak; SVG Gmail'de çalışmaz;
  resim engelleme metin kelime işaretini etkilemez.
