# 0182 — Kendi çıkarım servisi sözleşmesi, kip yetenekleri ve etkinleştirme kapısı

Durum: **kabul**. Migration yok. İlgili: 0015, 0155, 0174, 0177, 0180, 0181.
`Depends on #311` (0180/0181).

## Bağlam

- 0180, metin için ortak bir sağlayıcı sözleşmesi getirdi. Bugün iki uygulaması var: Jina API ve
  yerel ONNX. Kendi işlettiğimiz bir çıkarım servisi için (aynı KVM 8'de ayrı konteyner, ileride
  Processing VPS ya da GPU) henüz bir uygulama yoktu; yalnızca bir yorum satırı vardı.
- Kayıt defteri `modalities` alanını tutuyordu, ancak sağlayıcının o kipi gerçekten gömüp
  gömemediği denetlenmiyordu. Görsel için bir sözleşme tipi de yoktu.
- **Açık:** `enrich.index activate`, TS'nin sorgu vektörü üretemediği bir modeli de (örneğin
  yalnızca Python'da çalışan e5) `active` yapabiliyordu. Sonuç: TS `unsupported_model` döner,
  anlamsal arama **sessizce** kapanır.
- BGE-M3 ve Qwen3-Embedding-0.6B'nin ikisi de 1024 boyutludur. Aynı boyut aynı vektör uzayı
  demek değildir.

## Karar

### 1. `remote_http` sağlayıcısı (`RemoteHttpTextProvider`)

- **Sözleşme:** OpenAI uyumlu `POST /v1/embeddings`. TEI, Infinity ve vLLM bunu sunar; CPU ve
  GPU arasında geçiş yalnızca adres değişikliğidir.
- **Bağımlılık:** Model dosyası, torch ve çalışma zamanı yalnızca o serviste bulunur. Ingest ve
  web imajına bağımlılık eklenmez.
- **Yapılandırma:** Kayıt defterinde `endpoint = {url_env, served_model}` tutulur. Adresin
  kendisi tutulmaz, yalnızca ortam değişkeninin adı (`EMBED_<AD>_URL`) yazılır. İsteğe bağlı
  anahtar `EMBED_<AD>_TOKEN`'dan okunur.
- **Adres kuralları:**
  - Düz HTTP yalnızca yerel ya da özel ağa izinlidir: Docker servis adı, loopback, RFC1918.
  - Diğer adresler HTTPS olmalıdır.
  - URL'de kimlik bilgisi, sorgu ya da parça bulunamaz.
- **Zaman aşımı ve tekrar:**
  - Bağlantı zaman aşımı 5 sn, okuma 60 sn.
  - En fazla 4 deneme. Denemeler arası bekleme 30 sn ile sınırlıdır (`Retry-After` da kırpılır).
  - Tekrar yalnızca 429, 5xx ve ağ hatasında yapılır.
  - Diğer 4xx yanıtlar kalıcıdır (`EmbeddingRejected`); yanıt gövdesi hata mesajına girmez.
- **Eşzamanlılık:** Örnek başına tek istek gider; parti en fazla 128 öğedir. Canlı sorgu ve
  toplu iş ayrı örneklerle, ayrı havuzlarda çalışır.
- **Uzay koruması:**
  - Yanıttaki `model` alanı `served_model`'den farklıysa parti reddedilir.
  - Sayı, boyut, sonlu değer ve norm kapısı (`validate_batch`) 0180'deki gibi uygulanır.
  - Bozuk parti yazılmaz.

### 2. Kip yetenekleri

- `PROVIDER_MODALITIES` hangi sağlayıcının hangi kipi gömebileceğini tanımlar:
  - jina: metin ve görsel
  - local_onnx: metin
  - remote_http: metin
- Kayıt defteri, sağlayıcının desteklemediği bir kipi bildiren modeli reddeder.
- `ImageEmbeddingProvider` görsel sözleşmesidir; `build_image_provider` yalnızca görsel yeteneği
  olan modeli kurar.
- `ModelSpec.same_space()` yalnızca aynı model kimliğini karşılaştırılabilir sayar. Aynı boyut
  yeterli değildir.

### 3. `online_query` (zorunlu alan) ve etkinleştirme kapısı

- `online_query: true`, canlı istek yolunun o modelle sorgu vektörü üretebildiği anlamına gelir.
  Bugün bu yalnızca TS'deki Jina modelleri için geçerlidir.
- `activate`, `online_query=false` olan modeli reddeder.
- TS parite testi, `online_query=true` olan ürün metni modellerinin kümesini
  `QUERYABLE_INDEXES` ile birebir eşler.

### 4. Aday modeller (hepsi `disabled`, tablosuz aile, üretimde seçilemez)

- `qwen3-embedding-0.6b-97b0c614` (`remote_http`):
  - Apache-2.0, revizyon `97b0c614…`, 1024 boyut.
  - Sorgu tarafı resmî `Instruct: …\nQuery:` biçimini kullanır.
  - Resmî ONNX yoktur; CPU'da TEI/Infinity konteyneriyle sunulur.
- `bge-m3`:
  - Revizyon `5617a9f6…` ile sabitlendi.
  - Resmî ONNX dosyası depoda var; 0180'deki "ONNX yapısı yok" notu düzeltildi.
  - **Dikkat:** BGE-M3'ün yoğun (dense) vektörü CLS havuzlamasıdır. 0155'teki `OnnxEmbedder` e5
  için ortalama havuzlama yapar. Model doğrudan bağlanırsa vektör yanlış olur ama norm kapısı
  bunu yakalamaz. Bu yüzden BGE-M3 ya `remote_http` (TEI) ile sunulmalı ya da havuzlama
  parametresi ayrı bir PR'da eklenip referans vektörle test edilmelidir.
- `license_verified` alanları `false` kalır. Lisans resmî kartla doğrulandı, ancak bu bayrak
  insan/hukuk onayını temsil eder.

## Reddedilen

- **Her sağlayıcı için ayrı istemci (TEI'ye özel, vLLM'e özel):** Ortak OpenAI biçimi yeterli,
  soyutlama gereksiz.
- **Adresi kayıt defterine yazmak:** Ortama göre değişir ve gizli olabilir; yalnızca ortam
  değişkeninin adı tutulur.
- **TS'de yerel model çalıştırmak:** İstek yolunda yeni model bağımlılığı demektir. Canlı sorgu
  için `remote_http` istemcisi TS'ye ancak ayrı bir karar ve CLAUDE.md kural 1 güncellemesiyle
  eklenir.

## Sonraki adım

- E2: tek KVM 8 üzerinde `embed-cpu` konteyneri (TEI) için compose profili. Varsayılan kapalı.
  CPU/RAM limitleri ve `pilot` ölçümü (`enrich.pilot --provider remote`) bu adımda gelir.
  1024 ailesi için migration (`product_text_embedding_d1024`) yalnızca pilot kazanırsa yazılır.
