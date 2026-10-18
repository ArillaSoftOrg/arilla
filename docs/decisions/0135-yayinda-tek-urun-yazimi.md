# 0135 — Toplu yayında ürün satırı bir kez yazılır; indeks adayı eklenmez

## Karar

1. **Yayın ve fiyat özeti tek UPDATE.** `catalog_build publish` bir partide ürünü `published`
   yaptığı UPDATE'te fiyat özetini (`min_price`, `max_price`, `offer_count`, `in_stock_count`,
   `foreign_offer_count`, `price_updated_at`) de yazar. Ardından ayrıca
   `refresh_product_aggregates` çağrılmaz.
2. **Kural yine tek yerde.** Özet kuralı salt okunur `product_aggregate_values(bigint[])`
   fonksiyonuna taşındı (migration 0090). `refresh_product_aggregates` aynı imza, anlam, dönüş
   değeri ve kilit sırasıyla bu fonksiyonu okur. Yayın da aynı değerleri okur; kopya SQL yoktur.
   Özet değişmediyse `price_updated_at` korunur ve satır `aggregates_updated` olarak sayılmaz
   (eski anlam).
3. **`(source_merchant_id, publication_state, id)` indeksi eklenmez.** Ölçüldü, kazanç yok;
   her durum geçişine yazım maliyeti ekler (aşağıda).
4. `unpublish`, `foreign_offer_count`'u da sıfırlar. Önceden 1'de kalıyordu ve
   `refresh_product_aggregates` aynı satırı sonradan düzeltmek zorundaydı.

## Gerekçe (ölçüm)

Laboratuvar: PostgreSQL 16 + pgvector, tüm migration'lar, 1.000.000 AliExpress benzeri USD
`ready` ürün ve kimlik sırasında araya giren 60.000 başka kaynak `ready` ürün; yanında
200.000 yayında TRY ürün. Prod ayarları (`wal_compression=on`, `max_wal_size=4GB`), ancak
`shared_buffers=384MB` (veri ≈ 4×; prod ≈ 2,5×). Her koşu taze kopyada, `CHECKPOINT`
sonrası, 100.000 ürün yayınlanır; main ve dal serpiştirilerek çalıştırıldı.

| | main | dal | fark |
| --- | --- | --- | --- |
| WAL / ürün | 14.424 B | 8.458 B | **−%41** (iki turda birebir aynı) |
| WAL / 100k ürün | 1.376 MB | 807 MB | |
| hız, sakin tur | 787 ürün/sn | 1.468 ürün/sn | ×1,87 |
| hız, G/Ç baskılı tur | 186 ürün/sn | 675 ürün/sn | ×3,6 |

Main'de `refresh_product_aggregates` yayın WAL'inin %42'sini (573 MB) üretiyordu. Satır az
önce `published` yapıldığı için ikinci yazım HOT olamıyordu (sayfada yer yok) ve ürünün
bütün indekslerine, üç başlık trigram GIN'i dahil, yeniden giriyordu. Prod'daki
`pg_stat_statements` oranları bununla uyumlu: UPDATE product 192 ms, refresh 127 ms,
UPDATE offer 50 ms (laboratuvar: 220 / 140 / 46 ms).

Bundan sonra WAL'in kaynağı (dal, 100k ürün, `pg_walinspect` ile ilişki başına):

| ilişki | pay |
| --- | --- |
| `product_title_trgm` + `product_title_fold_trgm` + `product_title_fold_foreign_trgm` (GIN) | %55,7 |
| `product` (heap) | %8,2 |
| `offer` (heap) | %6,7 |
| `product_public_id_key` + `product_slug_key` (rastgele sıralı anahtar, FPI) | %9,4 |
| kalan btree'ler, `match_decision_log`, `search_outbox` | ≈ %20 |

