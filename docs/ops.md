# İşletim

## Ortamlar

| Ortam | Ne çalışır | Veri |
| --- | --- | --- |
| `local` | Docker Compose: Postgres, Redis, MinIO | Örnek feed, birkaç bin ürün |
| `staging` | Üretimin küçük kopyası | Gerçek feed'lerin alt kümesi |
| `production` | Web Vercel'de, worker ayrı barındırmada | Tam katalog |

Migration'lar staging'de çalışmadan production'a gitmez.

**Worker Vercel'de çalışamaz.** Vercel uzun süren arka plan işlerini
desteklemiyor; feed toplama saatler sürebilir. Python worker için ayrı bir
barındırma gerekir (küçük bir VPS yeterli). "Başta Vercel" ilk günden iki ortam
demektir.

## Sağlayıcı bağımsızlığı

Vercel'e özgü hiçbir hizmete kilitlenilmez. Taşınabilir muadiller kullanılır:
Redis için Upstash, obje deposu için S3 uyumlu servis, veritabanı için standart
Postgres. AWS'ye geçiş bir bağlantı dizesi değişikliğine inmelidir.

## Gizli anahtarlar

- Depoya asla anahtar yazılmaz. `.env.example` yalnızca anahtar adlarını içerir.
- Üretim anahtarları barındırma sağlayıcısının gizli anahtar deposunda durur.
- Model sağlayıcı anahtarları yalnızca sunucu tarafında kullanılır, istemciye
  hiçbir koşulda gönderilmez.
- Anahtar sızarsa: iptal, yenile, `api_usage` tablosundan anormal kullanım
  kontrolü.

## Ortam değişkenleri

Sözleşmenin tek kaynağı `.env.example`; her anahtar orada dört gruptan
birindedir ve okuyan dosya yanında yazar:

| Grup | Anlamı | Anahtarlar |
| --- | --- | --- |
| `REQUIRED_PRODUCTION` | Vercel production'da tanımlı olmalı | `APP_URL`*, `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `JINA_API_KEY`, `CRON_SECRET` |
| `OPTIONAL_PRODUCTION` | Boşsa kod varsayılanı | `SMTP_SECURE`, `DATABASE_POOL_MAX`, `AUTH_TOKEN_TTL_MINUTES`, `SESSION_TTL_DAYS`, `FREE_SEARCHES_BEFORE_LOGIN`, `VISUAL_SEARCH_DAILY_LIMIT_PER_USER`, `EMBEDDING_COST_MICROS_PER_1K_TOKENS`, `MATCH_AUTO_ACCEPT_THRESHOLD`, `MATCH_QUEUE_THRESHOLD` (yalnızca Python), `HOMEPAGE_DEMO_CONTENT` |
| `DEVELOPMENT_ONLY` | Üretimde tanımlanmaz | `EMBEDDING_FAKE_CLIENT` (production'da reddedilir) |
| `TOOLING_ONLY` | Uygulama okumaz | `DATABASE_URL_OWNER` (Vercel'de **tanımlanmaz**), `APP_DB_PASSWORD`, `SEED_IMAGE_BASE_URL`; GitHub Actions secret'ları `ALERT_CRON_URL`, `CRON_SECRET`; Vercel ayarı `ENABLE_EXPERIMENTAL_COREPACK=1` |

\* `APP_URL` boşsa Vercel'in verdiği `VERCEL_PROJECT_PRODUCTION_URL`
kullanılır (`https://` eklenir). `VERCEL_ENV=production` iken sonuç https ve
localhost dışı olmak zorundadır; hiçbir değer çözülmezse hata fırlatılır —
Vercel production'da localhost canonical üretilemez. Yerel `next build` /
`next start` (VERCEL_ENV yok) `http://localhost` kabul eder. Kodda hiçbir alan
adı gömülü değildir.

`VERCEL_ENV`, `VERCEL_PROJECT_PRODUCTION_URL` ve `NODE_ENV` sistem
değişkenleridir; elle ayarlanmaz. Vercel'de `DATABASE_URL` Supabase transaction
pooler adresidir (port 6543).

## Yedekleme

**Fiyat geçmişi geriye dönük üretilemez.** Kaybedilirse savunulabilirliğin
tamamı kaybedilir. Bu yüzden yedekleme isteğe bağlı bir konu değildir.

- Günlük tam yedek, 30 gün saklama
- Sürekli WAL arşivleme (zaman noktasına dönüş)
- `price_point` partition'ları aylık olarak ayrıca soğuk depoya kopyalanır
- **Ayda bir geri dönüş testi.** Test edilmemiş yedek yedek değildir.
- Obje deposu (ürün görselleri) ayrı yedeklenir

## İzleme

| Ne | Eşik | Aksiyon |
| --- | --- | --- |
| `ingest_run` başarısızlığı | Aynı merchant 2 kez üst üste | Uyarı |
| Feed'siz geçen süre | 24 saat | Uyarı |
| Oturum başına AI maliyeti | Belirlenen üst sınır | Acil inceleme |
| Kademe 3'e düşen sorgu oranı | %20 üzeri | Sözlük genişletme işi aç |
| `match_candidate` bekleyen sayısı | 500 üzeri | Kuyruk incelemesi |
| Yanıt süresi (p95) | 1,5 sn | İnceleme |
| Hata oranı | %1 | Uyarı |
| `price_point_default` satır sayısı | 0'dan büyük | **Kritik** — aşağıdaki runbook |
| `embedding` / `generated_content` yetim satırı | 0'dan büyük | **Kritik** — aşağıdaki runbook |

Maliyet uyarısı diğerleri kadar önemlidir. `api_usage` tablosundan günlük
oturum başına maliyet raporu üretilir ve eşiği aşınca bildirim gider.

### Runbook — `price_point_default` doldu

`price_point_default` **normal durumda boştur.** Dolu olması aylık partition
üretiminin çalışmadığı anlamına gelir; satırlar orada bırakılmaz, doğru
partition'a taşınır. Kontrol: `pnpm db:partitions --check` (dolu ise sıfırdan
farklı çıkış kodu döner, izleme bunu kullanır).

Sıra önemlidir: dolu default varken o ayın partition'ı **oluşturulamaz**,
Postgres "default partition kısıtı ihlal edilirdi" hatası verir.

1. `BEGIN;`
2. `ALTER TABLE price_point DETACH PARTITION price_point_default;`
3. Eksik ayın partition'ını aç: `pnpm db:partitions`
4. Satırları geri taşı ve ayrılmış tablodan sil:
   `INSERT INTO price_point SELECT * FROM price_point_default;`
   `DELETE FROM price_point_default;`
5. `ALTER TABLE price_point ATTACH PARTITION price_point_default DEFAULT;`
6. `COMMIT;`

Sonra cron'un neden çalışmadığını bul. Fiyat geçmişi geriye dönük
üretilemez — bu uyarı ertelenmez.

### Runbook — yetim `embedding` / `generated_content` satırı

Bu iki tabloda `target_id` bir foreign key **değildir**: `target_type`'a göre
`offer`, `product` ya da `query` gösterir, bir kolon üç tabloya birden
referans veremez. Yani referans bütünlüğünü Postgres sağlamıyor.

Migration `0014` **silme** yönünü trigger'a bağladı: `offer` veya `product`
satırı silindiğinde ya da tablo `TRUNCATE` edildiğinde bağlı satırlar
temizlenir. Geriye üç yol kalıyor ve bu uyarı onları ölçüyor:

1. **Yazma yönü** — var olmayan bir `target_id` ile INSERT.
2. `ALTER TABLE ... DISABLE TRIGGER` veya `session_replication_role = replica`.
3. `generated_content.target_type` **serbest TEXT**'tir (`embedding`'in aksine
   CHECK kısıtı yok): `'ofer'` yazımı hem trigger'dan hem de naif bir yetim
   sorgusundan kaçar.

Kontrol: `pnpm db:orphans --check` (yetim varsa sıfırdan farklı çıkış kodu
döner, izleme bunu kullanır). `pnpm db:verify` de aynı sorguyu koşar.

