# 0208 — "En Uygun Fiyat" aday sınırı: ölçüm ve öneri (uygulanmadı)

**Tarih:** 15 Kasım 2026 · **Durum:** öneri; kod DEĞİŞMEDİ · **İlgili:** karar 0129 (aday sınırı),
0197 (aksesuar kademesi), 0202/0205 (`lowest_price`)

## Sorun

`lowest_price` kartta gösterilen çevrilmiş TL fiyatına göre sıralar (0205) ama sıralama aday seçiminden
SONRA yapılır. Aday dalları `SELECT p.id FROM product p WHERE ... LIMIT 1000` biçimindedir, `ORDER BY`
yoktur: dal fiziksel (ctid) sırayla ilk 1000 eşleşmede durur. Eşleşen ürün 1000'i aşarsa en ucuz ürün
adaya hiç girmeyebilir; katalog genelinde "en ucuz" garantisi yoktur.

## Ölçüm (15 Kas, üretim salt okunur, gerçek sorgu SQL'i, 32 sonda sorgusu, `lowest_price`, aday sınırı 1000)

- 32 sorgunun **25'inde aday sınırı doldu** (`cand_meta.capped`); dolmayanlar: "mutfak tartısı",
  "silikon kalıp", "saç maşası" (bulanık, 96), "mekanik klavye", "uzaktan kumandalı araba", "aksiyon
  kamerası", kontrol sorgusu. Sınır, gerçekçi bir baş isim için kural, istisna değil.
- Sınırı 1000'den 5000'e çıkarınca kartın en ucuz fiyatı (kuruş; sınır 1000 → 5000): telefon kılıfı
  19.900 → 2.665; akıllı saat 5.380 → 402; powerbank 21.119 → 402; kablosuz mouse 40.277 → 905; makyaj
  fırçası 4.877 → 603; cüzdan 4.877 → 3.922; drone 38.818 → 3.922; ekran koruyucu 3.520 → 3.520.
  Yani sınır içi "en ucuz", gerçek en ucuzdan 1,0 ile 13 kat pahalı.
- Ancak genişleyen havuzun en ucuzları neredeyse hep alakasızdır (powerbank: LED ışık, 18650 pil yuvası;
  akıllı saat: ekran modülü, kayış pimi; mouse: tuş anahtarı): metin kapısı tek baş isim eşleşince
  geçirir (`npass` ≈ `ncand`). Garantili "en ucuz" kapıdaki gevşekliği büyütür; 0205'teki alaka uyarısı
  burada belirleyicidir.
- Gecikme sınırla doğrusal artar (aday başına üretimde yaklaşık 0,5-2 ms; kapı, görünürlük alt sorgusu,
  teklif seçimi): 1000 aday 0,3-2,4 sn (bazıları 4-18 sn, bu ayrı inceleme konusu), 5000 aday 3-10 sn.
  Bu, sohbet yolunun 4 sn / `/sohbet` aramasının 5 sn bütçesinin dışındadır.
- Baş isim eşleşme sayıları (TRY'siz bölüm, kök regex): powerbank 2,5 bin, çanta 2,6 bin, tripod 15 bin,
  drone 30 bin, mouse 51 bin. Tam fiyat sıralı geçiş O(eşleşme) satırdır.

## Stratejiler (yerel 1,5 milyon ürün + üretim ölçeği ekstrapolasyonu)

| Strateji | En ucuz garantisi | Kapı/aksesuar/stok korunur | Maliyet |
|---|---|---|---|
| a) mevcut | yok (planlı en ucuz kaçtı: sınır 1000, 150 bin eşleşme) | evet | 28 ms (aday sorgusu) |
| b) dalı `JOIN offer ... ORDER BY current_price LIMIT 1000` | tam (aday kümesi içinde en ucuz 1000) | evet (kapı sonra) | 150 bin eşleşmede 750 ms, 15 bin 120 ms (yerel, sıcak); üretim soğuk G/Ç ile kat kat fazla |
| c) mevcut + ikinci fiyat sıralı dal (birleşim) | tam; mevcut adaylar kaybolmaz | evet | b ile aynı, üstüne kapı 2000 aday |
| d) fiyat indeksi `offer(current_price) WHERE is_active ...` | planlayıcı kullanmadı (bitmap + `offer_product_idx` seçildi) | - | 13,8 milyon satıra indeks; ek kazanç yok |
| e) örneklemi 5-20 bin'e çıkarmak | garanti yok | evet | doğrusal; ölçüldü: 3-10 sn |

