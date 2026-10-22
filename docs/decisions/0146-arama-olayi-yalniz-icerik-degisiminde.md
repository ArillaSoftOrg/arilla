# 0146 — Arama olayı (search_outbox) yalnızca içerik değişiminde yazılır

**Tarih:** 22 Ekim 2026
**Durum:** Önerildi (PR). 0136 Ek A'daki **C seçeneğini** uygular ve genişletir. Migration yok.
**Bağlam:** 0111 (besleme modeli), 0112/0114 (artımlı senkronizasyon, yazma ölçümleri), 0136
(tüketicisiz outbox), 0134 (WAL geri basıncı).

## Sorun

Üretimde `search_outbox` 5,57 M satır / ~711 MB; yaklaşık yarısı `feed_insert`, yarısı
`source_listing_published`, işlenmiş satır yok, tüketici yok (0136). Günlük AliExpress fiyat
tazelemesi (PR #203) açılırsa `feeds/sync.py` teklifin **parmak izi** değiştiği her durumda bir
`feed_change` satırı yazar. AliExpress parmak izi yalnız fiyatı değil `discount` ve `commissionRate`
parametrelerini, eski fiyatı, stoku ve görsel listesini de içerir; yani fiyat, indirim ya da komisyon
oynadığında satır arama için **değişmemiş** olsa bile olay yazılır. 2,8 M teklifte bu, tam bir
senkronizasyonda en kötü durumda gün başına milyonlarca satır (~140 B/satır) ve onun WAL'ı demektir;
kuyruğun okuyanı yok, yani büyüme hiçbir iş görmeyen bir yazımdır.

## Kod incelemesi (özet)

- Yazanlar: `catalog_build/publish.py` (`source_listing_published`, ürün başına bir kez),
  `feeds/sync.py` MERGE'ü (`feed_insert`, `feed_reactivate`, `feed_change`) ve SWEEP (`feed_missing`,
  `op=delete`). Başka yazan yok. Okuyan yok (0136).
- Arama (`/ara`, `/sohbet`, link) outbox'a bağlı değil; `product`/`offer` tablolarını ve yazımla aynı
  işlemde güncellenen trigram indekslerini okur. Bir outbox satırının yokluğu aramayı etkilemez.
- Fiyat değişiminin **gerçek** kaydı `price_point` (yalnız INSERT) ve `offer.current_price`'tır;
  outbox satırı fiyatı taşımaz, yalnızca "bu teklife bak" der. Fiyat takibi (geçmiş, grafikler, uyarı)
  zaten `price_point` üzerindendir.

## Karar

`feed_change` yalnızca **arama ve indeksin gördüğü içerik** değiştiğinde yazılır:
`title_raw`, `brand_raw`, `category_raw`, kapak görseli (`image_url`). Aşağıdakiler olay **yazmaz**:
fiyat, eski fiyat, stok, indirim, komisyon, galeri ek görselleri, takip bağlantısı.

Korunanlar (değişmedi, testli):

| Olay | Ne zaman |
| --- | --- |
| `feed_insert` | Yeni teklif |
| `feed_reactivate` | Pasif teklif kaynakta geri geldi (fiyat aynı olsa bile) |
| `feed_missing` (`delete`) | Teklif beslemeden düştü, bekleme süresi doldu, pasifleşti |
| `feed_change` | Başlık / marka / kategori / kapak görseli değişti |
| `source_listing_published` | Yayınlama yolu (`publish.py`), dokunulmadı |

Teklif satırı yazımı, `price_point` kuralı, parmak izi, bayat embedding silme ve ürün fiyat özeti
aynen kalır. Parmak izi **değiştirilmedi**: değiştirmek, dağıtımdan sonraki ilk koşuda 2,8 M satırın
tamamını yeniden yazdırırdı (13 indeksli `offer`, HOT dışı güncelleme; tam sayfa WAL).

## Gelecekteki tüketicilere etkisi