1. `pnpm db:orphans` — kaç satır, hangi tabloda, hangi `target_type`.
2. **Satırlar silinir, bırakılmaz.** `price_point_default`'ta satırların
   taşınacağı doğru bir partition vardı; burada taşınacak yer yok — satırın
   işaret ettiği hedef artık mevcut değil.
   `DELETE FROM embedding WHERE target_type = 'offer' AND NOT EXISTS
   (SELECT 1 FROM offer o WHERE o.id = target_id);`
3. Trigger'lar yerinde ve etkin mi:
   `SELECT tgname, tgenabled FROM pg_trigger WHERE tgname LIKE '%_polymorphic_%';`
   `tgenabled` **`O`** olmalı; `D` ise devre dışıdır ve sebebi bulunur.
4. Trigger'lar etkinse arıza **yazma** yönündedir: son `enrich` ya da
   `similarity` koşusunda hangi kodun var olmayan bir `target_id` yazdığını
   bul. `tanimsiz_tur` raporlanıyorsa `target_type` yazımı bozuk demektir.

`target_type = 'query'` yetim **sayılmaz**: şema kullanıcı sorgusu
embedding'ine izin veriyor, karşılık gelen bir tablo yok.

`price_point` uyarısı gibi ertelenmez ve daha sinsidir: kimlikler yeniden
kullanıldığında yetim vektör sessizce **yanlış ürüne** bağlanır. Eksik veri
değil, yanlış veri üretir — B3'te tam olarak bu oldu.

## Hata takibi

Sunucu ve istemci hataları tek bir hata takip servisinde toplanır. Kişisel veri
hata kayıtlarına yazılmaz — özellikle giriş bağlantısı token'ları ve e-posta
adresleri maskelenir.

## Oran sınırlama ve kazımaya karşı koruma

Siz feed'lerden veri topluyorsunuz; rakip de sizden toplamaya çalışacak.

- Görsel arama: kullanıcı ve IP başına günlük limit. Hem maliyet hem kötüye
  kullanım koruması.
- Ürün API'si: oturum başına oran sınırı
- Fiyat geçmişi: tam seri hiçbir genel uçtan dışarı verilmez, yalnızca
  grafikte gösterilecek örneklenmiş hali döner
- Sıradışı gezinme örüntüsü tespitinde yavaşlatma
- `robots.txt` ve arama motoru botları için ayrı kural

## Bootstrap kataloğu (geçici, yalnızca yerel)

`docs/decisions/0027`. Admitad öncesi test kataloğu; Shopify `/products.json`
üzerinden, **yalnızca yerel veritabanına**. `collect.bootstrap` localhost
dışındaki bir `DATABASE_URL`'e yazmayı reddeder.

```bash
cd services/ingest
.venv/Scripts/python -m collect.bootstrap --manifest bootstrap/shopify_merchants.json --report rapor.json
.venv/Scripts/python -m resolve --limit 5000        # offer -> product
.venv/Scripts/python -m similarity --prices          # product özetleri + fiyat istatistikleri
.venv/Scripts/python -m enrich --kind image --limit 50   # JINA_API_KEY gerekir; küçük parti
.venv/Scripts/python -m similarity --edges
```

Rapor dosyası kaynak başına başlangıç, keşfedilen kayıt, yeni/güncellenen
offer, reddedilen kayıt, hata ve süreyi içerir. Tekrar çalıştırmak
idempotenttir (`(merchant_id, external_id)` upsert).

**Para birimi (0029).** Kayıtlar yalnızca `feed_config.currency_verified =
true` ise yazılır. Kanıt manifestin yanındaki `currency_provenance.json`
dosyasından okunur; dosyada olmayan mağaza reddedilir. Mağaza çekmeden yalnızca
merchant ayarını güncellemek: `--register-only`.

**Çakışma corpus'u (0029).** `bootstrap/overlap_merchants.json`: eşleştirmenin
doğru-pozitif tarafını ölçmek için 3 mağaza. Ölçüm: `python -m resolve.overlap_eval`.