Yerelde başarısızlık kanıtlandı (150 bin "kilif" eşleşmesi, en ucuz olan fiziksel sırada sonda): sınır 1000
iken en ucuz ürün sonuçta yok, 200 bin sınırında 1. sırada.

## Karar

Kod değişikliği YAPILMADI. Gerekçe:

1. Doğru çözüm (b/c) her sorguda tüm eşleşmelerin ürün ve teklif satırlarını okur; üretim 13,8 milyon
   satırda ve zaten saniyeler süren aday sorgusunda gecikme bütçesini aşar, planlayıcı tahmini
   (pg_trgm sabit seçicilik) kırılgandır (0129).
2. Fiyat indeksi çözüm değildir (d): planlayıcı onu seçmedi; dolu tablo için üretimde indeks kurmak
   riskli (3,7 değil 13,8 milyon satır, WAL baskısı, karar 0185).
3. Tek başına garanti kullanıcıya zarar verir: gerçek en ucuz çoğunlukla alakasız parçadır. Önce alaka
   tabanı gerekir (aşağıda).

## Öneri (sıra önemli)

1. **Alaka tabanı (kod, migration yok):** `lowest_price` yalnızca baş isim kapısını geçmekle yetinmesin;
   ana ürün kademesine ek olarak kapı eşiği ya da kategori kısıtı ve yer tutucu fiyat tabanı
   (ürün başına en düşük USD tutarı) karar 0205'in "Sınırlar" bölümündeki gibi ölçümle (P@5/NDCG@10)
   belirlenmeli. Aday sınırı bundan sonra yeniden ölçülür.
2. **Aday sınırını fiyata bağlama** yalnızca (1) bittikten sonra ve ürün tablosunda fiyat sütunu varken:
   migration (yalnız `packages/db`, geriye uyumlu, sütun önce):

   ```sql
   -- 0208 önerisi (yazılmadı): yurt dışı en düşük fiyat, para birimi başına tek baskın birim
   ALTER TABLE product
     ADD COLUMN min_foreign_price bigint,
     ADD COLUMN min_foreign_currency char(3);
   -- Doldurma: refresh_product_aggregates / product_aggregate_values (0090) genişletilir;
   -- 13,8 milyon satır ARKA PLAN toplu işiyle (parti başına küçük UPDATE, WAL bütçesi
   -- decision 0185 içinde) doldurulur; indeks YOK (bitmap yolu ürün kolonunu zaten okur).
   ```

   Aday dalı: `... ORDER BY p.min_foreign_price NULLS LAST LIMIT 1000` ikinci dal olarak yalnız
   `lowest_price`te mevcut dallara BİRLEŞİR (c); teklif seçimi ve kapı değişmez. Para birimi
   karışıklığında (kur) ön eleme yaklaşıktır, nihai sıra yine `best_offer.current_price`tır. Üretimde
   %99,98 USD olduğundan tek para birimi sıralaması yeterli yaklaşıktır.
3. Geçiş: önce sütun + toplu doldurma dağıtılır, sonra sorgu (kural 14); sorgu dağıtılmadan önce
   `EXPLAIN` ile bitmap yolunun korunduğu doğrulanır ve üretim gecikmesi yeniden ölçülür.

## Yeniden üretme

Ölçüm betiği olarak `scoredCtes(query, 'lowest_price', false, undefined, limit, [])` SQL'i gerçek
parametrelerle salt okunur oturumda çalıştırıldı (`default_transaction_read_only=on`, 25 sn
`statement_timeout`; sözlük `lexicon` tablosundan okundu, marka/kategori dalı yok: aday sayıları
alt sınırdır). Yerel deney: pgvector/pg16, 1,5 milyon ürün ve teklif (USD), baş isimler %10, %1, %0,1
yoğunlukla; aday sınırı 1000 ve 200000.
