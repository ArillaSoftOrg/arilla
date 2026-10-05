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
- Özel anahtar dosyaları (Apple `.p8`, `.pem`, `.p12`, SSH anahtarı) depo
  klasöründe TUTULMAZ; depo dışında (ör. `~/.secrets/`) durur, değer ortam
  değişkenine yapıştırılır. `.gitignore` bu adları yok sayar ve
  `pnpm check:secrets` (CI: `security-checks`) izlenen ya da sahnelenmiş bir
  anahtar dosyası/PEM başlığı görürse başarısız olur (karar 0050). Anahtar bir
  kez bile commit'lenip push'landıysa geçmişten silmek yetmez: döndürülür.

## Ortam değişkenleri

Sözleşmenin tek kaynağı `.env.example`; her anahtar orada dört gruptan
birindedir ve okuyan dosya yanında yazar:

| Grup | Anlamı | Anahtarlar |
| --- | --- | --- |
| `REQUIRED_PRODUCTION` | Vercel production'da tanımlı olmalı | `APP_URL`*, `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `JINA_API_KEY`, `CRON_SECRET` |
| `OPTIONAL_PRODUCTION` | Boşsa kod varsayılanı | `SMTP_SECURE`, `DATABASE_POOL_MAX`, `AUTH_TOKEN_TTL_MINUTES`, `SESSION_TTL_DAYS`, `FREE_SEARCHES_BEFORE_LOGIN`, `AI_SEARCH_DAILY_LIMIT`, `EMBEDDING_COST_MICROS_PER_1K_TOKENS`, `MATCH_AUTO_ACCEPT_THRESHOLD`, `MATCH_QUEUE_THRESHOLD` (yalnızca Python), `HOMEPAGE_DEMO_CONTENT`, `MARKETING_EMAIL_FROM` (pazarlama gönderimi için üretimde zorunlu), `MARKETING_EMAIL_ENABLED`, `MARKETING_EMAIL_REPLY_TO`, `MARKETING_EMAIL_BATCH_SIZE`, `MARKETING_EMAIL_SEND_INTERVAL_MS`, `MARKETING_EMAIL_TIME_BUDGET_MS`, `MARKETING_EMAIL_MAX_ATTEMPTS` (karar 0048) |
| `DEVELOPMENT_ONLY` | Üretimde tanımlanmaz | `EMBEDDING_FAKE_CLIENT` (production'da reddedilir) |
| `TOOLING_ONLY` | Uygulama okumaz | `DATABASE_URL_OWNER` (Vercel'de **tanımlanmaz**), `APP_DB_PASSWORD`, `SEED_IMAGE_BASE_URL`; GitHub Actions secret'ları `ALERT_CRON_URL`, `MARKETING_CRON_URL`, `CRON_SECRET`; Vercel ayarı `ENABLE_EXPERIMENTAL_COREPACK=1` |

\* `APP_URL` boşsa Vercel'in verdiği `VERCEL_PROJECT_PRODUCTION_URL`
kullanılır (`https://` eklenir). `VERCEL_ENV=production` iken sonuç https ve
localhost dışı olmak zorundadır; hiçbir değer çözülmezse hata fırlatılır —
Vercel production'da localhost canonical üretilemez. Yerel `next build` /
`next start` (VERCEL_ENV yok) `http://localhost` kabul eder. Kodda hiçbir alan
adı gömülü değildir.

`VERCEL_ENV`, `VERCEL_PROJECT_PRODUCTION_URL` ve `NODE_ENV` sistem
değişkenleridir; elle ayarlanmaz. Vercel'de `DATABASE_URL` Supabase transaction
pooler adresidir (port 6543).

## Veritabanı erişim yüzeyi (Supabase)

Supabase yalnızca Postgres barındırıyor. **Supabase Auth, Data API
(PostgREST), Realtime ve Storage kullanılmıyor.** Uygulama veritabanına
yalnızca sunucudan, `arilla_app` rolüyle bağlanır. Yetki
`requireCapability` ve `assertCapability` ile uygulanır; RLS bu modelin
parçası değildir (0049).

Risk şurada: Supabase projesinde Data API açıksa, `public` şemadaki
tablolar `anon` ve `authenticated` rolleriyle HTTP üzerinden erişilebilir
olabilir. Bunu engelleyen RLS de yoktur. Her ortam için bir kez kontrol
edilir; şema veya Supabase ayarı değişince tekrarlanır.

1. **Panel:** Project Settings → Data API. Data API kapalı olmalı ya da
   açık şemalar listesinde `public` bulunmamalı.
2. **Yetki sorgusu** (salt okunur, sahip rolüyle):
   ```sql
   SELECT grantee, table_name, privilege_type
     FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND grantee IN ('anon', 'authenticated');
   ```
   Sonuç boş olmalı. **0042 (karar 0057) ile bu adım migration'a taşındı:**
   `pnpm db:migrate` yetkileri geri alır ve migration rolünün varsayılan
   yetkilerini kapatır; roller olmayan yerel/CI veritabanlarında hiçbir şey
   yapmaz. Aşağıdaki SQL yalnızca referanstır (migration'ın eşdeğeri):
   ```sql
   REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
   REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
   REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE ALL ON TABLES FROM anon, authenticated;
   ```
   Yapılan işlem tarihiyle bu bölüme not edilir.
3. **İstemciye sızma kontrolü:** `NEXT_PUBLIC_` önekli hiçbir değişken
   veritabanı adresi, Supabase anahtarı (`anon` / `service_role`) ya da
   başka bir gizli değer taşımaz. Kod tabanında Supabase istemci
   kütüphanesi ve service role anahtarı yoktur; yeni bir bağımlılık bunu
   değiştiriyorsa önce karar dosyası yazılır.

Son kontrol:
- **Kod tarafı (madde 3, 2026-10-03):** `@supabase/*` bağımlılığı yok,
  `service_role` anahtarı yok, `NEXT_PUBLIC_` önekli değişken yok; veritabanı
  adresi yalnızca sunucu kodunda okunuyor.
- **Panel ve yetki sorgusu (1-2, 2026-10-03):** Data API production'da
  **açık** ve `public` şemasını sunuyordu; 58 tablonun hepsinde `anon` /
  `authenticated` tam yetkiliydi (publishable anahtarla `/rest/v1/feedback`
  200 döndü). 0042 production'a uygulandı; yetki sorgusu boş, aynı probe
  yetki reddi döner. Data API açık kalır (kullanılmıyor, erişimi yok).
- **Kalan:** `supabase_admin`'in `public` için varsayılan yetkileri hâlâ
  `anon`/`authenticated`'e verir; `postgres` bu role üye olmadığı için
  migration düzeltemez. Bu yalnızca panelden eklenti/obje oluşturulursa
  etkilidir — panelden `public`'e obje eklendiyse yetki sorgusu (madde 2)
  tekrar çalıştırılır. `service_role` yetkileri bilerek korunur (gizli
  anahtar, kodda yok).

## Kullanıcı aktivitesi migration'ları (0036, 0037) — production

Karar 0049. İkisi de yalnızca ekleme yapar (yeni tablo, nullable kolon,
CHECK genişletme, indeks) ve mevcut satırları yeniden yazmaz. Backfill
yoktur: eski hesaplar için özet satırı ilk olayda açılır.

1. Production'ın migration seviyesini doğrula:
   `SELECT filename FROM schema_migration ORDER BY filename DESC LIMIT 5;`
   0034 ve 0035 uygulanmış olmalı. Değilse önce onlar.
2. Önce staging'de: `pnpm db:migrate && pnpm db:verify`. `db:verify`
   `auth_event`/`user_activity_event` UPDATE'inin engellendiğini ve
   `query_norm` güncellemesinin izinli olduğunu sınar.
3. Production'da aynı iki komut, onaylı bir pencerede. Tablolar küçük;
   0036'nın `app_user_created_idx` indeksi tablo büyükse önce elle
   `CREATE INDEX CONCURRENTLY` ile açılır (migration `IF NOT EXISTS` ile
   boş geçer, 0030 deseni).
4. Kod dağıtımı migration'dan **sonra** yapılır: yeni kod yeni tablolara
   yazar.
5. Geri alma: kod geri alınır. Yeni tablolar boşta kalır, eski kod onları
   okumaz. DROP gerekiyorsa ayrı bir migration ile yapılır (CLAUDE.md
   kural 14).

**Yerel test uyarısı:** kök `.env` uzak veritabanını gösterebilir.
Entegrasyon testleri, `db:migrate`, `db:verify` ve `seed` komutları
`DATABASE_URL` ve `DATABASE_URL_OWNER` açıkça yerel Docker Postgres'e
verilerek çalıştırılır. Testler arasında yerel Redis'teki `ratelimit:*`
anahtarları birikirse giriş testleri oran sınırına takılır; yalnızca yerel
Redis'te temizlenir.

## Yedekleme

**Fiyat geçmişi geriye dönük üretilemez.** Kaybedilirse savunulabilirliğin
tamamı kaybedilir. Bu yüzden yedekleme isteğe bağlı bir konu değildir.

- Günlük tam yedek, 30 gün saklama
- Sürekli WAL arşivleme (zaman noktasına dönüş)
- `price_point` partition'ları aylık olarak ayrıca soğuk depoya kopyalanır
- **Ayda bir geri dönüş testi.** Test edilmemiş yedek yedek değildir.
- Obje deposu (ürün görselleri) ayrı yedeklenir

## İzleme

Veritabanından okunabilen eşikler `/yonetim/islemler` ekranındadır (yalnızca
yönetici; docs/decisions/0041). Harici uyarı üretmez; ekran bakıldığında
durumu gösterir.

`/yonetim/islemler` (Sistem sağlığı) her denetimi bir bulgu olarak gösterir:
önem (kritik / uyarı / bilinmiyor / bilgi / sağlıklı), kanıt zamanı, anlamı,
ne yapılacağı ve teşhis sayfası (karar 0055). Denetim çalışmazsa durum
"Bilinmiyor"dur, sağlıklı sayılmaz. Genel bakıştaki "Şimdi dikkat
isteyenler" aynı bulguların kritik/uyarı/bilinmiyor olanlarıdır (moderatör
yalnızca mağaza, boru hattı ve eşleştirme kuyruğu bulgularını görür).

İş koşuları `job_run`'a yazılır (karar 0052/0055) ve `/yonetim/islemler/isler`
sayfasında listelenir: Python işleri (`collect`, `collect_bootstrap`,
`resolve`, `enrich`, `similarity*`, `link_refresh`; dry-run ve sahte istemci
yazmaz) ve cron uçları (`discovery_slots`, `cleanup_auth`, `trigger_alerts`,
`marketing_campaigns`). 2 saatten uzun "sürüyor" kalan koşu takılıdır (süreç
öldü); günlük cron 30 saat, 15 dakikalık cron 2 saat koşu bırakmazsa
"zamanında çalışmadı" uyarısı çıkar. Koşular 180 gün saklanır
(`cleanup-auth` içinde silinir). Çalıştır/yeniden dene düğmesi yoktur.

"Veri boru hattı" bölümü her aşamanın (toplama, eşleştirme, fiyat özeti,
zenginleştirme, benzerlik kenarları, link çözümleme) durumunu ve elle
çalıştırma komutunu gösterir. Aşamanın iş koşusu varsa "son çalıştı" oradan,
yoksa üretilen verinin zamanından ("son kanıt", karar 0051) okunur. Aşamalar
zamanlanmış değil; "geride olabilir" (bilgi) görünen aşama sırayla
çalıştırılır.

Başarısız toplama koşusu (`ingest_run.status = 'failed'`) işlemi geri alır;
0055'ten beri kayıt da oluşturulan/güncellenen/fiyat noktası sayılarını 0
yazar, geri alınan miktar `error_text`'te not olarak durur.

Model maliyeti `api_usage.cost_micros`'tan okunur ve oran
(`EMBEDDING_COST_MICROS_PER_1K_TOKENS`) tanımsızken 0 yazılır. Ekran bu
çağrıları "fiyatlanmamış" sayar ve tutar yerine "Hesaplanmadı" gösterir.
Gerçek maliyet için oran hem Vercel'de hem Python işlerinin ortamında
tanımlanmalı; oran geriye dönük uygulanmaz.

| Ne | Eşik | Aksiyon |
| --- | --- | --- |
| `ingest_run` başarısızlığı | Aynı merchant 2 kez üst üste (tek başarısızlık: bilgi) | Uyarı |
| İş koşusu takılı | 2 saat "sürüyor" | Uyarı |
| Zamanlanmış iş gecikti | Günlük 30 saat, 15 dk'lık 2 saat | Uyarı |
| Model çağrısı sapması | Son 24 saat > önceki 7 günün günlük ortalaması × 3 (en az 50 çağrı) | Uyarı |
| Link çözümleme kuyruğu (Redis) | 100 üzeri | Uyarı |
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

## Kişisel veri saklama işleri

Süre dolumu elle yapılmaz; günlük cron'larla yürür (`/api/cron/*`,
`CRON_SECRET`). 0036 tablolarında (`auth_event`, `user_activity_event`)
uygulama rolünün UPDATE yetkisi yoktur (tek istisna `query_norm` kolonu),
DELETE yetkisi vardır: temizlik uygulama rolüyle yapılır, SECURITY DEFINER
istisnası (0021) açılmaz. Cron yanıtındaki `retention` alanı silinen ya da
NULL'a çekilen satır sayılarını verir (kişisel veri yok).

| İş | Kapsam | Durum |
| --- | --- | --- |
| `cleanup-auth` | `auth_token`, `phone_login_code`, `session` süresi dolanlar | çalışıyor |
| `purgeExpiredActivity` | `user_activity_event` 180 gün, `query_norm` 90 gün, `auth_event` 1 yıl, `user_consent.ip` 1 yıl | çalışıyor: `cleanup-auth` içinde, ayrı cron yok (0049) |

İşin son koşusu `/yonetim/islemler/isler`'de (`cleanup_auth`) görünür;
süresi geçmiş giriş kaydı birikirse işletim ekranı uyarır (0055). En eski satır süreyi aşmışsa iş çalışmıyor demektir.
Ertelenmez: süresi geçmiş kişisel veri tutmak aydınlatma metnine aykırıdır.

Analitik rızası geri alındığında kullanıcının olaylarının silinmesi cron'a
bırakılmaz; rıza satırıyla aynı işlemde yapılır (0049 §8).

## Sorgu yorumlama (Gemini, çevrimdışı) — üretimde DEVRE DIŞI

**Durum:** kod ve 0044 üretimde; `GEMINI_API_KEY` Vercel'de YOK, zamanlayıcı
yok, Google'a hiçbir metin gitmiyor. Anahtar ancak docs/kvkk.md
"Etkinleştirme öncesi hukuki kontrol listesi" (sözleşme tarafı, Paid Services
koşulları/DPA kaydı, KVKK işleme şartı, KVKK m.9 aktarım mekanizması —
nitelikli hukuki inceleme, standart sözleşme kullanılıyorsa Kurum bildirimi,
VERBİS, yayına alınmış aydınlatma metinleri, onay tarihi/sorumlu)
tamamlandıktan sonra eklenir. `store: false` aktarımı ya da işlemeyi
kaldırmaz; Google kötüye kullanım tespiti için sınırlı süre kayıt tutabilir.

Karar 0059. Uç: `GET /api/cron/interpret-queries`, `Authorization: Bearer
${CRON_SECRET}`. **Zamanlanmış değil**: `vercel.json`'da ya da GitHub
Actions'ta yok; yalnızca elle çağrılır. `/ara` bu ucu çağırmaz.

**`/ara` okuma yolu ve dağıtım sırası.** `/ara`, deterministik netleştirme
ilk turda domain bulamadığında `query_interpretation`'dan (normalize sorgu +
bugünkü taksonomi özeti + bugünkü model sürümü, yalnızca `accepted`) OKUR;
model çağrısı, ağ isteği ya da yazma yoktur. Bu yüzden üretimde sıra:

