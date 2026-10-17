# 0131 — Sohbette gerçek katalogdan ürün keşfi (AliExpress kaynak ilanları)

**Tarih:** 17 Ekim 2026
**Durum:** Kabul edildi (migration 0087). Kod, testler ve yerel ölçüm hazır; üretimde çalıştırılmadı.
Üretimde hiçbir ürün yayınlanmadı, gate/publish çalıştırılmadı.
**Bağlam:** 0074 (konuşmalı keşif: model yalnızca niyet çıkarır), 0121 (kaynak ilanından ürün,
draft → gate → publish), 0127 (`foreign_offer_count`), 0129 (sınırlı aday kümesi, yurt dışı ürün).

## Durum (üretim, 17 Ekim 2026, kullanıcı bildirimi)

2.799.204 AliExpress teklifi; 2.769.478 ürün (hepsinde `primary_image_url`), 10 `published`,
2.769.468 `draft`. Ürünler yeniden oluşturulmaz; feed yeniden çekilmez.

## Koddan doğrulanan akış

`/sohbet` mesajı → (bayrak açıksa tek Gemini çağrısı) `SearchIntent` → `searchByIntent`
(`chat/search-adapter.ts`, 4 sn `statement_timeout`) → `parseQueryText` (sözlük) →
`searchWithFallback` → `/ara` ile AYNI sınırlı aday araması (0129) → en fazla 6 gerçek ürün →
`ChatResultGrid` (`/ara` ile aynı `ProductCard`) → `/urun/<slug>`. Model ürün, fiyat ya da SQL
üretmez (CLAUDE.md kural 1); kartların her alanı veritabanından gelir. Milyonlarca ürün modele
gitmez: model yalnızca kullanıcı metninden niyet çıkarır, arama veritabanında sınırlı adayla yapılır.

## Karar

