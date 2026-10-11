# 0106 — Birleşik arama sonuçları (katalog + internet tek ızgara)

**Tarih:** 11 Ekim 2026
**Durum:** Kabul edildi. 0102'nin sunum kısmını değiştirir; Gemini altyapısı,
kota, maliyet ve doğrulama kuralları aynen kalır.

## Karar

1. **Tek ızgara, tek kart.** "İnternetteki seçenekler" bölümü, alt başlıklar,
   "İnternetten" rozeti ve açıklama paragrafı kaldırıldı. İnternet ürünleri
   katalog kartıyla aynı `ProductCard` ile, katalog ızgarasının sonuna `<li>`
   olarak eklenir (`ResultGrid`/`ChatResultGrid` `extra`). Mağaza adı kartta
   görünür (tek mağazada "Marka · Mağaza", çok mağazada "N mağaza" ve açılır
   mağaza listesi). Fiyat doğrulanamazsa "Fiyat mağazada"; görsel yoksa kompakt kart.
2. **Akış.** Katalog internet aramasını beklemez; her ızgara `<Suspense>`
   içinde iskelet `<li>` gösterir, sonuç gelince yerlerini alır. Katalog kartları
   yer değiştirmez (yeniden sıralama yok, layout shift yok). Katalog boşsa iskelet
   ızgara gösterilir; internet de boş/hatalıysa boş durum çıkar.
3. **Sıralama.** Veri düzeyinde "aynı ürün / benzer" ayrımı ve çekirdek sıralaması
   (tam eşleşme → doğrulanmış fiyat → mağaza sayısı → fiyat) 0102'deki gibi kalır;
   fiyatı bilinmeyen teklif fiyat sıralamasında öne geçmez. Katalog ve internet
   arasında kart yeniden dizilmez: internet kartları sona eklenir.
4. **Google Search Suggestions korunur.** Çubuk, ızgaranın sonunda tek sade satır olarak
   (sandbox iframe, Google'ın `renderedContent` HTML'i değiştirilmeden) sonuçlarla
   birlikte çizilir; öneri parçası yoksa internet sonuçları gösterilmez. Doğrulanan
   kural: öneriler grounding sonuçlarıyla birlikte ve değiştirilmeden gösterilmelidir.
   Kaynak bağlantılarının işlenmesi/ilişkilendirilmesine dair tam Hizmet Şartları
   metni burada doğrulanamadı; hukuk onayı (`WEB_SEARCH_LEGAL_APPROVED`) şartı sürer.
5. **Görselsiz ürünler kaybolmaz.** Görseli doğrulanmış ürünler önce gelir (tam eşleşme
   önce, sonra görselli, sonra çekirdek sırası); görseli bulunamayan ama doğrulanmış
   ürün sayfası olan ürün kompakt kartla sonra gösterilir (en çok 8 görselli + 4
   görselsiz). Aynı görseli paylaşan ikinci üründe görsel atılır (ürün kalır).
   Tarayıcıda yüklenemeyen görsel kartı gizlemez, kompakt karta çevirir. Görsel
   uydurulmaz, bot/robots engelleri aşılmaz (0102 kuralları aynen).
6. **Boş ve hata durumu.** Katalog boşken internet sonucu beklenir; "ürün bulunamadı"
   yalnızca bütün kaynaklar bittikten sonra söylenir. Arama başarısızlığı/limit,
   sıfır ürün sonucundan ayrı bir not olarak gösterilir. Sohbet asistanı mesajı
   sonuç bilinmeden yazıldığından "listeledim/açtım" demez; "aşağıda arıyorum" der.
7. **Bilgilendirme.** Rozet yerine ızgara sonunda tek satır: bazı bağlantılar gelir
   ortaklığı kapsamında değildir, fiyat/stok mağazada kontrol edilir. Bağlantılar
   `nofollow noopener noreferrer sponsored`; `click` üretilmez (kural 8 istisnası).

## Gerekçe

Kaynağa göre ayrışan arayüz kullanıcıya teknik bir ayrım yükler; kullanıcı ürünü
ve mağazayı görmek ister.

## Reddedilen alternatifler

- Katalog ve internet kartlarını fiyata göre tek listede yeniden sıralamak:
  sonradan gelen sonuçlar mevcut kartları kaydırır, fiyatı bilinmeyenler haksız öne/arkaya düşer.
- Çubuğu kaldırmak ya da gizlemek: grounding şartını ihlal eder (önceki taslakta yapılmıştı, geri alındı).