1. `0044_query_interpretation.sql` uygulanır ve doğrulanır
   (`SELECT count(*) FROM schema_migration` / `to_regclass('public.query_interpretation')`).
2. Kod dağıtılır.

Okuma, tablo yoksa (`42P01`) ya da sorgu hata verirse sessizce deterministik
yola düşer (yalnızca sınıf + SQL kodu loglanır, sorgu metni yok); bu bir
emniyet ağıdır, migration'ın yerine geçmez — tablo yokken her
domain'siz `/ara` isteği bir hata satırı loglar. Okuma yolu için
`GEMINI_API_KEY` GEREKMEZ: anahtar yoksa uç "atlandı" döner, yeni yorum
üretilmez, `/ara` yalnızca tabloda zaten olan (bugün: hiç) satırları kullanır.

- `GEMINI_API_KEY` yoksa sağlayıcı çağrılmaz; yanıt `status: "skipped"`,
  `skippedReason: "missing_api_key"`. Üretimde anahtar yukarıdaki kontrol
  listesi tamamlanmadan tanımlanmaz.
- Koşu başına en fazla 20 sorgu; 35 sn'den sonra yeni sorguya başlanmaz.
  İstemci 10 sn zaman aşımı, en fazla 2 deneme. Aynı anda ikinci koşu
  (`already_running`) atlanır.
