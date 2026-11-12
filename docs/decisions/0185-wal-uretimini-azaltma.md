# 0185 — WAL üretimini azaltmak: ölçüm, teklif HOT güncellemesi, checkpoint, outbox dizini

Tarih: 2026-11-12. Bağlam: karar 0114 (değişmeyen teklif yazılmaz), 0134 (WAL geri basıncı),
0136 (`search_outbox` tüketicisiz), 0183 (yedek boyutu; Aşama A). Bu karar Aşama B'dir.

## Sorun (12 Kasım, üretimde salt okunur ölçüm)

R2 deposunun ~597 GB'ının 373 GB'ı WAL arşivi. Besleme günlerinde günde 27–37 GB ham WAL üretiliyor.

| Kaynak | Ölçülen |
| --- | --- |
| `pg_stat_wal` (13 Eki'den beri) | 703 GB; 148,6 M tam sayfa görüntüsü (FPI) |
| `pg_stat_statements` (izlenen 569 GB) | katalog yayını ~190 GB, sınıflandırma 64 GB, teklif–ürün eşleme 39 GB (**tek seferlik toplu işler**). Kalıcı: besleme MERGE ~134 GB, `offer_image` 49 GB, `refresh_product_aggregates` 30 GB |
| `offer` | 44,6 M güncelleme, **0 HOT**; 13 dizin; `offer_active_price_idx` **0 tarama** |
| `feed_source_offer` | 65,9 M güncelleme (%96 HOT); her koşuda tüm üyelikler yeniden yazılıyor |
| `product` | 36,9 M güncelleme, neredeyse tamamı toplu yayın ve sınıflandırma |
| `search_outbox` | 30,2 M satır, 3,8 GB; %99,3'ü benzersiz varlık; ~0,5 M satır/gün; kısmi `search_outbox_pending_idx` 647 MB |
| Okuma kaynaklı WAL | `SELECT count(*) FROM offer …` 13 GB: sağlama toplamı açıkken, yeni yazılmış sayfaya ipucu biti ilk kez yazıldığında FPI üretilir. Kaldıraç değil; vacuum aynı işi yapar. |

**Yerel bench** (`services/ingest/scripts/bench_feed_wal.py`, 100 bin teklif, gerçek `FeedSync` yolu):

| Koşu | WAL | `offer` güncelleme / HOT | Üyelik güncellemesi |
| --- | --- | --- | --- |
| Günlük değişim (%60 fiyat, %1 yeni, %1 kaybolan) | 190,6 MB | 59.400 / **%0** | 99.000 |
| Değişimsiz tekrar (yalnız "görüldü") | 35,7 MB | 0 | 95.000 |

Yerel kümede veri sağlama toplamı kapalı; üretimdeki okuma kaynaklı FPI bu sayılara dahil değil.

**Kök neden:** Fiyatı değişen teklifte iki dizinli sütun değişiyor:
- `current_price`: `offer_active_price_idx`;
- `last_seen_at`: `offer_active_seen_idx` INCLUDE ve `offer_unmatched_recent_idx`.

Güncelleme bu yüzden HOT olamıyor; yeni satır sürümü ve 13 dizine kayıt yazılıyor. "Görüldü" bilgisi zaten
üyelik satırında tutuluyor (karar 0114) ve okuyan tarafın çoğu
`GREATEST(o.last_seen_at, üyelik.last_seen_at)` kullanıyor (`packages/core/src/admin/offer-seen.ts`).

## Karar (ayrı PR'lar, her biri önce ve sonra ölçülür)

- **B0 — Ölçüm (bu PR).**
  - `infra/vps/bin/wal_report.py`: salt okunur günlük görüntü ve iki görüntü arası fark (gün başına WAL,
    FPI, tablo HOT oranı, ifade bazında WAL). Hiçbir sayaç sıfırlanmaz.
  - `arilla-wal-report.timer` her gün 00:05 UTC'de çalışır.
  - `bench_feed_wal.py`: yerel bench.
- **B1 — Teklif güncellemesini HOT yapmak.**
  - Besleme MERGE'ü, zaten etkin olan satırda `offer.last_seen_at`'i yazmaz. Yalnızca o sütunu okuyan
    yerler `OFFER_SEEN_AT` kuralına geçer.
  - Ardından ayrı migration'lar:
    - `DROP INDEX CONCURRENTLY offer_active_price_idx` (0 tarama);
    - `ALTER TABLE offer SET (fillfactor = 80)`.
  - `price_point` ve `current_price` kuralları değişmez.
  - **Neden 80:** Üretimde besleme teklifi ortalama 1.064 bayt (takip bağlantısı 488 bayt). %90
    doluluk ~820 bayt boşluk bırakır ve yeni sürüme yetmez.
  - **Yerel ölçüm** (100 bin teklif, üretim genişliğinde satır, veri sağlama toplamları açık, ilk
    sayfalar üretimdeki gibi dolu; her senaryo şablon veritabanının temiz kopyasında; 4. gün):

    | Ayar | WAL | `offer` HOT | yığın + dizin |
    | --- | --- | --- | --- |
    | main (dizin var, ff 100) | 189,9 MB | %0 | 207 + 70 MB |
    | B1, ff 90 | 169,2 MB (−%11) | %25 | 203 + 57 MB |
    | B1, ff 85 | 161,5 MB (−%15) | %25 | 215 + 58 MB |
    | **B1, ff 80** | **122,5 MB (−%36)** | **%52** | **221 + 57 MB (≈ aynı)** |
    | B1, ff 70 | 97,5 MB (−%49) | %78 | 244 + 57 MB (+%8) |

  - HOT oranı günden güne artar: budama ölü sürümlerin yerini açar. 80, toplam boyutu
    değiştirmeden en büyük kazancı veriyor. 70 tabloyu büyütür; disk zaten sıkışık (0183).
  - **Üretimde geçiş kademelidir:** var olan dolu sayfalar yeniden yazılmaz; yer, budama ve vacuum ile
    açılır. Etki `wal_report.py diff` ile günlük ölçülür.
- **B2 — Checkpoint aralığı.** `checkpoint_timeout` 15 dk'dan 30 dk'ya.
  - Daha az FPI; `max_wal_size` 16 GB kalır.
  - Bedeli: daha uzun çökme kurtarması.
  - Yalnızca yeniden yükleme gerekir (açık onayla).
  - Üretimde checkpoint'lerin %96'sı zamanlı (2815 zamanlı / 128 istenen). Aralığı uzatmak,
    WAL ile tetiklenen checkpoint'i değiştirmez; yalnızca zamanlı olanları seyreltir.
  - `catalog-publish` eşikleri `max_wal_size`'tan hesaplanıyor (tutulan ≈ 2× `max_wal_size` +
    arşivlenmemiş); değişmez.
  - **Etkisi yerelde ölçülemez:** bench her koşudan önce CHECKPOINT alır ve koşu 30 sn sürer.
    Üretimde `wal_report.py diff` ile FPI/gün ve WAL/gün değişikliğin önce ve sonrasında
    karşılaştırılır. Kazanç tahmini verilmez.
