# 0133 — Merkezi ürün sınıflandırma: marka ve kategori

**Tarih:** 18 Ekim 2026
**Durum:** Önerildi (PR). Üretimde çalıştırma ayrı, açık bir operasyon kararıdır.

## Sorun

Üretimde yayınlanan 2.047.527 AliExpress ürününün tamamı markasız ve kategorisiz. Neden iki parçalı:

1. **Eşleme eksikliği (kategori):** AliExpress beslemesi (Admitad 6115, YML) `categoryId` ve
   `<categories>` ağacı verir; ingest bunu `offer.category_raw`a `"Üst > Alt"` yolu olarak yazar.
   `catalog_build` taslak ürünü yalnızca başlık + görselle açar (karar 0121); `category_raw` hiç
   okunmaz ve merkezi ağaçla eşleme yoktur (`category_source_map` boş).
2. **Veri eksikliği (marka):** beslemede marka alanı **yok** (`feeds/profiles.py`: "GTIN, marka,
   SKU/varyant, stok ve kargo YOK"). Marka yalnızca başlıktan, temkinli çıkarılabilir.

Ayrıca merkezi ağaç (0016) yalnızca 9 ana kategoriydi ve arama/sohbet sözlüğünde hiç `category`
satırı yoktu: sohbetin `intent.category` alanı bugün hiçbir kategoriye çevrilemiyordu.

## Karar

1. **Tek ağaç, genişletildi (migration 0089).** Mevcut 0016 kökleri korunur; ~135 Türkçe alt dal
   (`elektronik/ses/kulaklik/oyuncu`, `moda/canta/omuz-cantasi`, `ev-yasam/mutfak/kahve-ekipmanlari`…)
   yola göre idempotent eklenir. İkinci/paralel ağaç yok; mağaza kategorisi ağaca
   `category_source_map` ile bağlanır. Giyimde cinsiyet dalı (kadın/erkek), çanta ve ayakkabıda yok
   (cinsiyet başlıkta kalır). İç giyim, mayo, sağlık, cinsel sağlık, petshop `is_discoverable=FALSE`.
2. **Sınıflandırma ayrı bir toplu iş (`services/ingest/classify`).** Model çağrısı yok; kurallar
   (`classify/taxonomy.py`) hem kaynak kategori adına (İngilizce AliExpress, Türkçe HB/Trendyol) hem
   başlığa uygulanır. Öncelik: korunan mevcut değer > onaylı kaynak eşlemesi > kural önerisi (kaynak
   yolu; en derin eşleşen bölüm) > başlıkla daraltma (kaynağın altındaki daha özel dal) > yalnız başlık.
   Güven < 80 ya da çelişki → ürüne **yazılmaz**, `product_classification.state='review'`.
3. **Marka.** Yapılandırılmış alan (HB/Trendyol) anahtarla (`brand_key`: aksansız, küçük harf, yalnız
   harf/rakam) mevcut markaya bağlanır; "XIAOMI/Xiaomi/xiaomi" tek satırdır, "No Brand/Markasız/OEM"
   elenir. Başlıktan yalnızca seçilmiş listedeki ve `title_ok` markalar; "for iPhone", "compatible
   with", "… için", "… ile uyumlu" **uyumluluktur** (`compatible_brands`), ürünün markası değildir;
   cihaz üreticisi aksesuar dalında ve kategori bilinmiyorken marka olmaz; iki marka → yazılmaz;
   taklidi yaygın Batı markaları başlıktan hiç yazılmaz.
4. **Ürüne dokunuş sınırlı.** Yalnız `brand_id`/`category_id` (+`updated_at`); yeni ürün, slug,
   görsel, fiyat, teklif bağı, `publication_state` yazılmaz. Güncelleme eski değerle koşulludur
   (eşzamanlı değişiklik ezilmez). İş yalnızca **kendi yazdığı** değeri sonraki sürümde değiştirir
   (`wrote_*` + değer hâlâ aynı); yönetici/besleme değeri korunur.
5. **Toplu güncelleme.** 2.000'lik partiler, her parti tek kısa işlem (marka + kaynak eşleme önerisi
   + ürün + kanıt + `search_outbox` + kontrol noktası). `product_classification_state (rule_version,
   scope)` kaldığı yerden devam eder; `--rescan` baştan, yeni kural sürümü yeni satır. `lock_timeout`
   3 sn; WAL arşiv gecikmesi > 2 GiB ise bekler; `catalog_build` oturumu varken başlamaz (yayın
   `SKIP LOCKED` kullanır, tutulan satırı atlardı).
