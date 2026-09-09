# 0015 — Embedding sağlayıcısı: barındırılan çok-kipli API (Jina CLIP v2)

**Tarih:** 2026-09 · **Durum:** kabul edildi

## Karar

Embedding'ler **barındırılan bir çok-kipli API'den** alınır: **Jina CLIP v2**.

- Metin ve görsel **aynı vektör uzayına** yazılır; bir metin sorgusu ürün
  görseline, yüklenen bir fotoğraf ürün metnine karşılık gelebilir.
- Çıktı Matryoshka ile **768 boyuta** kırpılır — `embedding.vector`
  şemadaki `vector(768)` taahhüdüne uyar.
- **Kendi modelimizi barındırmıyoruz.** `infra/docker-compose.yml`'e GPU
  servisi girmez.
- `embedding.model_version` her satırda `jina-clip-v2` taşır.

## Gerekçe

**Neden barındırılan API.** Katalog büyüklüğü henüz kendi GPU'muzu
çalıştırmayı haklı çıkarmıyor. Barındırılan API'de başlangıç sabit maliyeti
sıfıra yakın: kullandığın kadar ödersin, kimse bir kartı boşta beklemez.
`CLAUDE.md` 3. kural gereği her AI çıktısı bir kez üretilip saklandığı için
maliyet katalog büyüklüğüyle ölçekleniyor, kullanıcı sayısıyla değil — yani
erken aşamada gider küçük, ve büyüdüğünde kendi barındırmaya geçmek
ölçülebilir bir karar olarak önümüze gelir.

**Neden çok-kipli, neden OpenAI değil.** Faz 0'ın ilk kararı "barındırılan
API, OpenAI" idi. Doğrulamada çıktı ki **OpenAI'nin embedding API'si görsel
kabul etmiyor**: `text-embedding-3-small` ve `-large` belgelerinde görsel kipi
"not supported" olarak işaretli, ayrı bir görsel embedding uç noktası da yok.
Görsel arama bu üründe isteğe bağlı bir özellik değil — ürün tanımının ilk
cümlesi "kullanıcı **fotoğraf**, ürün linki veya doğal dil ile arar", şemada
`embedding.kind IN ('image','text')` var, `similarity_edge`'de `visual` türü
var ve D4 MVP-0'da. Metin-only bir sağlayıcı ürünü karşılamıyor, o yüzden
karar yeniden açıldı.

**Neden tek sağlayıcı, iki değil.** Metni bir sağlayıcıdan, görseli
başkasından almak iki ayrı vektör uzayı demek; o iki uzay **asla
karşılaştırılamaz**. Şema bunu teknik olarak kaldırırdı (`model_version` satır
başına, `similarity_edge` zaten `visual` ve `semantic`i ayırıyor) ama metin
sorgusuyla görsel eşleştirme imkânı kaybolurdu. Tek çok-kipli uzay bu
yeteneği bedavaya veriyor.

**Neden Jina.** Beş aday karşılaştırıldı. Belirleyici olan KVKK oldu:
`docs/kvkk.md` altyapının tamamının yurt dışında olmasını açık bir risk kalemi
sayıyor, ve `0009` font kararı kullanıcı IP'sini yurt dışına taşımamak için
CDN'i reddetmişti. **Jina AI GmbH Berlin merkezli bir AB tüzel kişisi** — bu
çizgiyle tutarlı tek aday. Yanında: adaylar arasında yayımlanmış tek somut çok
dillilik verisi (89 dil) ve `vector(768)`'e uyan tek boyut kümesi.

## Reddedilen alternatifler

| Aday | Ret sebebi |
| --- | --- |
| **OpenAI** | Embedding API'si **görsel kabul etmiyor**. İlk karardı, doğrulamada düştü. |
| **Kendi barındırdığımız CLIP/SigLIP** | Bugünkü katalog GPU maliyetini haklı çıkarmıyor. Aşağıdaki eşikte yeniden değerlendirilir. |
| **Cohere Embed v4** | Kıyaslamada en güçlüsü, AB bölgesi mevcut — ama boyutları 256/512/1024/1536, **768 yok** (migration gerekirdi) ve v4 için dil sayısı yayımlanmamış. |
| **Google `multimodalembedding@001`** | En güçlü bölge sabitleme (`europe-west1/4`), görsel+metin aynı uzay resmî belgede doğrulandı — ama boyutlar 128/256/512/1408, **768 yok**; Türkçe verisi yayımlanmamış. |
| **Voyage multimodal-3.5** | Açık ara en ucuzu (görsel başı $0.00003–$0.0012, ciddi ücretsiz kota) — ama **AB veri ikametgahı için belgelenmiş bir taahhüt bulunamadı**. |
| **AWS Titan MM G1** | Belgesi açıkça "Languages: English". Türkçe arayüzlü bir ürün için yeter şart bile değil. |

## Kendi barındırmaya dönüş eşiği

Bu karar kalıcı değil. Şunlardan biri gerçekleşirse yeniden açılır:

- Aylık embedding gideri, eşdeğer bir GPU kirasının maliyetini geçtiğinde;
- Katalog **100 bin ürünü** aştığında (yeniden üretim maliyeti tek seferlik
  olmaktan çıkar);
- Sağlayıcı gecikmesi görsel aramanın 3 saniyelik hedefini tehdit ettiğinde.

Ölçüm yeri belli: `api_usage` tablosu (`CLAUDE.md` 9. kural) her çağrıyı
`cost_micros` ile yazıyor.

## Sonucu

- `embedding.vector` **değişmiyor**: `vector(768)`. Migration yok.
- Katalog tarafı üretim `services/ingest/enrich` altında Python toplu işi
  olarak kalır — ama yerel model çalıştırmaz, API'ye çağrı yapar.
- Kullanıcının yüklediği görselin embedding'i TypeScript istek yolunda,
  `EmbeddingService` arkasından, görsel hash'i ile cache'lenerek üretilir.
  `CLAUDE.md` 1. kuralın tek istisnası budur.
- Python ve TypeScript **birbirini çağırmaz**; ikisi de aynı dış API'yi ayrı
  ayrı çağırır. Aralarındaki kanal hâlâ yalnızca PostgreSQL ve Redis.
- Her iki çağrı da `api_usage`'a yazar.

## Kod yazılmadan önce kapatılacak iki açık nokta

1. **Ticari kullanım koşulları.** `jina-embeddings-v4` ağırlıkları Qwen
   Research License altında (ticari kullanım kapalı). Bu, **ağırlıkları kendi
   sunucumuzda çalıştırmayı** kısıtlar; ücretli API'yi kullanmak ayrı bir
   şeydir. Yine de abonelik öncesi sözleşme okunacak.
2. **Gerçek görsel maliyeti.** "600×600 ≈ 16.000 token" rakamı ikincil
   kaynaktan alındı, sağlayıcının kendi sayfasından doğrulanmadı. B3'te 200
   tohum ürünle ölçülüp `api_usage`'dan raporlanacak; 100 bin ürünlük
   projeksiyon o ölçüme dayanacak.
