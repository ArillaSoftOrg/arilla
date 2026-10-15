# 0120 — Katalog keşif defteri ve sitemap koşu altyapısı

**Tarih:** 15 Ekim 2026
**Durum:** Kabul edildi (migration 0073). Yalnızca veri katmanı; toplayıcı/arayüz sonraki fazlar.
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