- Aday: `search_query_day` son 30 gün, en az 3 arama VE en az 3 farklı gün,
  kişisel veri/kimlik/sır ve özel nitelikli veri bağlamı süzgecinden geçmiş,
  deterministik netleştirmenin domain bulamadığı normalize sorgu.
  Kullanıcı/oturum verisi okunmaz. Gönderilen metin anonim değildir:
  süzgeçler riski azaltır, garanti etmez; 3 farklı gün 3 farklı kişi demek
  değildir.
- Saklama: `query_interpretation` 90 gün (`created_at`). Günlük `cleanup-auth`
  cron'u siler; adım diğer saklama işlerinden yalıtılmıştır (tablo yoksa ya da
  `arilla_app`'in DELETE yetkisi yoksa diğer temizlik sürer, koşu `partial`,
  `detail.queryInterpretations_failed` SQL kodunu taşır).
- **Etkinleştirme ön koşulu (salt okunur, şimdi değil):** üretim çalışma
  rolünün okuma ve 90 günlük temizlik yetkisi doğrulanır; hiçbir yetki bu
  adımda verilmez ya da geri alınmaz, eksikse ayrı ve onaylı bir adımda
  düzeltilir:
  ```sql
  SELECT
    has_table_privilege('arilla_app', 'public.query_interpretation', 'SELECT') AS can_select,
    has_table_privilege('arilla_app', 'public.query_interpretation', 'DELETE') AS can_delete;
  ```
  İkisi de `true` olmalı (toplu iş ayrıca INSERT ister:
  `has_table_privilege('arilla_app', 'public.query_interpretation', 'INSERT')`).
