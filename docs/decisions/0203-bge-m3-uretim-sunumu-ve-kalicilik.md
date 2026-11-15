# 0203 — BGE-M3 üretim sunumu: servis, kalıcılık ve kayıt defteri tutarsızlığı

Tarih: 15 Kasım 2026. Bağlı: 0195 (depolama/aktarım), 0196 (sorgu servisi ve sunum), 0190 (sunum kapıları).

## Karar

BGE-M3 üretimde canlıya alındı (kullanıcı onayıyla):

1. 160.017 vektör `product_text_embedding_d1024`'te; kısmi HNSW (`ef_construction=200`, 394 MiB, migration 0115) geçerli.
2. Sorgu vektörünü ayrı bir TEI üretir: `infra/compose.embed-query.yml` (proje `arilla-embed-query`, ağ
   `arilla_data`, `restart: unless-stopped`, 4 GiB tavan, ölçülen ~2,8 GiB). Model kalıcı diskte
   `/opt/arilla/models/bge-m3-5617a9f6`; SHA-256 `derived-manifest.json` ile doğrulandı.
3. Web ortamında `EMBED_BGE_M3_QUERY_URL`, `SEMANTIC_EMBEDDING_MODEL=bge-m3-5617a9f6`,
   `SEMANTIC_INDEX_VERSION=1`, `SEMANTIC_SEARCH_MODE=on`. Kanarya üretim TEI'sine karşı min kosinüs 0,999981.
4. Eski toplu iş TEI'si (`e4-bge-tei`) durduruldu (≈2,4 GiB RAM kazanıldı); checkpoint ve modeller korunur.

## Kalıcılık (neden deploy hattının dışında)

Servis `compose.prod.yml`'ye girmez: ayrı proje adı sayesinde `arilla` deploy'u (`up -d`, orphan temizliği,
rollback) ona dokunmaz, `restart: unless-stopped` yeniden başlatmada kaldırır. Deploy servisi bozamaz, ama
**kurmaz da**: dosya VPS'e elle kopyalanır; yeni sunucuda model dizini + servis + `web.env` satırları ops.md
"BGE-M3 sorgu servisi — üretim kurulumu"na göre elle kurulur. `web.env` depoda yoktur ve deploy'da değişmez.

## Tutarsızlık: registry `disabled`, sunum `on`

`model_registry.json` (`state=disabled`, `license_verified=false`) yalnız Python tarafında (`registry.py`,
`enrich.index`) üretim işlerini ve `activate`'i kapılar. TS sunumu `QUERYABLE_INDEXES` + ortam değişkenlerine
bakar; `SEMANTIC_EMBEDDING_MODEL` `embedding_index` aktif satırından önceliklidir. Sonuç: registry onayı
olmadan env ile açılabilir (0196'nın "kayıt defterinde disabled kaldıkça kendiliğinden açılmaz" iddiası,
env'i elle ayarlayan kişi için geçerli değildir). `embedding_index` aktif satırı Jina olarak kaldı.
Bu PR registry'yi DEĞİŞTİRMEZ (insan/hukuk onayı: lisans MIT, doğrulama kaydı bekliyor). Önerilen kapanış:
onay verilince `license_verified=true` + `state` güncellemesi ve `enrich.index register/activate`; TS tarafına
registry durumunu okuyan bir kapı eklemek ayrı karardır.

## Bilinen sınırlar

- Kapsama %1,2 (160.017 / 13,3 M ürün); kalite kazancı AI etiketli ölçümdür (0196).
- Servis tek örnek; düşerse arama metin sonucuna birebir döner.
- Üretimde ilk gerçek `/sohbet` sorgusu doğrulaması ayrıca yapılır (kullanıcı hesabıyla, log/metrikten).

## Reddedilen

- Servisi `compose.prod.yml`'ye eklemek: 2,8 GiB'lik kalıcı servis her deploy'un `up -d` döngüsüne girer;
  ayrı proje daha az riskli.
- Registry'yi onaysız değiştirmek.
