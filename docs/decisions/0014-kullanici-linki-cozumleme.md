# 0014 — Kullanıcı linki çözümleme: kimlik, bilinmeyen mağaza, robots ve çıkarım sırası

**Tarih:** 2026-09 · **Durum:** kabul edildi

## Karar

Katman 2 (kullanıcı tetikli tek URL çözümleme) dört karara göre kuruldu:

1. **`external_id` normalize URL'den türetilir.** İzleme parametreleri
   (`utm_*`, `gclid`, `fbclid`, `ref`, …) atılır, `www.` düşer, fragment
   düşer, kalan parametreler sıralanır. Kalan yol+sorgu `external_id` olur.
2. **Bilinmeyen alan adı otomatik `merchant` açar**
   (`source_type = 'user_discovered'`, `affiliate_status = 'none'`).
3. **`robots.txt` atlatılmaz.** İzin yoksa çözümleme reddedilir ve
   kataloğa hiçbir şey yazılmaz. Kendimizi tanıtan bir user-agent kullanılır.
4. **Çıkarım üç katmanlı ve sıralıdır:** JSON-LD → OpenGraph/microdata →
   HTML sezgisel. Üçüncü katmanın çıktısı `attributes_raw.low_confidence`
   ile işaretlenir.

## Gerekçe

**Neden URL'den türetilen kimlik.** Feed'de merchant'ın kendi `external_id`'si
vardı; yapıştırılan bir linkte yok. Kimliği URL'den türetmek
`(merchant_id, external_id)` unique kısıtını Katman 2'de de çalıştırır — yani
idempotentlik iki katmanda aynı mekanizmayla sağlanır, ikinci bir kural
gerekmez. İzleme parametrelerini atmak zorunluydu: aynı ürün Instagram'dan ve
WhatsApp'tan farklı `utm` ekleriyle paylaşılır, temizlenmezse her paylaşım
kataloğa yeni bir kayıt sokardı.

**Neden otomatik merchant.** `architecture.md`: "katalog talebe göre büyür."
Tanımadığımız bir mağazadan gelen link o mağazayı kataloğa sokmazsa,
`routes.md`'nin "bilinmeyen ürün akışı ilk günden çalışmalıdır" kuralı
tutmaz. `affiliate_status` `none` başlar: komisyon ilişkisi ayrı bir iştir ve
otomatik varsayılamaz.

**Neden robots mutlak.** `docs/decisions/0004` toplu kazımayı tamamen dışarıda
bırakıyor. Kullanıcı tetikli tek URL çözümlemesinin meşru kalması, sitenin
açıkça yazdığı kurala uymasına bağlı. Atlatma yolu bırakmak — "yine de dene"
gibi bir bayrak — bu ayrımı anlamsız kılardı. User-agent'ın bizi tanıtması da
aynı sebeple: bir merchant bizi bilinçli olarak engelleyebilmeli ya da izin
verebilmeli.

**Neden üç katman ve neden sonuncusu işaretli.** JSON-LD yayınlanmış bir
standarttır; alan adları tahmin değil sözleşmedir (B1'de ağ dökümü şemasını
uydurmayı reddetme gerekçesinin aynısı burada tersine çalışıyor: schema.org
gerçek bir standart olduğu için alan adlarını *bilebiliriz*). Sezgisel katman
ise tahmindir — bu yüzden çıktısı kalıcı olarak düşük güvenli işaretlenir.
**Yanlış fiyat göstermek, fiyat göstermemekten kötüdür.**

**Fiyat biçimi katmana bağlıdır.** JSON-LD ve OpenGraph fiyatları şartname
gereği nokta ondalıklıdır (`1899.90`); sezgisel katman ise sayfanın *görünen*
metnini okur ve o metin Türkçe biçimlidir (`1.249,50 TL`). Tek bir ayrıştırıcı
kullanmak 1249,50 TL'yi 1,25 TL'ye çevirirdi — bu hata uygulama sırasında
gerçekten oluştu ve test tarafından yakalandı.

## Reddedilen alternatifler

- **URL'yi olduğu gibi `external_id` yapmak.** Her paylaşım varyantı yeni bir
  kayıt üretirdi; katalog izleme parametreleriyle şişerdi.
- **Bilinmeyen mağazayı reddetmek.** En kontrollü seçenek, ama kataloğun
  talebe göre büyümesini engeller ve paylaşılan linklerin önemli bir kısmını
  ölü uca sokar.
- **Bilinmeyen mağazayı pasif açmak.** Kullanıcı yapıştırdığı linkin
  sonucunu hemen göremezdi; "ilk günden çalışmalıdır" kuralıyla çelişir.
- **`beautifulsoup4` / `lxml`.** Stdlib `html.parser` script ve meta içeriği
  çekmeye yetiyor; B1'de reddedilen bağımlılık burada da eklenmedi.
- **Beden varyantlarını sayfadan çıkarmak.** JSON-LD'de güvenilir biçimde
  bulunmuyor; uydurulmuş bir beden listesi yanlış "senin bedenin var"
  cevabına yol açardı. `user_link` teklifleri varyantsız yazılır.

## Sonucu

- Fiyat rotasyonu `python -m collect.link --refresh` ile linki **yeniden
  çözümleyerek** yürür; `user_discovered` merchant'ın feed'i yoktur.
- Yenileme toplu iş olduğu için merchant başına `ingest_run` yazar. Tek bir
  kullanıcı çözümlemesi yazmaz: sonucu doğrudan kullanıcıya dönen eşzamanlı
  bir işlemdir ve her yapıştırma için bir koşu satırı hem tabloyu şişirir hem
  `docs/ops.md`'deki "aynı merchant 2 kez üst üste başarısız" uyarısını
  yanlış tetiklerdi.
- `offer` tablosunda `gtin` kolonu **yoktur** (barkod kanonik `product`
  üzerindedir); kaynaktan gelen barkod B4 eşleştirmesi için
  `attributes_raw.gtin` içinde saklanır.
