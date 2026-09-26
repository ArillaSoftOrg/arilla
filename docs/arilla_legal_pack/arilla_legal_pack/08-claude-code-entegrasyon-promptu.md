# Claude Code Entegrasyon Promptu

Aşağıdaki görevi mevcut Arilla reposunda uygula. Bu bir **legal/compliance + consent integration** görevidir. Mevcut ürün geliştirmelerini, tasarım sistemini veya ürün veri mimarisini gereksiz yere değiştirme.

## Kaynak dosyalar

Önce şu legal pack dosyalarını oku:

- `01-gizlilik-politikasi.md`
- `02-kvkk-aydinlatma-metni.md`
- `03-cerez-politikasi.md`
- `04-kullanim-kosullari.md`
- `05-affiliate-aciklamasi.md`
- `06-sirket-bilgileri.md`
- `07-cookie-banner-uygulama-spesifikasyonu.md`
- `LEGAL_FIELDS_REQUIRED.md`

Bunlar içerik ve davranış için başlangıç kaynağıdır. Ancak repoda fiilen kullanılmayan servisleri, çerezleri veya veri akışlarını politika metinlerine ekleme.

## 1. Önce read-only audit yap

Kod değiştirmeden önce şu konuları tespit et ve kısa bir audit özeti çıkar:

- Next.js routing yapısı ve mevcut footer/header.
- Mevcut auth sistemi ve kullanılan OAuth sağlayıcıları.
- Session/cookie/localStorage kullanımı.
- Analytics, telemetry, error tracking, pixels veya marketing scriptleri.
- Affiliate link üretimi veya redirect/tracking mekanizması.
- Kullanıcı search/history/favorites vb. verilerinin nerede tutulduğu.
- Kullanılan üçüncü taraf altyapı ve API sağlayıcıları.
- Mevcut legal/privacy/terms sayfaları veya yarım kalan route'lar.
- Merkezi site/company/contact config var mı.
- Production ortamında gerçek şirket bilgisi var mı.

Özellikle kaynak kodu, package.json/lockfile, env adları ve gerçek entegrasyonlardan doğrula. Sadece env adı görüp sağlayıcının aktif olduğunu varsayma.

## 2. Merkezi legal/company config oluştur

Proje mimarisine uygun tek kaynak oluştur. Örnek alanlar:

```ts
{
  brandName: "Arilla",
  legalEntityName: null,
  legalAddress: null,
  country: null,
  privacyEmail: null,
  supportEmail: null,
  websiteUrl: "...",
  mersisNo: null,
  taxOfficeAndNo: null,
  tradeRegistryNo: null,
  phone: null
}
```

Eğer repo içinde doğrulanmış gerçek değer varsa onu kullan. Yoksa kesinlikle şirket unvanı, adres, vergi no, telefon veya e-posta uydurma.

Production UI'da `{{PLACEHOLDER}}`, sahte telefon, sahte şirket veya Lorem Ipsum gösterme.

Eksik yasal kimlik alanlarını final raporda **BLOCKER: LEGAL IDENTITY DATA REQUIRED** olarak listele.

## 3. Legal route'ları oluştur

Mevcut route naming convention'ına uyarak tercihen Türkçe route'lar:

- `/gizlilik`
- `/kvkk-aydinlatma`
- `/cerez-politikasi`
- `/kullanim-kosullari`
- `/affiliate-aciklamasi`
- `/sirket-bilgileri`

Projede İngilizce slug standardı varsa mevcut standardı bozma; gerekirse redirect/alias ekle.

Sayfalarda:
- mevcut tasarım sistemi,
- typography,
- container,
- responsive spacing,
- dark/light mode varsa mevcut tokenlar

kullanılmalı.

Yeni ve bağımsız bir görsel tasarım sistemi oluşturma.

## 4. Metinleri repo gerçeklerine göre uyumla

Legal pack'teki içerikleri kullan; fakat şu kuralları uygula:

- Kullanılmayan servis sağlayıcı adı ekleme.
- Gerçek veri akışını gizleme veya eksiltme.
- Google OAuth aktifse hesap verisi bölümünü buna göre somutlaştır.
- Search history tutulmuyorsa "saklıyoruz" deme.
- Görsel upload yoksa görsel verisi maddesini kaldır.
- Affiliate sistemi henüz aktif değilse metni "kullanılabilir/aktif edildiğinde" bağlamında doğru ifade et.
- Admitad aktif edildiğinde gerçek tracking/cookie davranışını yeniden denetle.
- Somut retention süreleri kod/config/politikada doğrulanabiliyorsa yaz; değilse uydurma.
- Yurt dışı aktarım sağlayıcılarını ancak gerçekten doğrulandıysa belirt.

