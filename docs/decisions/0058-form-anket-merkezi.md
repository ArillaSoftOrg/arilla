# 0058 — Form / anket merkezi

**Tarih:** 3 Ekim 2026
**Durum:** Kabul edildi

Yalnızca onboarding anketi değil: yönetici istediği zaman form oluşturup
`/anket/<slug>` ile yayınlar, sosyal medyada paylaşır. Geri bildirimden
(`/geri-bildirim`, 0045) ayrıdır: geri bildirim kullanıcının kendiliğinden
yazdığı mesajdır, form bizim sorduğumuz yapılandırılmış sorulardır; tablolar
paylaşılmaz.

## Karar

1. **Normalize model** (migration 0043): `form` → `form_question` →
   `form_question_option`; `form_response` → `form_answer` (seçenek cevabı
   `option_id`, metin `text_value`); `form_skip`. JSON yerine normalize:
   seçenek dağılımı SQL ile sayılır, seçenek kimliği allowlist'tir.
2. **Tek yazma yolu:** form → server action → durum/hedef kitle → oturum →
   doğrulama → oran sınırı → tek işlemde INSERT. Soru tipi, seçenekler ve
   zorunluluk her zaman sunucudaki tanımdan okunur; bilinmeyen alan formu
   reddeder. `user_id` yalnızca sunucu oturumundan.
3. **Hedef kitle:** `public` (giriş yok), `authenticated`, `early_access`
   (giriş + `early_access` kaydı). Taslak ziyaretçiye 404; kapalı, süresi
   dolmuş ya da henüz başlamamış için durum ekranı. Onboarding formu herkese
   açık olamaz (CHECK).
4. **Tek yanıt:** girişli kullanıcıda kısmi UNIQUE indeks (`single_response`
   yanıt anında formdan kopyalanır): çift tık ve yarış durumu motorda
   engellenir. Anonimde kimlik garantisi yoktur: IP özeti başına 10 dk / 5
   gönderim, tek yanıtlı formda ek olarak günde 3 (mobil operatör NAT'ı
   arkasındaki gerçek kullanıcıları kilitlememek için 1 değil 3). Redis yoksa
   gönderim yazılmaz (fail-closed).
5. **Soru kilidi:** yanıt alınmış formun soruları değiştirilemez (cevaplar
   sorulara bağlı). Yayınlanmış formun adresi değişmez (paylaşılan bağlantı).
   Eş zamanlı düzenleme `updated_at` ile yakalanır.
6. **Onboarding:** yayında en fazla bir onboarding formu (kısmi UNIQUE).
   Erken erişim sayfası, ilk katılımda (10 dk pencere) ve atlama kaydı ya da
   yanıt yoksa bir kez `/anket/<slug>`'e yönlendirir. "Şimdilik geç"
   yalnızca `form_skip` yazar: erken erişim kaydına dokunmaz, tamamlandı
   saymaz. Atlayan kullanıcı Hesabım'da "Tamamlanmamış formlar" ile ya da
   erken erişim sayfasındaki kartla doldurur; yanıtlanınca listeden kalkar.
   `public` hedefli formlar Hesabım'da listelenmez (paylaşım bağlantısıdır).
7. **Giriş dönüşü:** lansman öncesi normal kullanıcının girişi her zaman
   `/erken-erisim`'e giderdi; `postAuthRedirect` artık yalnızca
   `/anket/<slug>` (sorgu yok) `next`'ini kabul eder, serbest `next`'i değil.
8. **Yetki ve denetim:** yeni `forms.manage` (yalnızca yönetici; yanıtlar
   hesaba bağlı olabilir). Create/update/publish/close/results_view aynı
   işlemde `admin_audit_event`'e yazılır; soru metni, cevap ve kullanıcı
   yazılmaz. Sonuç ekranı e-posta değil hesabın public kimliğini gösterir.
9. **Paylaşım:** `/anket/*` robots.txt'te engellenmez (Facebook/X önizleme
   botları robots'a uyar); sayfa `noindex` + Open Graph başlığı/açıklaması
   yayındaki formdan gelir. Sitemap'e girmez.
10. **KVKK:** hesap silinince yanıt, cevap ve atlama kayıtları silinir
    (CASCADE); veri indirme çıktısına dahil; `/gizlilik` 2.5 ve
    `/kvkk-aydinlatma` güncellendi. Data API: yeni tablolara `anon` /
    `authenticated` yetkisi verilmez (0042 varsayılan yetkileri kapattı).

## Reddedilen alternatifler

- **Cevapları JSON kolonunda tutmak:** seçenek dağılımı için JSON sorgusu,
  seçenek kimliği doğrulaması yok, silinen seçenek sessizce kalır.
- **Feedback tablosunu yeniden kullanmak:** kavramlar ve yaşam döngüleri
  farklı; geri bildirim kendiliğinden, form yönetilen sorulardır.
- **Her erken erişim girişinde forma yönlendirmek:** itici; yalnızca ilk
  katılımda yönlendirilir, gerisi kart ve Hesabım.
- **`/anket/`'i robots'ta engellemek:** sosyal medya önizlemesini bozar.
