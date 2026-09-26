# 0038 — Çerez rızası ve yasal sayfalar

**Tarih:** 26 Eylül 2026
**Durum:** Kabul edildi

## Karar

1. **Rıza kaydı birinci taraf `cookie_consent` çerezinde tutulur.** Değer
   `{version, necessary, functional, analytics, marketing, updatedAt}` JSON'u,
   12 ay geçerli, `SameSite=Lax`. Yazma işi server action'dadır; banner ve
   tercih formu JS olmadan da çalışır. `localStorage` / `sessionStorage`
   kullanılmaz (CLAUDE.md).
2. **Rıza mantığı `packages/core/src/consent/cookie-consent.ts` içindedir**
   ve istemci bileşenlerinin sunucu bağımlılığı çekmemesi için ayrı bir alt
   yoldan (`@arilla/core/cookie-consent`) dışa aktarılır. Hesaba bağlı
   rızalar (`user_consent`, `account/consent.ts`) ayrı bir konudur; bu çerez
   onlarla karıştırılmaz.
3. **Banner her ilk ziyarette gösterilir**, modal değil sayfanın altında
   bir şerittir. İçeriği kapatmaz, kaydırmayı kilitlemez; SEO rotalarında
   araya girici modal yasağı (0002) korunur. Üç düğme — Tümünü Reddet,
   Tercihleri Yönet, Tümünü Kabul Et — aynı görsel ağırlıktadır.
4. **Zorunlu olmayan her istemci teknolojisi `<ConsentGate category>`
   arkasından mount edilir.** İzin yoksa çocuklar hiç render edilmez; izin
   geri çekilince unmount olur ve yeni olay gönderilmez. Bugün kapıdan
   geçen bir betik yoktur (analitik, piksel, affiliate çerezi yok); kapı,
   ilk analitik veya affiliate ölçüm betiği eklendiğinde tek giriş
   noktasıdır. Sunucu tarafı ölçüm eklenirse aynı çerez `readConsent()` ile
   okunur.
5. **Rıza sürümü `CONSENT_VERSION` sabitidir.** Kategori veya politika
   değişince artırılır; eski sürümlü çerez yok sayılır ve banner yeniden
   çıkar.
6. **Yasal sayfalar mevcut slug'ları korur** (`/gizlilik`, `/kosullar`,
   `/cerez`), yeni sayfalar eklenir: `/kvkk-aydinlatma`,
   `/affiliate-aciklamasi`, `/sirket-bilgileri`. Hukuk paketindeki
   `/kullanim-kosullari` ve `/cerez-politikasi` adları kalıcı (308)
   yönlendirmeyle mevcut sayfalara bağlanır.
7. **Şirket kimliğinin tek kaynağı `packages/core/src/config/legal-identity.ts`.**
   Doğrulanmamış alanlar `null` kalır ve arayüzde render edilmez; yer tutucu,
   örnek telefon veya tahmini unvan gösterilmez.

## Gerekçe

- KVKK Kurulu'nun çerez rehberi ve ePrivacy uygulaması, zorunlu olmayan
  çerezler için önceden, özgür iradeyle ve reddetmesi kabul etmesi kadar
  kolay bir rıza bekler. Kapı mekanizması, gelecekte eklenecek bir betiğin
  sessizce rızasız çalışmasını mimari olarak zorlaştırır.
- Rızayı çerezde tutmak, sunucunun ilk HTML'de banner'ı gösterip
  göstermeyeceğini bilmesini sağlar: yanıp sönme yok, JS'siz de çalışır.
- URL'ler geri alınamaz (routes.md); canlı ve sitemap'teki slug'ları
  değiştirmek SEO ve paylaşılmış linkleri kırardı.

## Reddedilen alternatifler

- **Üçüncü taraf CMP (Cookiebot, OneTrust vb.):** harici betik yükler ve
  kullanıcı IP'sini yurt dışına taşır (0009 ile aynı gerekçe); bugün
  yönetilecek üçüncü taraf çerez de yok.
- **Rızayı `localStorage`'da tutmak:** sunucu okuyamaz, ilk yüklemede banner
  yanıp söner, CLAUDE.md kuralına aykırı.
- **Banner'ı modal yapmak:** SEO rotalarında araya girici modal (0002).
- **Kullanılmayan teknoloji olmadığı için banner'ı gizlemek:** ürün kararı
  olarak her ilk ziyarette gösterilmesi seçildi; panelde her zorunlu olmayan
  kategori için "şu an bu kategoride teknoloji kullanılmıyor" notu yazılır,
  böylece banner olmayan bir takibi varmış gibi sunmaz.
