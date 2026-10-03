# 0045 — Geri bildirim formu (ilk sürüm)

**Tarih:** 29 Eylül 2026
**Durum:** Kabul edildi

Lansman öncesinde erken erişim üyelerinden ve anonim ziyaretçilerden ürün
geri bildirimi toplamak için `/geri-bildirim` sayfası eklenir. Yönetim paneli,
yanıt e-postası, oylama ve eklenti bu kararın kapsamı dışındadır.

## Karar

1. **Tek yazma yolu:** form → server action (`geri-bildirim/actions.ts`) →
   `packages/core/src/feedback/submit-feedback.ts` → `feedback` tablosu
   (migration 0032). Tarayıcı tabloya doğrudan yazmaz; veritabanında public
   INSERT politikası yoktur. Sıra: oturum → doğrulama → oran sınırı → INSERT.
2. **Kimlik yalnızca oturumdan:** girişli kullanıcıda `user_id` ve hesap
   e-postası sunucudaki oturumdan gelir, `source = early_access`. Anonimde
   `user_id = NULL`, e-posta isteğe bağlı, `source = public`. Tutarlılık bir
   CHECK kısıtıyla veritabanında da zorlanır. Formda bilinmeyen alan (örn.
   `user_id`) formu reddeder. Sayfa girişli çizildiyse ve oturum bu arada
   düştüyse gönderim anonim yazılmaz; kullanıcıya tekrar giriş önerilir.
3. **Doğrulama:** Zod yok (repoda doğrulama kütüphanesi kullanılmıyor);
   `feedback/validate.ts` saf fonksiyon ve birim testli. Kategori ve öncelik
   izin listesinden, başlık 3–120, açıklama 10–5000 kod noktası, toplam
   gövde 6000 karakter. NUL ve kontrol karakterleri atılır.
4. **Oran sınırı:** mevcut sabit pencereli Redis sayacı
   (`redis/counter.ts`), **10 dakikada 5 gönderim**. Anahtar girişliyse
   `feedback:user:<id>`, anonimse `resolveClientIp` ile çözülen IP'nin
   SHA-256 özeti (`feedback:ip:<özet>`); IP çözülemezse ortak kova. Redis
   erişilemezse gönderim yazılmaz (fail-closed), giriş oran sınırıyla aynı.
5. **Durum alanı:** CHECK bugünden `new, reviewing, planned, resolved,
   rejected` değerlerini kabul eder; uygulama yalnızca `new` yazar. Yönetim
   paneli geldiğinde migration gerekmez.
6. **KVKK:** hesap silinince kullanıcının geri bildirimleri de silinir
   (`ON DELETE CASCADE`) — satır hesap e-postası taşıyabildiği için SET NULL
   kişisel veri bırakırdı. Veri indirme çıktısı (`exportUserData`) geri
   bildirimleri içerir. Logda form içeriği, e-posta ve ham hata mesajı yer
   almaz; yalnızca Postgres hata kodu.
7. **Arayüz:** sayfa ürün kapısının dışında (proxy eşleştiricisinde yok),
   giriş modali yok (0002), `noindex`. Erken erişim başarı ekranında ana
   eylemlerin üstüne çıkmayan ikincil bir satır ve footer'da İletişim'in
   yanında bağlantı. Hitap, istenen metinlere uygun olarak "siz"; marka adı
   `SITE_BRAND`'den gelir.

8. **Aydınlatma:** `/gizlilik` 2.4 yalnızca e-posta yazışmalarını
   kapsıyordu; form için toplanan alanlar, hesapla ilişkilendirme, IP özeti
   ve silme davranışı eklendi. `/kvkk-aydinlatma` "Talep/şikâyet" maddesine
   form gönderimleri eklendi. Anonim gönderimlerin saklama süresi hukukçu
   onayıyla belirlenecek.
9. **Marka adı istemcide:** `SITE_BRAND` bağımlılıksız `site-brand.ts`'e
   taşındı (`site-config.ts` yeniden ihraç eder); `site-config.ts`
   `@arilla/core` kökünü çektiği için istemci paketine giremez.

## Reddedilen alternatifler

- **Route Handler + fetch:** CSRF denetimini (`isSameOriginPost`) yeniden
  yazmayı gerektirirdi; server action bunu Next'ten hazır alır ve repodaki
  form deseni zaten budur.
- **Zod eklemek:** tek form için yeni bağımlılık; mevcut formların hiçbiri
  kullanmıyor.
- **`user_id` için SET NULL:** geri bildirim metni ürün için değerli olsa da
  hesap e-postasını ve kullanıcının kendi yazdığı metni silme sonrası tutmak
  "silme gerçek olmalıdır" kuralına aykırı.