1. **Sohbette görünürlük = yayın.** Arama, sohbet, görsel arama ve ürün sayfası yalnızca
   `publication_state = 'published'` okur; taslak hiçbir yüzeye çıkmaz ve bağlantısı 404'tür.
   Taslakları sohbete açan ayrı bir yol yazılmadı: bu, kalite kapısını ve "yayınlanmamış ürüne
   açılmayan bağlantı" kuralını aşardı. Doğru yol mevcut mimaridir:
   `gate --allow-foreign` (kalite: kaynak teklif aktif/fiyatlı/görselli/bayat değil) → `ready` →
   `publish --allow-foreign` + `CATALOG_PUBLISH_FOREIGN_APPROVED=true` (teklif bağlanır, özet
   yenilenir, ürün sayfası açılır). Yayınlanan ürün AYNI ANDA aramada ve sohbette bulunur; ek indeks
   ya da kopya yoktur (bölüm GIN'i 0083 yayınla dolar).
2. **Türkçe sorgu ↔ İngilizce başlık eş anlamlıları** (migration 0087, `lexicon.kind = 'synonym'`):
   kılıf/case/cover, hoparlör/speaker, oyuncu/gaming, akıllı saat/smart watch, şarj aleti/charger,
   çanta/bag, sırt çantası/backpack ve ekli biçimler (kılıfı, kulaklığı, hoparlörü). AliExpress
   başlıkları İngilizcedir; bunlar olmadan "iphone 16 kılıfı", "bluetooth hoparlör" İngilizce ilanı
   bulmazdı. Filtre üretmez; veriye dokunmaz; `ON CONFLICT DO NOTHING`.
3. **Fiyat sistemi olmadan keşif çalışır.** Güncel TCMB kuru yoksa yurt dışı teklif yine seçilir;
   TL fiyatı `NULL` kalır, yaklaşık TL uydurulmaz, kart yalnızca orijinal tutarı ("30,00 USD") ve
   "Kargo ve vergi belirsiz" notunu gösterir. Kullanıcı fiyat aralığı verirse TL fiyatı bilinmeyen
   ürün süzgeçten geçmiş gibi GÖSTERİLMEZ (dışarıda kalır). "En iyi fırsatlar"/"en ucuz" sıralaması
   yalnızca TRY fiyat geçmişi olan üründen yapılır; yurt dışı ürün için "en ucuz" iddiası yoktur.
4. **Kart kaynak mağazayı gösterir:** yurt dışı kartta "Yurt dışı · AliExpress", tek mağazalı TRY
   kartta "1 mağaza" yerine mağaza adı. Yeni bileşen yok; `ProductCard` ve tasarım belirteçleri aynı.
   Bozuk görsel `ProductImage` yedeğine düşer (kart bozulmaz); görseller kaynağından yüklenir,
   indirilmez/kopyalanmaz (CSP `img-src https:`).
5. **Arama hızı korunur.** Eş anlamlılarla slot başına alternatif sayısı arttı; bunu karşılamak için:
   - Birbirini kapsayan kökler tek aday koşuluna iner (`retrievalArms`): `\mkulakl` "kulaklığı"yı da kapsar.
   - Kapıda 1–2 harflik ek biçimleri budanır (`gateAlternatives`): "earphones" ⊂ "earphone".
   - Marka/kategori eşleşmesi sorgu başına bir kez, ayrı küçük sorguyla çözülür (`resolveSlotLookups`);
     kimlikler sabit gömülür, eşleşmesi olmayan slot için dal üretilmez.
   - Sıkı dal yalnızca başlık koşullarıdır (GIN bitmap düzeyinde kesişir); marka/kategori ayrı daldır.
   - 3+ slotta baş isim dalı "her seferinde bir niteleyici dışarıda" dallarıdır (kapının tam üst
     kümesi), bölüm başına bütçeyi paylaşır.
   - Çok kelimeli kalıpta kökten sonra kelimenin kalanı serbesttir (`\makil\w*\s+saat`).

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Taslakları sohbette göstermek (yayın olmadan) | Kalite kapısını atlar; kartın bağlantısı 404 olur |
| Sohbet için ayrı arama/vektör motoru | `/ara` ile tutarsız sonuç; CLAUDE.md ayrı vektör DB'yi yasaklar; mevcut arama yeterince hızlı |
| Ürünleri modelin bağlamına göndermek | Model ürün/fiyat üretmez (kural 1); milyonlarca kayıt bağlama sığmaz |
| Kur yoksa yurt dışı ürünü gizlemek (eski davranış) | Ürün keşfi fiyat sistemine bağımlı kalırdı |
| Başlıkları Türkçeye çevirip saklamak | 2,8M satır yeniden yazma + model maliyeti; eş anlamlı sözlük yeterli |

## Ölçüm (yerel, 3,77M ürün: 1M TRY + 2,77M USD, hepsi yayında varsayıldı; sentetik)

Sessiz makinede, ısınma + 5 koşu. `/ara` 33 sorgu: p50 186 ms, p95 664 ms, en kötü 1.148 ms
(0129'da eş anlamlısız 168 / 561 / 751 ms: daha fazla alternatif daha fazla doğru eşleşme getirir).
Sohbet (`searchByIntent`) 10 sorgu: p50 331 ms, p95 989 ms, en kötü 1.011 ms; 4 sn sınırı aşılmadı.
Eş anlamlılar ilk eklendiğinde (dal düzeni değişmeden) `/ara` p95 1.267 ms'ye çıkmış, sohbette
"bluetooth hoparlör" ve "iphone 16 pro 256 gb" 4 sn'yi aşmıştı; madde 5'teki değişiklikler bunu giderdi.
Ölçüm sırasında başka bir oturumun veritabanı konteyneri aynı makinede %100 CPU kullandığında
süreler 2–4 kat arttı; yukarıdaki değerler yük yokken alındı.

## Sonuçlar ve riskler

- Bugün sohbette erişilebilir AliExpress ürünü yalnızca yayındaki 10 üründür. Geri kalanı ancak
  gate + publish (kullanıcı onayıyla, kademeli `--limit`) sonrası görünür.
- "Ev için kullanışlı ürünler" gibi kategori adı olmayan istekler deterministik yolda sonuç vermez;
  sohbette niyeti somut ürün türüne çeviren model yorumudur (bayrak). Sahte sonuç üretilmez.
- Eş anlamlılar geniştir: "cover" yastık kılıfını da getirir (Türkçe "kılıf" da öyle).