- Sonuç `query_interpretation`'a yazılır (`accepted` / `empty` / `invalid`);
  sağlayıcı hatası satır yazmaz, sonraki koşu yeniden dener. 401/403/4xx ya da
  429'da koşu durur (`stopCode`).
- Her HTTP denemesi `api_usage`'a bir satır (`operation =
  'query_interpretation'`, `units` = toplam token, kimlik NULL, `cost_micros`
  0 — fiyat oranı henüz tanımlı değil, ekran "fiyatlanmamış" sayar).
- Koşu `job_run`'a `query_interpretation` adıyla yazılır; `/yonetim/islemler/isler`
  listesinde görünür. `job_run`'da `skipped` durumu yoktur: atlanan koşu
  `success` + `detail.skipped = true` ve `skippedReason` ile yazılır.
  Ayrıntı yalnızca sayılardır.

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

**Para birimi (0029, 0031).** `currency_verified = true` ve `currency = "TRY"`
taşımayan Shopify merchant'ı mağazaya istek atılmadan reddedilir
(`ingest_run`: `refused:currency_unverified`). Kanıt manifestin yanındaki `currency_provenance.json`
dosyasından okunur; dosyada olmayan mağaza reddedilir. Mağaza çekmeden yalnızca
merchant ayarını güncellemek: `--register-only`.

**Aktivasyon yok (0042).** Bootstrap yeni merchant'ı `is_active = false`
ekler, mevcut merchant'ın `is_active`'ine dokunmaz ve pasif merchant için
mağazaya istek atmaz (rapor: `inactive`). Aktivasyon ayrı, onaylı bir adımdır.
Para birimi doğrulanmış bir merchant'ın ayarı manifestten farklıysa kayıt
reddedilir (`refused`), satır değişmez. Toplama, ilk katalog isteğinden önce
robots.txt'i katı biçimde denetler.

**Barkod zenginleştirmesi (0034, 0036).** `collect.bootstrap` her mağazanın
toplamasından hemen sonra otomatik çalıştırır (`--skip-identifiers` ile kapanır;
hata toplamayı düşürmez, rapora yazılır). Bağımsız çalıştırma:
`python -m collect.identifiers --merchant <slug> [--force]`. Kapsam: yalnızca
birden fazla mağazada görülen markaların offer'ları. Kaynak: herkese açık
`/products/<handle>.js`, robots.txt'e tabi, sıralı, ≤ 0,5 istek/sn, yeniden deneme
yok, 401/403/429'da mağaza durur. Barkod varyant satırına (`offer_variant.gtin`)
yazılır; offer düzeyinde yalnızca tek ticari varyantsa. 7 gün içinde kontrol
edilen offer yeniden istenmez. Sonra `resolve`.

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

## Rol değiştirme (yönetici / moderatör)

Karar 0039: rol arayüzden atanmaz; `app_user.role` tek kaynaktır ve yetenekler
koddaki sabit haritadan gelir (`packages/core/src/admin/capabilities.ts`).
Hesap önce normal girişle (Google/Apple) bir kez açılmış olmalıdır.

**Yerel geliştirme** - denetlenen, idempotent, geri alınabilir betik:

```bash
pnpm db:set-role -- --email kisi@ornek.com --role admin --reason "yerel test yöneticisi"
pnpm db:set-role -- --email kisi@ornek.com --role user  --reason "yetki geri alındı"
# e-posta yerine: --public-id <uuid>; başka bir yönetici adına: --actor-email <yönetici>
```

- Yalnızca yerel veritabanında çalışır (`DATABASE_URL_OWNER` localhost değilse durur).
- Rol zaten istenen değerse hiçbir şey yazmaz.
- `users.role_change` denetim satırını veritabanı tetikleyicisi
  (`app_user_role_change_audit`, 0039) aynı işlemde yazar; betik yalnızca aktörü
  ve gerekçeyi verir (`actor_role = 'cli'`). `/yonetim/denetim`'de "Rol
  değiştirildi" olarak görünür. Tetikleyici yoksa betik durur.
- Rol her istekte veritabanından okunur: açık oturum bir sonraki istekte yeni
  rolle değerlendirilir. Yönetim alanı ayrıca 12 saat / 30 dakika oturum
  kuralını uygular (karar 0044).

**Üretim** - betik bilerek çalışmaz. Onaylı bir işlemde, sahip rolüyle, tek
transaction'da elle. Denetim satırını tetikleyici yazar (karar 0050); elle
INSERT YAZILMAZ, yalnızca aktör ve gerekçe işleme verilir:

```sql
BEGIN;
SELECT set_config('arilla.audit_actor_user_id', '<işlemi yapan yöneticinin id''si ya da boş>', true),
       set_config('arilla.audit_actor_role', 'cli', true),
       set_config('arilla.audit_reason', '<gerekçe>', true);
