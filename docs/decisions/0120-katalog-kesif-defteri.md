# 0120 — Katalog keşif defteri ve sitemap koşu altyapısı

**Tarih:** 15 Ekim 2026
**Durum:** Kabul edildi (migration 0073). Veri katmanı + yönetici toplayıcısı (aşağıda "Eklenen"); otomatik başlatma yok.
Hepsiburada'ya istek atılmadı, koşu başlatılmadı, kota ve politika satırı değişmedi.
**Bağlam:** 0117 (yönetici tarayıcısından toplama), araştırma: ürün sitemap'i 7.470 dosya × 10.000
`-pm-` adresi (ad + görsel var, fiyat yok). Fiyatsız kimlikler `offer` olamaz (`offer.price` zorunlu).

## Karar

1. **Mevcut altyapı aynen:** `collection_source/run/unit` ve `catalog_intake_record` kullanılır. Kota
   tetikleyicisi (7 gün aralık, ayda 4) aynı mantıkla yeniden tanımlandı; bir KOŞU bir kota hakkıdır,
   koşu içindeki dosya/sayfa istekleri ayrı hak sayılmaz. `initial`/`refresh` ayrımı tetikleyicidedir.
2. **Tek yeni tablo `catalog_discovery`:** PK `(source, external_id)` — tekrar keşif yeni satır üretmez
   (upsert; `last_seen_*` güncellenir, boş alan eldeki değeri silmez). Fiyat KOLONU yoktur; yalnızca
   `price_state` (`unpriced` → `listing_price` → `page_verified`; `stale`, `unavailable`) vardır.
   Sahte/tahmini fiyat üretilmez. Satır silinmez (`arilla_app` DELETE/TRUNCATE yok); eksik tarama
   hiçbir kaydı pasifleştirmez. 8 milyon sabit sınır değildir.
3. **Checkpoint sitemap dosyası bazındadır:** `collection_unit` yeni tür `sitemap_file`, durum
   `pending`, `unit_seq`, `attempts`, `bytes_received`. Tüm plan baştan satır olarak yazılır
   (`planDiscoveryUnits`), devam `nextDiscoveryUnits` ile; `collection_run.checkpoint` (64 KB) yalnızca
   küçük ek durumdur. Bir dosya tek işlemde yazılır: defter + birim + koşu sayaçları.
4. **Yapılandırılabilir güvenlik sınırları** (`collection_source`): `min_request_interval_ms` (≥1000,
   varsayılan 2000; sunucu `fetched_at` farkından ihlali reddeder), `initial_max_bytes`/`refresh_max_bytes`
   (varsayılan 1 GiB), `blocked_cooldown_minutes` (blocked birim sonrası koşuda bekleme),
   `initial_run_window_days` (ilk yükleme 6 günden uzun sürebilir; tek açık koşu kuralı korunur),
   mevcut istek bütçeleri. İzin hız/hacim belirtmediği için varsayılanlar muhafazakârdır.
5. **İndirme onayı:** koşu `max_bytes` politikadan alır; `download_approved_bytes` 0 iken hiçbir bayt kabul
   edilmez. Onay (`approveRunDownload`) politika tavanını aşamaz, denetim kaydı yazılır ve ağ kaynağını
   (`vps`/`admin_wifi`/`admin_wired`/`admin_mobile`; beyan, sunucu doğrulayamaz) saklar.
6. **Sunucu istemciyi doğrular:** URL `hepsiburada.com`, https, sorgusuz; kimlik URL sonundaki koddan
   (`-pm-`/`-p-`) doğrulanır; görsel `hepsiburada.net`; fiyat alanı kabul edilmez.
7. **Sitemap'e girme (SEO) ayrı karar:** yalnızca yeterli içerikli sayfalar Google sitemap'ine alınır;
   keşif defteri satırı kendi başına indekslenebilir sayfa değildir (sonraki faz).

## Ölçüm (yerel PG16)

1 milyon satır ≈ 273 MB (PK 48 MB, ≈273 B/satır) → 75 milyon ≈ 20 GB (tahmin, doğrusal varsayım).
1 milyon ekleme 15,5 sn; 10 bin mevcut kaydın upsert'i 0,25 sn. `fillfactor=85` HOT güncelleme içindir;
`last_seen_*` indekslenmez. Gerçek ağ trafiği ve üretim depolaması ilk aktarımdan ÖNCE ölçülecektir.

## Reddedilen

- Fiyatsız kimlikleri `offer`'a yazmak (fiyat uydurmayı veya NULL fiyatı zorlar; AliExpress hattını bozar).
- Vekil kimlikli (BIGINT identity) defter: ek indeks ve yazma maliyeti, doğal anahtar yeterli.
- Her sitemap adresini `catalog_intake_record`'a yazmak (fiyat zorunlu, koşuya bağlı mükerrer).
- Kota hesabını istek başına yapmak (izin koşu bazlıdır).

## PR #149 notu

Trendyol `collection_unit_kind_check`'i 0072'de yeniden tanımlıyor. Birleşik küme
`('query','product_page','listing_page','sitemap_file')`; hangisi sonra merge edilirse bu kümeyi korumalıdır.

## Eklenen: toplayıcı, disk koruması ve kapasite planı