- İlk doldurma (harici arama motoru): tablolardan okunur (0136); değişmez.
- Artımlı içerik: `feed_change` hâlâ başlık/marka/kategori/görsel için vardır.
- Artımlı **fiyat/stok** gerekirse kaynağı outbox değil `price_point` (`observed_at` ile sıralı,
  değiştirilemez, her yeni fiyat/stok/eski fiyatta bir satır) ya da `offer.last_changed_at` olur.
  Bir fiyat-filtreli indeks bunu `price_point`'tan artımlı okuyabilir; outbox'tan bekleme.
  Bu yönde bir tüketici kurulursa olay tipi ayrı (ör. `feed_price`) ve sınırlı saklama ile eklenir;
  bugün okuyanı olmayan bir olayı yazmaya devam etmek bu ihtiyacı çözmez, yalnız şişirir.
- Kaldırılan şey olay **tipi** değil, "fiyat değişti → arama içeriği değişti" yanlış eşlemesidir.

## Mevcut 5,57 M satır

Silinmez, işlenmiş işaretlenmez (0136 madde 3 korunur). Önerilen yol bu kararın dışındadır:

1. Bu karar yayına çıkınca büyüme ölçülür (`pnpm db:health` outbox bölümü; hafif denetim betiği).
2. Saklama ayrı ve onaylı bir karardır: en ucuz güvenli seçenek `feed_insert` satırlarının
   (kuyruğun yarısı) ve `source_listing_published` satırlarının ilk doldurma tamamlandıktan sonra
   varlık başına sıkıştırılmasıdır (0136 seçenek B), parti parti ve geri alınabilir yedekle.
   Zaman bazlı silme (E), harici arama motoru ilk doldurmayı tablolardan bitirmeden uygulanmaz.
3. Bölümleme (D) migration ve tablo yeniden kurulumu gerektirir; harici motor kararıyla birlikte.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Parmak izinden `discount`/`commissionRate` çıkarmak | Dağıtım sonrası ilk koşuda tüm 2,8 M satır yeniden yazılır (WAL/şişme); ayrı, ölçülmüş bir kaydırma gerekir |
| Fiyat değişiminde `offer` satırını yazmamak | Okuma yolu (`current_price`, arama sıralaması) bayatlar |
| `feed_change`'i tümüyle kaldırmak | Başlık/marka/kategori/görsel değişimi indekse ulaşmaz |
| Outbox'ı kapatmak / satırları "işlendi" yapmak | 0136 reddetti: yayın doğrulaması bozulur, veri kaybı |
| Mevcut satırları silmek | Geri alınamaz; saklama kararı ayrı |

## Sınırlar

- Yerel ölçüm (sentetik, 5.000 AliExpress benzeri teklifin tümünde fiyat değişimi, 1.000'lik parça):
  eski kod 5.000 `search_outbox` satırı + 14,06 MB WAL, yeni kod 0 satır + 12,86 MB WAL. Fark
  ≈ 240 B/değişen teklif (~%8,5 WAL); kuyruk büyümesi (~140 B/satır) tümüyle kalkar. Doğrusal
  ölçeklenirse 2,8 M değişen teklifte ≈ 0,67 GB WAL ve ≈ 0,4 GB tablo/indeks büyümesi tasarrufu.
  **Asıl maliyet yine de `offer` satırı güncellemesidir** (~2,4 KB WAL/teklif: 13 indeksli, HOT
  dışı güncelleme + `price_point`); tam bir gün 2,8 M fiyat değişimi ≈ 7 GB WAL demektir. Gerçek
  fiyat-değişim oranı bilinmiyor; ilk iki günlük koşuda `ingest_run.price_points_written` ve
  `search_outbox` artışı birlikte izlenir.
- `offer` satırı yine fiyat/indirim/komisyon değişiminde yeniden yazılır (13 indeks). Bu satır
  yazımını azaltmak ayrı iştir: önce gerçek değişim oranı ölçülmeli (0114).
- Galeri ek görseli yalnız değiştiğinde olay yoktur; arama kapak görselini kullanır.