UPDATE app_user SET role = 'admin'
 WHERE public_id = '<hesap kimliği>' AND role <> 'admin'
RETURNING id;                       -- tam olarak 1 satır dönmeli; dönmezse ROLLBACK
COMMIT;
```

Geri almak için aynı işlem `role = 'user'` ile. Ayar verilmeden yapılan rol
değişikliği de denetlenir (aktör boş, `actor_role = 'db'`, `after.dbRole` bağlanan
veritabanı rolü): `dbRole = 'arilla_app'` olan bir rol satırı uygulama rolünün
kötüye kullanıldığını gösterir, olay olarak ele alınır.

Yetkili hesap kendi hesabını `/hesap`'tan silemez; önce rolü bu yolla düşürülür.
Rolü düşürülmüş hesap silinince denetim satırları kalır, aktör bağlantısı boşalır.

## Acil oturum kapatma (ele geçirilmiş hesap)

Karar 0050. Üç yol, en hızlısından:

1. Yönetim paneli: `/yonetim/kullanicilar/<hesap>` → "Tüm oturumları kapat"
   (yalnızca yönetici, son 1 saatte giriş, gerekçe zorunlu, denetlenir).
2. Kullanıcının kendisi: `/hesap` → "Tüm cihazlardan çıkış yap".
3. Panel erişilemiyorsa ya da ele geçirilen bir YÖNETİCİ ise, sahip rolüyle:

```bash
pnpm db:revoke-sessions -- --public-id <uuid> --reason "<gerekçe>" --demote --confirm-remote
# --demote: rolü 'user'a düşürür (tetikleyiciyle denetlenir); --actor-email <yönetici> isteğe bağlı
```

Oturum silme, `sessions.revoke_all` satırı ve rol düşürme tek işlemdir. Ardından:
`/yonetim/denetim`'de son `users.role_change`, `security.access_denied` ve
`sessions.revoke_all` satırlarını incele; hesabın Google/Apple tarafında da
oturumlarının kapatılmasını iste. `SESSION_SECRET` döndürmek BÜTÜN kullanıcıları
çıkışa zorlar; yalnızca sır sızıntısında yapılır.

## Pazarlama e-postası kampanyaları

Karar 0048. Yönetim: `/yonetim/kampanyalar` (yalnızca yönetici).

**Açma (üretim).** Gerçek gönderim varsayılan olarak kapalıdır. Açmadan önce:
İYS kaydı ve rıza metninin hukuk onayı (`docs/kvkk.md`), sağlayıcıda gönderen
alan adı doğrulaması (SPF/DKIM/DMARC). Sonra Vercel production'da
`MARKETING_EMAIL_FROM` ve `MARKETING_EMAIL_ENABLED=true`, GitHub Actions'ta
`MARKETING_CRON_URL` secret'ı. Kapatmak için `MARKETING_EMAIL_ENABLED`
boşaltılır: sürmekte olan kampanya `sending`te bekler, ileti gitmez,
yönetim ekranı "gerçek gönderim kapalı" der.

**Test gönderimi.** Yalnızca gönderen yöneticinin kendi adresine (hesap
e-postası ya da doğrulanmış Google/Apple e-postası) veya
`MARKETING_TEST_RECIPIENTS` (virgülle ayrılmış) listesindeki adreslere gider;
saatte en fazla 10 (karar 0050). Başka adres reddedilir ve sayılmaz.

**İlerleme.** Gönderim partiler hâlinde: başlatma anında bir parti, sonra
`trigger-alerts-cron.yml` ile 15 dakikada bir parti (varsayılan 40 ileti).
Büyük liste için `MARKETING_EMAIL_BATCH_SIZE` artırılır (süre bütçesine
dikkat) ya da kampanya sayfasındaki "sonraki partiyi şimdi işle" kullanılır.
Yerelde cron yok; düğme ya da `curl -H "Authorization: Bearer $CRON_SECRET"
http://localhost:3000/api/cron/marketing-campaigns`.

**Durumlar.** "Sağlayıcıya verildi" = SMTP kabul etti; teslim, bounce ve
şikâyet henüz izlenmiyor. `unknown_outcome` = ileti verilirken süreç durdu ya
da bağlantı veri aktarımında koptu; çift ileti riskine karşı yeniden
denenmez. Kampanya `sending`te takılı kaldıysa önce ekrandaki son hata
koduna bakılır (`configuration_error`: SMTP/gönderen; `bulk_send_disabled`:
ortam kapısı).

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