**Tohum verisinden ayırma.** Geliştirme tohumu (`pnpm seed`) yalnızca yerel
veritabanına yazar. Merchant'ları `.example` alan adlıdır (RFC 2606, gerçek
mağaza olamaz). Bootstrap QA sırasında aramayı kirletmesin diye yerelde:
`UPDATE merchant SET is_active = FALSE WHERE domain LIKE '%.example';`
(geri almak: `TRUE`). Metin arama ölçümü (`node packages/core/scripts/search-eval.ts`)
kapsamı zaten bootstrap merchant'larıyla sınırlar.

**Nasıl ayırt edilir.** Şema değişmedi; işaret merchant üzerindedir:

```sql
-- bootstrap merchant'lari
SELECT id, slug, domain FROM merchant
 WHERE feed_config->>'bootstrap_source' = 'bootstrap_shopify';
-- bootstrap offer'lari
SELECT o.* FROM offer o JOIN merchant m ON m.id = o.merchant_id
 WHERE m.feed_config->>'bootstrap_source' = 'bootstrap_shopify';
-- YALNIZCA bootstrap offer'larina bagli urunler (baska kaynaktan offer'i
-- olan urun bootstrap sayilmaz)
SELECT p.id FROM product p
 WHERE EXISTS (SELECT 1 FROM offer o JOIN merchant m ON m.id = o.merchant_id
                WHERE o.product_id = p.id
                  AND m.feed_config->>'bootstrap_source' = 'bootstrap_shopify')
   AND NOT EXISTS (SELECT 1 FROM offer o JOIN merchant m ON m.id = o.merchant_id
                    WHERE o.product_id = p.id
                      AND m.feed_config->>'bootstrap_source' IS DISTINCT FROM 'bootstrap_shopify');
```

**Temizlik — hiçbir betik bunu otomatik çalıştırmaz.** İki yol:

1. **Yumuşak emeklilik (her ortamda geçerli).** `price_point` ve `click`
   append-only olduğu için (CLAUDE.md kural 4 ve 8) önce bu tercih edilir:
   `UPDATE merchant SET is_active = FALSE` ve bu merchant'ların offer'larında
   `is_active = FALSE`; ardından `public_find` / `discovery_slot` satırlarından
   bootstrap ürünleri çıkarılır ve `python -m similarity --prices` özetleri
   sıfırlar. Arama `m.is_active` ile zaten dışarıda bırakır.
2. **Tam silme (yalnızca hiçbir yere taşınmamış yerel veritabanı).** En temizi
   yerel veritabanını sıfırlamaktır: `docker compose -f infra/docker-compose.yml
   down -v`, ardından `pnpm db:migrate`, `pnpm db:bootstrap-role`, `pnpm seed`.
   Satır satır silmek gerekirse sahip rolüyle, tek transaction'da, şu sırayla
   (yukarıdaki kimlik sorgularıyla daraltılarak): `similarity_edge`,
   `product_price_stats`, `match_candidate`, `public_find`, `discovery_slot`,
   `click`, `product_view`, `saved_item`, `collection_item`, `alert`,
   `product_slug_history`, `price_point`, `offer` (varyant ve stok olayları
   cascade), `product`, `ingest_run`, `merchant`. `embedding` satırları
   `0014` trigger'ı ile düşer; sonra `pnpm db:orphans --check`.

## Dağıtım

- `main` dalına birleşme staging'e otomatik gider
- Production dağıtımı elle onaylanır
- Migration'lar geriye uyumlu yazılır: önce kolon eklenir, kod dağıtılır, sonra
  eski kolon kaldırılır. Tek adımda kolon silen migration reddedilir.
- Geri alma planı her dağıtımda hazır olur

## Olay yönetimi

Üretim kesintisinde: önce durumu kaydet, sonra düzelt, sonra `docs/decisions/`
altına ne olduğunu ve neyin değiştiğini yaz. Aynı hatanın ikinci kez olması
belge eksikliğidir.

## Maliyet takibi

Aylık gider kalemleri tek bir tabloda takip edilir: barındırma, veritabanı,
obje deposu, model çağrıları, e-posta, alan adı. Bu tablo proje belgesindeki
birim ekonomisi hesabını besler ve boş bırakılmaz.