- **B3 — Üyelik "görüldü" yazımı (koşullu).**
  - Satır yalnızca 20 saatten eskiyse yazılır; düşürme ölçütü buna göre değişir.
  - B1 sonrası bench'te besleme WAL'ında ≥%10 tasarruf yoksa yapılmaz.
- **B4 — `search_outbox`.**
  - **Satır silinmez** (kullanıcı kararı; 0136 korunur).
  - Yalnızca türetilmiş `search_outbox_pending_idx` kaldırılır; tüketici gelince yeniden kurulur.
- **`product`: değişiklik yok.**
  - Yazımlar zaten yalnızca değişen satırı yazıyor (0086, 0135).
  - `product_title_trgm` kalır: `resolve/candidates.py` kullanıyor.

## Yapılmayacaklar

- `VACUUM FULL`, `pg_repack`, satır silme, saklama veya PITR değişikliği, `pg_stat_statements` sıfırlama.
- Yabancı anahtar ya da yönetim özelliği taşıyan dizinleri kaldırmak (`offer_seller_idx`,
  `offer_feed_source_idx`, `offer_unmatched_*`).

## Ölçüm yöntemi (Aşama C)

- `wal_report.py diff` ile değişiklik öncesi ve sonrası günlük farklar karşılaştırılır: WAL/gün, FPI payı,
  `offer` HOT %, üyelik güncellemesi, ifade payları.
- 16–21 Kasım blok yedeği haftası (0183) aynı tabloya eklenir.
- Ölçülen ve tahmin edilen değerler ayrı raporlanır.
