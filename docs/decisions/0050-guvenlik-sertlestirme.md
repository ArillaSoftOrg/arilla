# 0050 — Güvenlik sertleştirme: başlıklar, rol denetimi, oturum kapatma, silme

**Tarih:** 3 Ekim 2026
**Durum:** Kabul edildi

Salt okunur güvenlik denetiminin (2026-10-03) doğrulanmış bulguları. Kimlik
doğrulama modeli (0006, 0044) DEĞİŞMEZ; yetki haritası (0039) aynen kalır.

## Karar

1. **Özel anahtar koruması.** `.gitignore` `*.p8`, `AuthKey_*`, `*.pem`,
   `*.p12`, `*.pfx`, `*.jks`, `*.keystore` ve SSH anahtar adlarını yok sayar.
   `scripts/check-private-keys.mjs` (`pnpm check:secrets`, CI
   `security-checks`) izlenen/sahnelenmiş dosyada anahtar adı ya da PEM özel
   anahtar başlığı görürse ve `.gitignore` kuralı silinmişse başarısız olur.
   Çıktı yalnızca yol taşır. Denetimde depo kökünde bulunan Apple `.p8`
   geçmişte hiç commit'lenmemişti; depo dışına taşındı, döndürme gerekmedi.
2. **Güvenlik başlıkları** (`apps/web/security-headers.ts`, `next.config.ts`
   `headers()`), her yanıtta: CSP (`default-src 'self'`, betik/stil/font
   yalnızca kendi kökenimiz, görsel `https:` — mağaza görselleri,
   `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` + Google +
   Apple, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`,
   `Referrer-Policy: strict-origin-when-cross-origin`, kısıtlayıcı
   `Permissions-Policy`, `COOP: same-origin`; HSTS (`max-age=31536000`, alt
   alan adı ve preload YOK) ve `upgrade-insecure-requests` yalnızca Vercel
   üretim derlemesinde. `/yonetim` ayrıca `X-Robots-Tag: noindex`.
3. **Rol değişikliği motorda denetlenir** (migration 0039). `app_user.role`
   her değiştiğinde (ve `user` dışı rolle hesap açıldığında) tetikleyici aynı
   işlemde `users.role_change` yazar: hedef, eski/yeni rol,
   `outcome: applied`, bağlanan veritabanı rolü (`after.dbRole`); aktör ve
   gerekçe istege bağlı `arilla.audit_*` oturum ayarlarından. Tetikleyiciyi
   yalnızca tablo sahibi kaldırabilir. Mevcut yetkili hesaplar için bir kez
   `outcome: backfill` satırı yazılır.
4. **Oturum kapatma.** Kullanıcı: `/hesap` "Tüm cihazlardan çıkış".
   Yönetici: `/yonetim/kullanicilar/[publicId]` "Tüm oturumları kapat" —
   yeni yetenek `users.sessions.revoke` (yalnızca yönetici), taze giriş
   (0044 listesine eklenir), gerekçe zorunlu, `sessions.revoke_all` denetimi.
   Acil durum: `pnpm db:revoke-sessions` (sahip rol, uzakta yalnızca
   `--confirm-remote`, `--demote` ile rol düşürme). 12 saat / 30 dk / 1 saat
   kuralları değişmez.
5. **Silme politikası.** Yetkili (moderatör/yönetici) hesap kendini silemez
   (`StaffAccountDeletionError`); önce rolü düşürülür (3. madde ile
   denetlenir). Böylece çalınmış yönetici oturumu hesabı silip iz
   kaybettiremez. `admin_audit_event.actor_user_id` ve
   `match_candidate.reviewed_by` artık `ON DELETE SET NULL`: rolü düşürülmüş
   hesap silinince denetim satırları kalır, yalnızca aktör bağlantısı boşalır
   (`actor_role`, eylem, hedef, zaman korunur). Silmede giriş bağlantıları
   hesap e-postası VE bağlı kimlik e-postaları için temizlenir; oturum ve
   kimlikler CASCADE ile aynı işlemde gider.
6. **Güvenlik olayları denetimde.** `security.access_denied` (girişli ama
   yetkisiz yönetim isteği; hedef yetenek adı; hesap + yetenek başına 10 dk'da
   bir satır) ve `security.admin_session_ended` (`expired`/`idle`). Yol, IP,
   e-posta yazılmaz. Kayıt yazılamazsa yetki kararı değişmez.
7. **Kampanya test gönderimi** yalnızca gönderen yöneticinin kendi adresine
   (hesap e-postası ya da doğrulanmış kimlik e-postası) veya
   `MARKETING_TEST_RECIPIENTS` izin listesine; saatte 10 sınırı aynen.
   Reddedilen deneme sayılmaz ve yazılmaz; denetimde `recipientKind`.

8. **Token taşıyan adresler** (`/giris/dogrula`, `/abonelik-iptali`,
   `/api/email/unsubscribe`) genel başlık listesinden SONRA `Referrer-Policy:
   no-referrer` alır; genel başlık rotanın kendi değerini bastırmasın.

## Doğrulama (P4)

`apps/web/e2e/security.e2e.test.ts`: çalışan `next start`'a gerçek HTTP ile
anonim/kullanıcı/moderatör/yönetici sınırı, sahte/iptal edilmiş oturum, rol
düşürme, 12 saat/30 dk, kullanıcı A → B veri indirme, açık yönlendirme, sahte iç
başlık, route handler CSRF, cron sırrı, abonelik GET'i, başlıklar ve denetim
izleri. Yalnızca yerel veritabanı; sunucu ve test aynı `SESSION_SECRET`:

```bash
pnpm --filter @arilla/web build && pnpm --filter @arilla/web start -p 3312   # ayrı terminal
E2E_BASE_URL=http://localhost:3312 pnpm --filter @arilla/web test:e2e
```

## Gerekçe

- Kod incelemesine bırakılan kural kayar (0010, 0027 ile aynı ilke): rol
  denetimi tetikleyicide, append-only REVOKE'ta, CI'da.
- Çerçeveleme yasağı tek tıkla eşleştirme onayı gibi yönetim eylemlerini
  tıklama hırsızlığına karşı korur; CSP üçüncü taraf kaynağı zaten yasak olan
  kuralı (CLAUDE.md "Tema ve tipografi") tarayıcıya da uygulatır.
- 90 günlük oturumda acil kapatma olmadan tek çare SQL'di.

## Reddedilen alternatifler

- **Nonce'lu CSP:** Next her sayfayı dinamik render eder; statik/ISR SEO
  sayfaları bozulur. `script-src 'unsafe-inline'` bilerek kalır; diğer
  direktifler sıkı. Statik sayfa stratejisi değişirse yeniden değerlendirilir.
- **Ayrı yönetim alan adı:** aynı kökende 12 saat/30 dk/taze giriş ve çerçeve
  yasağı varken somut ek kazanç yok.
- **Zorunlu MFA / ayrı yönetici izin listesi:** giriş yalnızca Google ve Apple;
  ikisi de kendi MFA'sını sunar. Rol yalnızca sahip rolüyle değişir ve artık
  motorda denetlenir. Yönetici sayısı büyürse yeniden konuşulur.
- **Denetim satırında silinen personelin kimliğini saklamak:** KVKK silme
  hakkıyla çelişir; rol ve eylem izi yeterli.
- **Personel silmede rolü otomatik düşürmek:** sessiz yetki kaybı ve iz
  karmaşası; açık, denetimli rol düşürme tercih edildi.
