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