6. **Arama/sohbet sözlüğü siniflandirmadan SONRA açılır.** `classify lexicon --apply` kategori
   yüzeylerini (ağırlık = derinlik; "mutfak için kahve ekipmanları" → en derin dal) ve birkaç TR↔EN
   eşanlamını yazar. Kategori yüzeyi katı filtredir; kapsam düşükken açılırsa kategorisiz ürünler o
   sorgularda görünmezdi — bu yüzden migration ile değil, komutla. Marka sözlüğe **eklenmez**: marka
   katı filtre olursa "Samsung uyumlu" aksesuarlar ve markasız ilanlar dışlanırdı; marka eşleşmesi
   mevcut aday kapısında (`brand_id` ya da başlık) kalır.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Her ürünü Gemini'ye göndermek | 2,77 M çağrı; maliyet katalogla değil ürünle ölçeklenir; kural 1/3 (istek yolu değil ama gereksiz) |
| Ayrı/paralel kategori tablosu | Mevcut `category` + `category_source_map` yeterli; iki ağaç arama ve SEO'yu böler |
| Başlıktaki her marka adını marka yapmak | "for iPhone" kılıflar Apple olur; taklit ürün markalı görünür |
| Tek işlemde `UPDATE product … FROM offer` | 2,77 M satır kilidi, tek dev WAL patlaması, yayınla çakışma, yarıda kalınca hiçbir şey |
| Kategori yüzeylerini migration'la açmak | Dağıtım anında kategorisiz 2 M ürün kategori sorgularından düşerdi |
| Ürün kolonu yerine yalnız kanıt tablosu (aramada join) | Mevcut arama/sohbet/SEO `p.brand_id`/`p.category_id` okur; geniş kapsamlı değişiklik |

## Sonuçlar

- Ölçüm (yerel, 300 bin ürün, tüm ürün indeksleri, bekleme yok): 142 sn (~2.100 ürün/sn), WAL
  ~4,2 KB/ürün, `product_classification` ~125 B/ürün, ürün tablosu geçici %60 büyür (non-HOT
  güncelleme; `brand_id`/`category_id` indeksli ve başlık GIN'leri yayındakilerde). 2,77 M için
  tahmin: ~12 GB WAL (arşiv geri basıncıyla yayılır), ~330 MB kanıt tablosu, ~250 MB outbox.
  Tekrar koşu (`--rescan`) ürün yazmaz (~40 MB WAL, yalnız kontrol noktaları).
- Yeni indeks yok (`product_classification_open_idx` yalnız inceleme/hata satırlarını taşır).
- Yönetim paneli: "Markası belirlenen / bilinmeyen", "Kategorisi belirlenen / Kategorisiz",
  "Sınıflandırma bekleyen" (kontrol noktası sonrası eksikler + inceleme), "Sınıflandırma hataları".
- İnceleme kuyruğu için ileride: kaynak eşlemesini onaylama/ret ekranı ve kuyruğun toplu model
  sınıflandırması (batch, `api_usage`, çıktı saklanır). Bu PR'da model çağrısı yoktur.
- Kural değişikliği `RULE_VERSION` artırır; `tests/classify_regression.json` zorunlu regresyon setidir.
