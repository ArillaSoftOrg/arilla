# 0150 — E-posta + şifre ile kayıt ve giriş

**Tarih:** 25 Ekim 2026
**Durum:** Önerildi (PR). Üretim migration'ı (0101) ve dağıtım ayrı, elle onaylı adımlardır; bu karar kendiliğinden hiçbir şeyi üretime taşımaz.
**İlişkili:** 0006 (e-posta bağlantısı, token), 0031/0043 (erken erişim, ürün kapısı), 0049 (giriş olayları), 0056 (yönetim ana makinesi yalnızca Google), 0087 (çerez rızası)

## Sorun

Giriş yalnızca Google ve Apple ile yapılıyordu (e-posta bağlantısı ve telefon arayüzden kaldırılmıştı). Bu iki sağlayıcıdan birine sahip olmayan ya da kullanmak istemeyen kullanıcı hiçbir yoldan hesap açamıyordu. E-posta + şifre eklenecek, ama mevcut Google/Apple girişlerini, ortak `app_user`/`session` modelini ve erken erişim kurallarını bozmadan.

## Karar

1. **Aynı model, yeni kimlik bilgisi tablosu.** `app_user` ve `session` aynen kullanılır; oturumu yine `createSessionForUser` açar (`provider: "email"`, `auth_event` zaten bu değeri tanıyor). Yeni tablolar (migration 0101, yalnızca ekleme):
   - `password_credential (user_id PK → app_user, password_hash, created_at, updated_at)`
   - `email_credential_token (purpose: verify_email | reset_password, email, token_hash UNIQUE, pending_password_hash, pending_display_name, expires_at, consumed_at, request_ip, created_at)`
   `user_identity` değişmez (sağlayıcı CHECK'i genişletilmedi): şifre bir "kimlik sağlayıcısı" değil, hesabın bir giriş yöntemidir.
2. **Şifre özeti Argon2id.** Node'un yerleşik `crypto.argon2`'si (Node ≥ 24.7; CI ve Vercel Node 24) — yerel bağımlılık yok. PHC dizgisi, parametreler özetin içinde (OWASP: 19 MiB, t=2, p=1), giriş sırasında zayıf parametreli özet yenilenir. Şifre NFKC ile normalize edilir. Politika: 10–128 karakter, sık kullanılan listesi ve e-postanın kendisi reddedilir; karakter sınıfı kuralı yok (NIST 800-63B). Düz metin şifre saklanmaz, loglanmaz, durum nesnelerinde geri dönmez.
3. **Hesap, e-posta doğrulanınca açılır.** Kayıtta `app_user` YAZILMAZ; seçilen şifrenin özeti `verify_email` token satırında bekler. Doğrulama onay formunun POST'unda tüketilir (GET yan etkisiz: e-posta tarayıcıları token'ı harcayamaz), hesap + şifre kaydı + oturum tek işlemde açılır. Doğrulanmamış adres hesap açamaz, başkasının adresini işgal edemez; `password_credential` satırı yalnızca adres kontrolü kanıtlandıktan sonra vardır — "doğrulanmadan normal erişim yok" kuralı yapıyla sağlanır.
4. **Token'lar:** 256 bit rastgele, `HMAC-SHA256(SESSION_SECRET)` özeti saklanır (0006 ile aynı), amaca özel (`purpose`; doğrulama token'ı sıfırlamada geçmez), tek kullanımlık (`WHERE consumed_at IS NULL` koşullu UPDATE), kısa ömürlü: doğrulama 60 dk, sıfırlama 30 dk. Yeni token aynı adres+amacın açık token'larını geçersiz kılar. Süresi dolan satırlar mevcut günlük temizlikte (`cleanupExpiredAuthRecords`) silinir.
5. **Hesap eşleştirme (güvenlik kuralı).**
   - Doğrulanmamış e-postaya dayanarak ASLA birleştirme yapılmaz.
   - Var olan bir hesabın adresiyle kayıt denenirse yeni şifre KABUL EDİLMEZ (aksi halde kayıt eden kişi, adresin sahibi olmadan şifreyi önceden belirleyip sonradan sahibin hesabına girebilirdi). Adrese "hesabın var" e-postası + şifre belirleme bağlantısı gider; şifreyi adresin gerçek sahibi, bağlantıyı açıp kendisi belirler. Aynı yol, yalnızca Google/Apple ile açılmış kullanıcının sonradan şifre eklemesini sağlar (`/hesap/sifre`).
   - Doğrulama beklenirken adres başka bir yolla (örn. Google) hesaba dönüşürse şifre bağlanmaz, token tüketilmez (`EmailAlreadyRegisteredError`).
   - **Apple "E-postamı Gizle":** `@privaterelay.appleid.com` adresiyle şifreli kayıt reddedilir (bu adrese bizim e-postamız ulaşmaz, doğrulama kanıtı olmaz). Gizli adresle Apple'a girmiş kullanıcı Apple ile devam eder; gerçek e-postasıyla şifreli kayıt ayrı hesap olur — sahibi aynı olsa da bunu doğrulayabileceğimiz bir kanıt yok, bu yüzden otomatik birleştirme yapılmaz.