## 5. Cookie banner + consent center uygula

`07-cookie-banner-uygulama-spesifikasyonu.md` kurallarını uygula.

Zorunlu olmayan kategoriler ilk yüklemede **false**.

Banner:
- Tümünü Reddet
- Tercihleri Yönet
- Tümünü Kabul Et

sunmalı.

Kabul ve reddet kullanıcı açısından benzer erişilebilirlikte olmalı.

Footer'a sürekli erişilebilir **Çerez Tercihleri** linki ekle.

## 6. Gerçek script gating uygula

Sadece UI banner yapma.

Repoda analytics/marketing/optional telemetry bulunuyorsa bunların yüklenmesini consent state ile gerçekten engelle.

Consent verilmeden:
- analytics SDK init yok,
- marketing pixel/tag yok,
- optional tracking event yok.

Kullanıcı sonradan reddederse yeni event gönderimini durdur.

## 7. Footer legal alanını tamamla

Footer'a tasarımı bozmadan şu bağlantıları ekle:

- Gizlilik
- KVKK Aydınlatma
- Çerez Politikası
- Kullanım Koşulları
- Affiliate Açıklaması
- Şirket Bilgileri
- Çerez Tercihleri

Mevcut footer çok yoğunsa bunları "Yasal" başlığı altında grupla.

## 8. Affiliate disclosure görünürlüğü

Ürünları üçüncü taraf mağazalara yönlendiren alanlarda, kullanıcıya görünür ama rahatsız etmeyen kısa bir disclosure ekle. Örnek:

> Bazı bağlantılar affiliate bağlantısıdır. Bu bağlantılar üzerinden yapılan uygun alışverişlerden komisyon kazanabiliriz; bu size ek maliyet oluşturmaz.

Sponsorlu/ücretli sıralama varsa organik sonuçtan açıkça ayır.

## 9. Metadata ve erişilebilirlik

Her legal route için:
- anlamlı title,
- description,
- canonical URL mevcut site yapısına uygunsa,
- doğru heading hiyerarşisi,
- klavye ve ekran okuyucu uyumluluğu

sağla.

## 10. Test ve doğrulama

Değişikliklerden sonra çalıştır:

- lint
- typecheck
- unit/integration testler
- build
- varsa Playwright/E2E

Ayrıca manuel veya otomatik olarak doğrula:

- İlk ziyaret banner çıkıyor.
- Reject all sonrası zorunlu olmayan takip yok.
- Accept all sonrası izin verilen scriptler çalışıyor.
- Tercihler kaydediliyor ve geri açılabiliyor.
- Tüm legal route'lar 200.
- Footer linkleri kırık değil.
- Mobil görünüm taşmıyor.
- Production HTML/UI içinde `{{`, `TODO`, fake company data veya örnek telefon yok.

## 11. Kapsam dışı

Bu görevde:
- ürün scraping/enrichment pipeline'ını değiştirme,
- arama algoritmasını değiştirme,
- veri modelini sırf legal sayfalar için gereksiz yere yeniden tasarlama,
- mevcut görsel tasarımı yeniden tasarlama,
- unrelated blocker/fix'lere girme.

## 12. Git

Mevcut çalışma ağacını önce kontrol et. Başka kişinin değişikliklerini bozma.

Yeni branch gerekliyse:
`feature/legal-consent`

Anlamlı küçük commit'ler oluştur. Push/PR işlemini ancak mevcut ekip akışına uygunsa yap; kullanıcı açıkça istemediyse main'e doğrudan merge etme.

## 13. Final rapor

Bittiğinde şunları ver:

1. Audit sonucu: gerçekte hangi veri/çerez/tracking mekanizmaları bulundu.
2. Değişen dosyalar.
3. Oluşturulan route'lar.
4. Cookie consent davranışı.
5. Hangi üçüncü taraf scriptlerin gated edildiği.
6. Test/lint/build sonuçları.
7. Kalan gerçek blocker'lar.
8. Özellikle eksik şirket/yasal kimlik alanlarını ayrı listele.

Şirket bilgilerini tahmin ederek blocker'ı kapatılmış gösterme.
