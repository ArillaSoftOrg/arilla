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
4. **Google Search Suggestions çubuğu çizilmez.** Bu, ürün sahibinin açık kararıdır.
   **Risk:** Gemini "Grounding with Google Search" şartları, grounding sonuçlarının
   Search Suggestions ile birlikte gösterilmesini ister. Çekirdek (`searchWeb`)
   değiştirilmedi; öneri parçası hâlâ alınır ve atılır. Üretimde
   `WEB_SEARCH_LEGAL_APPROVED` verilmeden önce hukuk bu sapmayı onaylamalıdır
   ya da bileşen geri getirilmelidir.
5. **Bilgilendirme.** Rozet yerine ızgara sonunda tek satır: bazı bağlantılar gelir
   ortaklığı kapsamında değildir, fiyat/stok mağazada kontrol edilir. Bağlantılar
   `nofollow noopener noreferrer sponsored`; `click` üretilmez (kural 8 istisnası).

## Gerekçe

Kaynağa göre ayrışan arayüz kullanıcıya teknik bir ayrım yükler; kullanıcı ürünü
ve mağazayı görmek ister.

## Reddedilen alternatifler

- Katalog ve internet kartlarını fiyata göre tek listede yeniden sıralamak:
  sonradan gelen sonuçlar mevcut kartları kaydırır, fiyatı bilinmeyenler haksız öne/arkaya düşer.
- Çubuğu görünmez/küçük tutmak: "değiştirilmeden" şartını yine ihlal eder.