**Toplayıcı (yönetici tarayıcısı).** `discovery-logic.ts` + `discovery-client.tsx`
(`/yonetim/katalog/toplama`, "Sitemap keşfi"). Sitemap indeksi ve dosyaları akışla okunur
(`sitemap-stream.ts`): gövde belleğe toptan alınmaz, tampon en fazla tek `<url>` kadar büyür
(64 KB sınırı), açılmış bayt tavanı aşılırsa akış kesilir. Dosyalar tek tek, aralarında bekleyerek
indirilir; 401/403/429/503, HTML/doğrulama sayfası, kesik dosya ya da yapı yoksa koşu DURUR, yeniden
deneme yoktur. Kesik dosyadan kayıt gönderilmez. Her dosya tek işlemde yazılır; koşu kaldığı dosyadan
sürer. Toplayıcı kendiliğinden başlamaz: yönetici koşuyu başlatır, bayt onayı verir.

**Disk koruması (güvenli durdurma).** Disk boş alanı PostgreSQL'den görünmez; bu yüzden sunucu her
partide `pg_database_size()` + (yeni kimlik × 600 B) değerini tavanla karşılaştırır. Tavan
`CATALOG_DISCOVERY_DB_MAX_BYTES` (varsayılan 60 GiB; 193 GB disk için WAL/yedek/geçici dosyalara pay
bırakır). Aşılırsa parti `database_size_limit` (HTTP 507) ile REDDEDİLİR; hiçbir şey yazılmaz ya da
silinmez, koşu açık kalır. İkinci katman: onaysız bayt kabul edilmez, politika bayt tavanı aşılamaz.
Disk doluluğunu izleyen ayrı sistem alarmı (VPS tarafı) bu kararın kapsamı DEĞİL; tavan, o alarmın yerini tutmaz.

**Initial / weekly ayrımı.** Mevcut: `kind` tetikleyicide belirlenir (ilk koşu `initial`, sonrası
`refresh`), ayrı istek/bayt bütçeleri, ilk yükleme penceresi ayrı (`initial_run_window_days`). İlk
yüklemenin kotadan muaf olduğu varsayılmaz.

**Fiyatsız ürünler.** `catalog_discovery`: `price_state='unpriced'`, fiyat kolonu yok. Fiyat yalnızca
sonradan sayfa/liste doğrulamasıyla gelir (sonraki faz); fiyatsız kayıt `offer`'a yazılmaz, AliExpress
teklifleri (2,8 milyon) bu tabloya ve koşuya dokunmaz.

**Kapasite (gerçek VPS: 15 GiB RAM, swap yok, disk 193 GB, 24 GB dolu, veritabanı 9,4 GB).**

| Kalem | Değer | Dayanak |
| --- | --- | --- |
| Defter satırı | ≈273 B (PK dahil) | yerel PG16, 1 milyon satır ölçümü |
| 8 milyon kimlik | ≈2,2 GB | doğrusal tahmin |
| 75 milyon kimlik (sitemap URL toplamı üst sınırı) | ≈20 GB | doğrusal tahmin; tekrar oranı ölçülmedi |
| WAL (toplu yazım, full-page write dahil) | tablo+indeks boyutunun ~1–1,5 katı, günler içinde | tahmin; WAL arşivi (R2) aksarsa diskte BİRİKİR — arşiv durumu ilk aktarımdan önce izlenmeli |
| Toplayıcı belleği | dosya başına ≤ 12.000 kayıt (~3 MB) + 64 KB tampon | akışlı ayrıştırma |
| Sunucu belleği | parti başına 2.000 satırlık INSERT; tüm dosya tek işlemde | `CHUNK = 2000` |

Yazım maliyeti: 1 milyon yeni satır ≈ 15,5 sn; 10 bin mevcut kaydın upsert'i ≈ 0,25 sn (yerel).
Bu sayılar yerel ölçümdür; VPS'te ölçülmedi.

**Politika sınırları ve gerçek tablo (değiştirilmedi).** Varsayılan: koşu başına 500 istek ve 1 GiB.
Sitemap'te 7.470 dosya var, dosyalar 9–12 MB. Bu, tek koşuda en çok ~500 dosya (istek tavanı) ve
~100 dosya (1 GiB bayt tavanı) demektir: **varsayılanlarla tüm sitemap'i taramak onlarca koşu sürer** ve
ayda 4 koşu kotasıyla aylar alır. Bunu aşmak için izin kapsamının genişletildiğinin beyanı
(`declared_extended`) ve sahip yetkisiyle politikanın güncellenmesi gerekir; kod bunu kendiliğinden
yapmaz. 8 milyon ürünün sığacağı ya da toplanabileceği varsayılmaz; sitemap'teki benzersiz kimlik
sayısı ve gerçek trafik ilk küçük aktarımdan sonra bilinecektir.

**Doğrulanmayanlar.** Sitemap dosyalarının tarayıcıdan `fetch` + CORS ile okunabildiği doğrulanmadı
(araştırmada tarayıcı gezinmesiyle okundu). CORS engellerse `fetch` hata verir, koşu `network_error`
ile durur; engel aşılmaz. Brotli açma (`DecompressionStream('br')`) tarayıcıya bağlıdır; tarayıcı
`Content-Encoding` ile gelen gövdeyi kendisi açar, yalnızca `.br` uzantılı dosya ek açma ister.
Fiyat/ana satıcı/varyant bu defterde yoktur.