`publication_state` indekslerde bulunduğu için yayın UPDATE'i hiçbir zaman HOT olamaz. Bu
yüzden her indeks bir giriş alır. `public_id` (uuid) ve `slug` sırası kimlik sırasından
bağımsızdır: her checkpoint'ten sonra dokunulan her yaprak tam sayfa görüntüsü (FPI) yazar.
Bu kalem checkpoint aralığı uzadıkça azalır (#176'nın `max_wal_size` kararı).

### Seçim sorgusu (SELECT … FOR UPDATE SKIP LOCKED)

Yayın sürerken (kürsör ortada), sıcak önbellekte:

| | plan | süre | tampon |
| --- | --- | --- | --- |
| mevcut indeksler | `product_pkey` (`id > $1`), süzgeçte 32 satır elenir | 1,26 ms | 3.034 |
| aday `(source_merchant_id, publication_state, id)` | aday indeks | 1,27 ms | 3.033 |

Kürsör 0'dan başlarken (yeniden başlatma) plan `product_unpublished_idx` olur. Yalnızca
AliExpress `ready` olduğunda süzgeç satır elemez (prod'da beklenen durum). Laboratuvarda
araya giren başka kaynak satırları için soğuk durumda 38 ms, sıcak durumda 16 ms ölçüldü.
Aday indeks bu ilk partiyi kısaltır, ama 37 MB yer tutar ve her `draft→ready→published`
geçişine bir btree girişi daha ekler. Toplu yayının darboğazı WAL olduğundan bu bedel
kazancı aşar.

Prod'daki 440 ms ortalamayı plan açıklamıyor: laboratuvarda aynı plan sıcakken 1–16 ms
sürdü. G/Ç baskılı turda aynı SELECT 80 ms'ye çıktı ve bunun 75 ms'si okuma bekleyişiydi.
Seçim, partinin ürün ve teklif sayfalarına ilk dokunan ifadedir: soğuk okumanın ve dolu
`shared_buffers`'ta kirli sayfa tahliyesinin (yazma + WAL flush) bedelini o öder. Prod'da
doğrulama (salt okunur):

```sql
SELECT calls, round(mean_exec_time) AS ms, shared_blks_read / calls AS okuma,
       shared_blks_written / calls AS tahliye_yazimi, round(blk_read_time / calls) AS okuma_ms,
       round(blk_write_time / calls) AS yazma_ms
  FROM monitoring.pg_stat_statements
 WHERE query LIKE 'SELECT p.id, o.id, o.external_id%' ORDER BY calls DESC LIMIT 1;
SELECT backend_type, context, reads, writes, round(write_time) AS write_ms
  FROM pg_stat_io WHERE backend_type = 'client backend' AND object = 'relation';
```

`blk_*_time` yalnızca `track_io_timing=on` iken dolar. Yeniden başlatma gerekmez ama bir
ayar değişikliğidir; bu karar o ayarı değiştirmez. Daha az WAL ve daha az kirli sayfa bu
bekleyişi de azaltır.

## Reddedilen

- **`(source_merchant_id, publication_state, id)` indeksi:** yukarıdaki ölçüm.
- **`product_unpublished_idx`'i `(publication_state, source_merchant_id, id)` ile değiştirmek:**
  mağaza süzgeci olmayan sorgular (kapı, yönetim) kimlik sırasını kaybeder.
- **GIN `fastupdate = off`:** aynı yük ürün başına 63.467 B WAL üretti (×7,5) ve 252 ürün/sn'ye
  düştü. Bekleyen liste ardışık sayfalara yazar; kapalıyken her trigram rastgele bir posting
  sayfasına FPI ile girer.
- **`FOR UPDATE`'i kaldırmak:** parti başına 27 KB kilit WAL'i (ürün başına 54 B) için eş
  zamanlı yayıncı güvenliğinden vazgeçmeye değmez.
- **Özeti Python'da hesaplayıp yazmak:** kuralın ikinci kopyası olurdu (0086'nın kaldırdığı
  sorun).

## Ayrı iş (bu kararın kapsamı dışında)

- **`product_title_fold_trgm` kaldırılırsa** yayın WAL'inin ≈ %20'si daha gider. Bu indeks
  0083'ten beri `fold_try` + `fold_foreign` bölüm indekslerinin birleşimiyle aynı satırları
  kapsar. Ancak yönetim katalog araması (`admin/catalog.ts`) ve link araması
  (`discovery/link-search.ts`) hâlâ onu kullanır. Önce bu sorgular bölümlere taşınmalı
  (`packages/core`), ardından `-- kind: concurrent` ile `DROP INDEX CONCURRENTLY` gelir.
- WAL geri basıncı, bekçi eşikleri ve `postgresql.conf`: karar 0134 (#176).
