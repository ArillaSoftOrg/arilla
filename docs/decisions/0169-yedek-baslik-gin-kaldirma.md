# 0169 — Yayın yazımını yavaşlatan yedek başlık GIN'i (`product_title_fold_trgm`) kaldırılır

## Karar

1. **Yönetim katalog başlık araması bölüm kollarına taşınır.** `admin/catalog.ts`
   `queryCondition`, başlık eşleşmesini `offer_count > 0` ve `offer_count = 0` olmak üzere iki
   kolla yazar. Bunlar `product_title_fold_try_trgm` ve `product_title_fold_foreign_trgm`
   (0083, karar 0129) kısmi GIN'lerinin yüklemidir; planlayıcı `BitmapOr` kurar. İki bölüm
   birlikte tüm yayındaki ürünleri kapsar (`offer_count` bir sayımdır; ana arama
   `text-match.ts` `PARTITIONS` aynı varsayımla çalışıyor).
2. **Ardından** (ayrı PR, kod yayında olduktan sonra) migration `0104`
   `product_title_fold_trgm`'i `DROP INDEX CONCURRENTLY` ile kaldırır. Sıra bilerek ayrıdır:
   `main`'e giren migration kod dağıtımından önce çalışır; sıra tersine dönerse yönetim araması
   seq scan'e düşer.
3. Kaldırılmayanlar: `product_title_trgm` (ham başlık; `services/ingest/resolve/candidates.py`
   `%` ile kullanıyor) ve iki bölüm indeksi.

## Gerekçe (laboratuvar ölçümü)

Kurulum: PostgreSQL 16 + pgvector, tüm migration'lar, prod ayarları (`wal_compression=on`,
`max_wal_size=4GB`, `shared_buffers=384MB`). 200 bin yayında ürün, 320 bin `ready`
(300 bin AliExpress benzeri USD + araya karışmış 20 bin başka kaynak). Her koşu temiz kopyada,
`CHECKPOINT` sonrası, 60.000 ürün, parti 500, `merchant_id` süzgeçli.

Üretimle uyum: laboratuvar tabanı **21,1 KB WAL/ürün**; prod'daki 11–19 MB/sn ÷ ~830 ürün/sn
≈ 13–23 KB/ürün.

| | taban | indeks kaldırılmış |
| --- | --- | --- |
| WAL / ürün | 21.065 B (3 koşuda aynı) | 13.840–15.430 B (**−%27…−%34**) |
| `UPDATE product` parti süresi (500) | 150 / 195 / 198 ms | 91 / 109 / 116 ms (**−%41 medyan**) |
| `SELECT_READY` (sıcak) | 7,5 ms | değişmedi |

Duvar saati verimi bu laboratuvarda yorumlanamaz: Windows Docker diskinde COMMIT 36–110 ms
oynuyor (taban 1.449–2.045, indeksiz 1.658–2.283 ürün/sn, aralıklar çakışıyor). Güvenilir olan
deterministik ölçüler: WAL/ürün ve ifade süresi. Üretim arşiv hızıyla sınırlıysa
(14–21 MB/sn) WAL/ürün'deki −%27…−%34, aynı arşivde ≈ +%37…+%52 ürün/sn demektir (çıkarım,
ölçüm değil).

Neden bu indeks: her yayınlanan ürün üç GIN'e girer (`title_trgm`, `fold_trgm` ve
bölümlerden biri). `fold_trgm`, bölümlerin birleşimiyle aynı ifade ve aynı satırlar; yalnızca
yazma maliyeti üretir. GIN girişi hem WAL hem ifade değerlendirmesi (`lower(translate())` +
trigram çıkarımı) demektir; bu yüzden süre WAL'den fazla düşer.

### Arama etkisi

| sorgu | önce | sonra |
| --- | --- | --- |
| yönetim başlık araması, tipik kelime (5 örnek) | 7–24 ms (`fold_trgm`) | 6–18 ms (`try`+`foreign`, BitmapOr) |
| yönetim, **eski sorgu** indeks kalkınca | 13 ms | 584 ms (seq scan) — bu yüzden sıra |
| yönetim, aşırı yaygın 4 harfli kelime | 122 ms (seq scan) | 202 ms (seq scan; ifade iki kolda iki kez) |
| bağlantı/web arama (`offer_count > 0 AND %`) | 24,8 ms | 21,5 ms (zaten `try` indeksini kullanıyordu) |

Herkese açık arama (`text-match.ts`) ve bağlantı/web araması bu indeksi zaten kullanmıyordu.
Tek kullanıcı yönetim aramasıydı. Aşırı yaygın kelimede seq scan her iki biçimde de olur
(yönetim sorguları zaman aşımlıdır); kol çoğalması ifade maliyetini ≈ 1,6× yapar.

## Geri alma

Kod: PR geri alınır, hiçbir şema bağımlılığı yoktur (bölüm indeksleri 0083'ten beri var).
İndeks: `CREATE INDEX CONCURRENTLY product_title_fold_trgm ...` (migration yorumunda tam
ifade). Yazımları kilitlemez; 10 M yayında üründe dakikalar–saatler sürer, bu sürede yönetim
araması yavaş kalır ama herkese açık arama etkilenmez.

## Reddedilen / ölçülüp bırakılan

- **Parti büyüklüğü 500 → 2000:** satır başına `UPDATE` süresi ve WAL/ürün değişmedi (0,23
  ms/ürün; 13,8–15,4 KB). Yalnızca COMMIT sayısını azaltır; WAL geri basıncı (0134) parti
  granülerliğine bağlı, bu yüzden varsayılan değişmedi.
- **HOT güncelleme:** mümkün değil. `publication_state`, `offer_count`, `min_price`, `title`
  indekslenmiş/kısmi yüklem kolonlarıdır ve yayın bunları değiştirir.
- **`gin_pending_list_limit` 16 MB:** WAL/ürün −%15 ama UPDATE süresi değişmedi ve aramada
  bekleme listesi taraması maliyeti getirir; kazanç indeks kaldırmanın yarısı.
- **`product_title_trgm`'i `offer_count > 0` ile kısmi yapmak:** AliExpress yayınında bir GIN
  daha tasarruf eder ama çözümleyicinin (resolve) yurt dışı ürünleri aday görmesini değiştirir;
  ürün kararı gerektirir, bu kararın kapsamı dışında.
- **`SELECT_READY` değişikliği:** laboratuvarda sıcak planlar sağlıklı (1,7–10 ms; özel ve genel
  plan aynı). Prod'daki ~788 ms soğuk okuma bekleyişidir (0135). Tek gözlem: kürsör 0'dan
  başlarken (süreç yeniden başlatma) sorgu `product_pkey`'de yayındaki tüm satırları süzerek
  yürür (lab: 264 bin satır, 40–90 ms; 10 M ürün ölçeğinde saniyeler). Çözüm adayı: kürsörü
  `min(id)` of `ready` ile başlatmak; yalnızca ilk partiyi etkilediği için bu kararda yok.
