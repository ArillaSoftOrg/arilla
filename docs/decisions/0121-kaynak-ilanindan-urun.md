# 0121 — Kaynak ilanından ürün: aktarım, kalite kapısı ve yayın ayrımı

**Tarih:** 15 Ekim 2026
**Durum:** Kabul edildi (migration 0074). Kod ve testler hazır. Üretimde **hiçbir şey çalıştırılmadı**:
2,8 milyon AliExpress teklifi dönüştürülmedi, migration uygulanmadı, eşleştirme işi başlatılmadı.
**Bağlam:** 0111 (katalog modeli, kimlik düzeyleri), 0112 (AliExpress besleme şeması), 0113/0114
(TRY dışı fiyat), 0119 (otomatik birleştirme yalnız kesin kimlikle), 0120 (Hepsiburada keşif defteri, #154).

## Soru: "Eşleştirme işini çalıştır" gerçekte ne yapıyor?

Kalite panelinde **çalıştıran bir düğme yok**; yalnızca `python -m resolve` komutunu öneren bir metin var
(`catalog-quality.ts`, `apps/web/app/yonetim/katalog/teklifler`). Komutun kendisi (`resolve/pipeline.py`):

1. Eşleşmemiş aktif teklifleri alır, adaylar üretir (GTIN/MPN, başlık trigramı, görsel vektörü).
2. Skor kuyruk eşiğini aşarsa aday yazar (kesin kimlikte otomatik bağlar, diğerleri insan kuyruğuna gider; 0119).
3. Eşik altında kalan teklif için **yeni `product` açar** ve bağlar (`create_missing=True`, `products.create_from_offer`).
   Yani evet: yalnızca var olan ürünlerle eşleştirmez, yeni ürün de üretir.

AliExpress için ise **hiçbir şey yapmaz**: `PENDING_OFFERS` yalnızca `currency = 'TRY'` teklifleri seçer (0112) ve
AliExpress beslemesi yalnız USD verir. Ayrıca varsayılan `--limit 500`'dür ve her teklif için trigram + görsel
aday sorgusu çalışır; 2,8 milyon teklif için kullanılabilir bir yol değildir. Bu yüzden ayrı bir aktarım gerekti.

## Karar

1. **İlan = ürün, birleştirme yok.** AliExpress beslemesinde `offer@id` mağazanın ürün kimliğidir
   (`offer.external_id`); kanonik adres `/item/<id>.html` aynı kimliği taşır. Besleme GTIN, marka, SKU/varyant
   vermez. Kimlik kanıtı olmadığı için tek güvenli birim ilandır: her kaynak ilanı kendi taslak ürünü olur,
   başka ilanla **başlık benzerliğiyle birleştirilmez** (renk, kapasite, beden farkı başlıkta olmayabilir).
   Teklif kimliği ile adresteki ürün kimliği aynı değilse (`source_id_url_mismatch`) ürün açılmaz.
2. **Kalıcı kimlik üründe, DB düzeyinde.** `product.source_merchant_id + source_external_id` benzersizdir
   (`product_source_key_uniq`); aynı kaynak ilanı için ikinci ürün oluşamaz. `source_offer_id` benzersiz ve FK'dir.
   Slug `<ascii-başlık>-<kaynak-kimliği>`: benzersizlik varlık sorgusuz ve kalıcıdır, başlık değişse de slug sabit.
3. **Aktarım ≠ yayın.** `product.publication_state`: `draft` → (kapı) → `ready` | `held` → (açık yayın) → `published`.
   Mevcut tüm ürünler `published` kalır. CHECK: yayınlanmamış ürün yalnızca kaynak ilanı olabilir.
   Taslak/hazır/bekleyen ürün arama, ürün sayfası (404), renk kardeşleri, alternatifler, görsel/link arama,
   trendler, site haritası, eşleştirme adayları ve fiyat özeti onarımından dışlanır.
4. **`offer` satırına yazılmaz.** Taslak, `offer.product_id` ile bağlanmaz; bağ yayın anında kurulur.
   Böylece 2,8 milyon teklif `/teklifler` (yurt dışı) listesinde ve eşleşmemiş sayımlarda aynen kalır, fiyat/para
   birimi/zaman damgası değişmez, `offer` tablosunda WAL ve şişme oluşmaz (2,8 milyon `UPDATE` ve 9 indeks yazımı yok).
5. **Kalite kapısı ayrı, otomatik ve satır yazmayan sessizlikte** (`catalog_build gate`): kaynak teklif pasif/yok,
   fiyat yok, görsel/başlık yok, başka ürüne bağlı, 7 gündür görülmemiş → `held` (+ `hold_reason`); aksi `ready`.
   TRY dışı teklif **kalite sorunu değil, bekleyen karardır** (0113/0114): `draft` kalır, satır yazılmaz,
   `--allow-foreign` ile geçer. (İlk ölçümde bunu `held` yapmak 2,5 milyon satırı yeniden yazdı: 4–6 dk, tablo şişmesi.)
6. **Yayın açık komut ve onaylı** (`publish --limit N --confirm`): kaynak teklif yeniden okunup politika yeniden
   uygulanır, `offer.product_id` bağlanır, başlık/görsel tazelenir, `match_decision_log` (`link`, `source_listing`) ve
   `search_outbox` yazılır, özet yenilenir. TRY dışı ürün ayrıca `--allow-foreign` **ve**
   `CATALOG_PUBLISH_FOREIGN_APPROVED=true` ister. `unpublish` bağı ve durumu geri alır; teklif/fiyata dokunmaz.
7. **Para birimi.** Ürün fiyat özeti (`min_price`, `max_price`, `offer_count`, `in_stock_count`), arama `best_offer` ve
   `compareMerchants` **yalnızca TRY** teklifi sayar. USD tutar kuruş gibi okunup özeti kirletmez (0113 uyarısı).
   Yayınlanmış üründe TRY dışı teklif ürün sayfasında "Yurt dışı teklifi" bölümünde, **kendi para birimiyle, fiyatın
   gözlendiği zamanla** (`price_point`), TCMB kuru varsa kur tarihiyle yaklaşık TL olarak gösterilir; fiyat
   sıralamasına girmez, kargo/gümrük belirsizliği yazar.
8. **Uydurma yok.** Marka, kategori, GTIN, renk, beden, varyant, kargo, stok ve fiyat özeti boş kalır. `infer_brand`
   ve `extract_color` kullanılmaz (AliExpress başlıkları anahtar kelime yığınıdır; "Apple … kılıf" Apple ürünü olmaz).
9. **Uygunsuz kayıtlar ayrı tutulur.** Geçerli başlığı/https görseli/fiyatı olmayan, kimliği doğrulanamayan, pasif,
   yer tutucu ya da tekrarlı başlıklı teklifler ürüne **dönüştürülmez**; `offer` olarak kalır ve nedeni
   `catalog_build_state.skipped` içinde sayılır (`audit` bunu hiçbir şey yazmadan raporlar).
10. **Site haritası.** Taslak/hazır/bekleyen ürün haritaya girmez (`ELIGIBILITY_CONDITION`'a `published` eklendi).
    Mevcut kurallar (kategori `is_discoverable`, ≥2 mağaza ya da 14 gün geçmiş, görsel+başlık) aynen sürer;
    kategorisiz AliExpress ürünü bu yüzden zaten giremez.
11. **İdempotent, durdurulabilir, kaldığı yerden.** Parti + kontrol noktası (`catalog_build_state.last_offer_id`) tek
    işlemde; `kill -9` sonrası aynı komut sürer (ölçüldü). `--rescan` yeniden tarar, yeni ürün üretmez.
    Toplu işlem: `unnest` ile tek `INSERT … ON CONFLICT DO NOTHING`; slug çakışırsa parti satır satır yeniden denenir
    (`slug_conflict` sayılır, ölümcül değil).
12. **Indeks maliyeti.** `product_title_trgm` ve `product_title_fold_trgm` (GIN) yalnızca `published` ürünleri kapsar
    (milyonlarca taslağı indekslemek GB'lar tutardı; ölçülen boyut 16 kB). Sorgular aynı koşulu taşır.

## Hepsiburada (#154, keşif defteri) ile uyum

- Çakışma yok: #154 `collection_*` ve `catalog_discovery` tablolarına (0073) dokunur, bu karar `product` ve
  `catalog_build_state`'e (0074). Numaralar farklı; 0073 #154'e bırakıldı (çalıştırıcı sırasız da uygular).
- Aynı kimlik anahtarı kullanılabilir: `catalog_discovery(source='hepsiburada', external_id=<-pm- kodu>)` ↔
  `product(source_merchant_id=<hepsiburada>, source_external_id=<kod>)`. Fiyatsız keşif satırı `source_offer_id`
  olmadan taslak ürün olabilir; kalite kapısı fiyatı `offer`'dan okuduğu için fiyatsız ürün `held(source_offer_missing)`
  kalır, yani yayına çıkamaz. Hepsiburada için yeni bir `SourcePolicy` kaydı yeterlidir (`catalog_build/policy.py`).
- Dosya düzeyinde birleşme riski: ikisi de `docs/schema.sql` ve `packages/db/migrations/README.md` sonuna ekler;
  çözümü mekaniktir. #149 de 0072 kullanıyor (0072 `main`'de başka bir dosyayla alındı); o PR yeniden numaralanmalı.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Çözümleyiciyi USD'ye açıp `python -m resolve --limit 5000` ile ürün üretmek | TRY dışı fiyat TL gibi görünürdü (0113); teklif başına trigram/ANN sorgusu 2,8 milyonda kullanılamaz; başlık benzerliği kimlik değil (0119) |
| Taslak ürünü hemen `offer.product_id`'ye bağlamak | 2,8 milyon `UPDATE` (WAL, şişme, 9 indeks) ve `/teklifler`, eşleşmemiş sayımlar, kalite panelinin sessizce değişmesi |
| Ayrı `source_product` tablosu | 0111 bilinçli reddetti: aynı kavram iki tabloda kayar; ürün sayfası, arama, fiyat özeti `product`'a bağlı |
| `held` yapmak (yurt dışı) | Ölçüldü: ilk kapı koşusunda 2,5 milyon satır yeniden yazıldı (4–6 dk, WAL, şişme); karar bekleyen ürün hata değil |
| Başlık/görselden marka, renk, kategori çıkarmak | Uydurma veri; AliExpress başlıkları güvenilmez (kural: eksik bilgi uydurulmaz) |
| Tüm ürünleri otomatik yayınlamak | Kalite ve yurt dışı gösterim kararı ayrı; yayın açık komut ve onay ister |
| Her `link` için `match_decision_log` satırı (2,8 milyon) | Taslak bağsız; kayıt yayın anında yazılır (yayınlanan kadar) |

## Ölçüm (yerel PostgreSQL 16, sentetik 2,8 milyon AliExpress teklifi; üretim ölçülmedi)

Veri: 2,8 milyon AliExpress biçimli teklif (USD, 16 haneli kimlik, `offer` tablosu 1,5 GB). Oranlar sentetiktir
(%9,2 elenir: 70 bin pasif, 50 bin görselsiz, 43 bin http/geçersiz görsel, 36 bin fiyatsız, 30 bin yer tutucu başlık,
28 bin kısa başlık); **gerçek uygunluk üretimde `audit` ile ölçülür**.

| İş | Süre / maliyet |
| --- | --- |
| `audit` (yalnız okur, 2,8 milyon) | 87 sn |
| `build` (2,54 milyon taslak ürün) | ~13 bin teklif/sn; toplam ~3,5 dk (100 bin: 8 sn) |
| `kill -9` ortasında + devam | Kontrol noktası ve ürün sayısı birebir tutarlı (470 bin taranan / 426.667 ürün); devam eden koşu 3 dk 2 sn |
| `build --rescan` (idempotenslik) | 2 dk 21 sn, **0 yeni ürün**, 2.541.815 `var`; ürün sayısı değişmedi |
| `gate` kararlı durum (hepsi USD) | 44 sn, **0 satır yazıldı**, 2.541.815 `yurt_disi_karar_bekliyor` |
| `gate --allow-foreign` + `publish` 500 | saniyeler; 500 teklif bağlandı, diğer 2,8 milyon teklif değişmedi |
| Disk (2,54 milyon ürün) | tablo 702 MB + indeks 793 MB = 1,5 GB (~590 B/ürün); `product_slug_key` 358 MB, kaynak anahtarı 121 MB, `product_unpublished_idx` 76 MB; başlık GIN'leri 16 kB |
| WAL | ~1,4 KB/ürün (272 bin ürün için 375 MB) → 2,54 milyon için ~3,5 GB |

2,54 milyon taslak ürün varken mevcut yüzeyler (hepsi 4 sn zaman aşımı altında): kalite raporu bütünü 0,6–1,7 sn
(0 "Bilinmiyor"), yönetim ürün listesi 13 ms, kaynak kimliğiyle arama 230 ms, herkese açık arama 29 ms,
taslak ürün sayfası 404 (8 ms), site haritası parçası 12 ms.

Gerçek veriyle ilgili bilinenler (üretim kalite paneli, 15 Ekim 2026): 2.799.204 aktif teklif, tamamı son 24 saatte
görülmüş, görselsiz aktif teklif 0, stoksuz 0, GTIN/marka/MPN yok (besleme şeması, 0112). Yani kaynak kimliği
bakımından hepsi ürün adayıdır; **kesin kimlik (GTIN/marka+MPN) bakımından 2.799.204 teklifin tamamı yoksundur** ve
bu yüzden mağazalar arası eşleşme olarak sayılmaz.

## Sonuçlar ve riskler

- Üretimde `audit` (yalnız okur, ~1,5 dk) çalıştırılmadan ve ilk 100 bin teklifle `build --max-batches 20`
  denenmeden tam aktarım başlatılmamalı. Migration 0074 `product` boşken uygulanmalı (iki GIN indeksi yeniden kurulur).
- Yayınlanmış ürünün `offer_count` yalnızca TRY mağaza sayar: USD-only ürün aramada/kartta çıkmaz (yalnız ürün sayfası ve
  `/teklifler`'de). Yurt dışı ürünlerin arama sıralamasındaki yeri açık bir ürün kararıdır (0113).
- Taslak başlığı aktarım anının anlık görüntüsüdür; yayın anında yeniden okunur. Kaynak teklif başlığı sonradan değişirse
  taslak güncellenmez (yayından önce tazelenir).
- `product_unpublished_idx` (76 MB / 2,5 milyon) kapı ve durum taramalarını destekler; ilk kapı koşusu sonrası
  `VACUUM (ANALYZE) product` önerilir.
