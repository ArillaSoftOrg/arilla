# 0200 — Sohbet sonuç bloğu v2: özet satırı, kademeli gösterim, eski blokları açma

**Tarih:** 15 Kasım 2026 · **Durum:** kabul edildi · **Bayrak:** `CHAT_UX_V2` (varsayılan kapalı)

Dupe benzeri sohbet deneyiminin (plan: Faz 2) ilk parçası. Arama, niyet, sıralama ve ürün
verisi DEĞİŞMEZ; yalnız sonuç bloğunun düzeni.

## Karar

`CHAT_DISCOVERY_ENABLED=true` ve `CHAT_UX_V2=true` iken:

1. **Özet satırı:** sonuçların üstünde "12 mağazadan 20 ürün" (arama simgesiyle, tek satır).
   Sayılar GÖSTERİLEN katalog kartlarından hesaplanır (`summarizeResults`; en çok 30), toplam
   eşleşmeden değil: ekrandaki kartla özet tutarlı kalır. Mağaza sayısı her ürünün seçilen en
   iyi teklifinin mağazasıdır (alt sınır); mağaza adı yoksa yalnız ürün sayısı. Internet
   (web) kartları katalog verisi değildir ve sayıya girmez. Eski "N sonuç" etiketi gizlenir.
2. **Kademeli gösterim:** ilk 6 kart görünür, devamı yumuşak soluklaşır ve "Tüm N sonucu gör"
   düğmesi AYNI sayfada açar (`aria-expanded`, "Daha az göster"). Ayrı sonuç sayfası yok.
   Gizli kartlar DOM'a girmez (görselleri yüklenmez). Internet kartları yalnız açıkken eklenir.
3. **Sekme başına üst sınır 30:** katalog + internet kartı toplamı en çok 30; katalog 30'u
   doldurduysa internet kartı çizilmez (`webCardLimit`). Not: internet araması (tek Gemini
   çağrısı, karar 0102) katalog sonucundan ÖNCE paralel başladığı için sınır dolsa bile o çağrı
   yapılmış olur; yalnız çizilmez.
4. **Eski arama blokları açılıp kapanır:** bugün olduğu gibi eski bloklar yalnız niyet çipleriyle
   görünür; yeni olarak "Sonuçları göster" bağlantısı (`?ac=<seq>`, mevcut `?sirala=` kalıbı,
   `scroll={false}`) en çok 2 eski bloğu aynı anda açar. Açılan blok `compact`: en çok 6 kart,
   sekme/oy/internet araması yok. Kapalıyken eski bloklar için sorgu YOKTUR (maliyet sıfır).
   `?ac=` değeri sunucuda doğrulanır (bilinmeyen/yinelenen/uzun değer atılır, en yeni 2 korunur).

Bayrak kapalıyken blok düzeni bugünküyle aynıdır.

## Plandan sapma

Planda "arama mesajı payload'ına `ids` (≤30)" vardı. Arama sonuçları tur sırasında değil sayfa
çizilirken hesaplandığı ve `chat_message` değiştirilemez (UPDATE yok) olduğu için bu Faz 2'de
yazılamaz. Model cevabının (Faz 7) kullanıcının gördüğü ürünlere dayanması gerekirse o fazda
çözülür (örn. ürün kimliklerini ayrı, eklemeli bir kayıtla saklamak).

## Reddedilen

- **Sunucuda sayfalama / ayrı sonuç sayfası:** sohbet bağlamını koparır (kullanıcı kararı).
- **İlk kartları sunucuda kırpıp "devamını yükle" isteği:** ek sorgu; mevcut 30'luk tek sorgu
  yeterli, kırpma istemcide.
- **Eski blokları açılışta sorgulamak:** her sayfa yüklemesinde N arama.

## Sınırlar

Kart/özet sayıları gösterilen sayfaya göre (≤30); toplam eşleşme sayısı gösterilmez. Sekme
bağlantıları `?ac=`'yi korumaz (sekme değişince açık eski bloklar kapanır).