6. **Hesap varlığı sızmaz.** Kayıt, sıfırlama ve yeniden gönderim yanıtı her durumda "e-posta gönderildi" der; giriş yanlış şifre / olmayan hesap / şifresiz hesap / personel için aynı hata ve aynı maliyetle (`burnPasswordVerification`) döner. Sıfırlama ve yeniden gönderimde teslim hatası yalnızca loglanır (hata yalnız var olan hesapta oluşabileceği için gösterilse hesap varlığı sızardı). Kalan fark: var olan hesapta SMTP gönderimi olduğu için yanıt süresi daha uzundur; bu, oran sınırlarıyla (aşağıda) sınırlanan kabul edilmiş bir artık risktir.
7. **Personel (moderator/admin) şifreyle girmez**, şifre belirleyemez; yönetim girişi Google'da kalır (0056). `/giris/*` yönetim ana makinesinde zaten 308 ile public siteye gider.
8. **Oran sınırları (Redis, fail-closed; anahtarlar HMAC takma adı).** Giriş: (e-posta+IP) 15 dk'da 5, e-posta saatte 20, IP 15 dk'da 30 — çift tavanı düşük, e-posta tavanı yüksek: bir saldırgan başka birinin hesabını kilitleyemez. Kayıt/sıfırlama/yeniden gönderim: adres başına dakikada 1, saatte 5, günde 10; IP başına saatte 10 (kapsam başına ayrı sayaç). Şifre değiştirme: kullanıcı başına 15 dk'da 5. Gönderilemeyen e-postanın adres hakkı iade edilir.
9. **Oturum geçersiz kılma.** Şifre sıfırlanınca kullanıcının TÜM oturumları, değiştirilince bu oturum dışındakiler silinir (`session_revoked` olayı yazılır). Sıfırlama oturum AÇMAZ; kullanıcı yeni şifresiyle girer. Sıfırlama ayrıca adresin diğer açık token'larını geçersiz kılar.
10. **CSRF / açık yönlendirme / çerez.** Tüm yazma yolları server action'dır (yalnız POST, Next Origin≈Host denetler). `next` her adımda `safeRedirectPath` ile süzülür. Çerez mevcut `setSessionCookie` (httpOnly, Secure, SameSite=Lax). Token taşıyan sayfalar `Referrer-Policy: no-referrer` (`TOKEN_URL_PATHS`) ve `noindex`.
11. **Kullanılabilirlik bayrağı.** `authProviderAvailability().email`: SMTP (host/port/kimlik) + `EMAIL_FROM` + `crypto.argon2` hazırsa "E-posta ile devam edin" gösterilir; değilse seçenek hiç çizilmez ve eylemler "kullanılamıyor" döner — doğrulama e-postası gidemeyecek bir kayıt akışına kullanıcı sokulmaz. Yeni ortam değişkeni YOKTUR.
12. **Mevcut kurallar korunur.** Erken erişim/ürün kapısı değişmez: oturumu `createSessionForUser` açtığı için erken erişim kaydı ve `postAuthRedirect` aynı çalışır. Yeni analitik olayı gönderilmez (kural 13). Hesap silinince `password_credential` CASCADE ile, bekleyen `email_credential_token` e-postaya göre silinir (`deleteAccount`).

## Rotalar

`/giris/eposta` (giriş), `/giris/kayit`, `/giris/eposta-dogrula?token=` (onay formu), `/giris/sifre-unuttum`, `/giris/sifre-sifirla?token=`, `/hesap/sifre` (değiştir / şifre belirle).

## Reddedilen alternatifler

- **Supabase Auth / harici kimlik sağlayıcı:** mevcut oturum, erken erişim ve denetim modeli yeniden yazılırdı; kapsam dışı.
- **bcrypt / scrypt / `argon2` npm paketi:** Argon2id OWASP'ın birinci tercihi; yerleşik uygulama yerel derleme bağımlılığını (Vercel'de kırılgan) ortadan kaldırır.
- **Kayıtta hemen `app_user` açıp "doğrulanmamış" işaretlemek:** her kod yolunun `email_verified_at`'e bakmasını gerektirirdi; bir yerde unutulursa doğrulanmamış hesap erişim kazanır. Hesabı doğrulamadan sonra açmak bu sınıfı yapısal olarak kapatır.
- **Var olan hesaba kayıtta şifreyi sessizce eklemek ya da e-posta eşleşince otomatik birleştirmek:** ön-ele-geçirme (pre-hijacking) saldırısı.
- **Hesap kilitleme (N hatadan sonra hesabı kalıcı kilitle):** başkasının hesabını kilitleme hizmet reddi. Çift (e-posta+IP) tavanı + IP tavanı seçildi.
- **`user_identity`'ye `email` sağlayıcısı eklemek:** CHECK genişletmesi gerektirir ve şifre özetini sağlayıcı-subject modeline sokar; ayrı tablo daha sade.
- **Şifre sıfırlama sonrası otomatik oturum açmak:** sıfırlama e-postasına erişen herkes doğrudan girer; giriş yeni şifreyle yapılsın (kullanıcı şifresini bir kez daha doğrular).

## Üretime çıkış (kod bunları yapmaz)

Migration 0101 önce staging'de, sonra üretimde `pnpm db:migrate` ile uygulanır (CLAUDE.md: Vercel main'e push'ta otomatik dağıtılır, bu yüzden önce migrate). Üretimde SMTP + `EMAIL_FROM` ve gönderen alan adında SPF/DKIM/DMARC hazır olmalı; hazır değilse arayüz seçeneği kendiliğinden gizler. Ayrıntı: `docs/ops.md` "E-posta + şifre girişi".
