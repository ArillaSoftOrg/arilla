# 0012 — Connector arayüzü: taşıma/eşleme ayrımı ve config güdümlü alan eşlemesi

**Tarih:** 2026-09 · **Durum:** kabul edildi

## Karar

B1 toplama katmanı üç karara göre kuruldu:

1. **Taşıma ile eşleme ayrılır.** Connector yalnızca `RawRecord` akıtır
   (`fetch() -> Iterator[RawRecord]`); alan adları kaynağa aittir.
   Normalizasyon ayrı bir katmandır ve üç taşımanın hepsinde aynı kodu
   çalıştırır.
2. **Alan eşlemesi `merchant.feed_config` içinden gelir.** Hiçbir
   sağlayıcının alan şeması koda gömülmez.
3. **`full_dump` olmadan pasifleştirme yok.** Feed'de görünmeyen teklifler
   yalnızca `feed_config.full_dump = true` ise ve koşu `success` bittiyse
   `is_active = false` yapılır.

## Gerekçe

**Neden üç katman, tek `parse_feed()` değil.** Üç kaynak biçimi ayrıştırmada
değil taşımada ayrışıyor: XML tek GET ile tam döküm verir, REST auth +
sayfalama + oran sınırı ister ve 100 sayfanın 40'ında ölebilir, ağ dökümü
gzip'li büyük bir dosyayı akıtır. `fetch()` iterator olduğu için üçü de belleğe
sığmadan işlenir ve REST'in kısmi ölümü `ingest_run.status = 'partial'` ile
karşılanır.

**Neden config güdümlü eşleme.** Bu görev gerçek bir merchant anlaşması
olmadan yapıldı: hiçbir mağazayla sözleşme yok, Admitad'a henüz
başvurulmadı. "Admitad şeması" diye alan adları yazmak, doğrulanmamış bir
varsayımı koda gömmek olurdu — ilk gerçek döküm geldiğinde sessizce yanlış
eşleşir, üstelik yanlışlık veri kaybı olarak değil, *sessiz yanlış veri*
olarak görünürdü. Eşleme config'te olduğunda gerçek döküm bir `feed_config`
satırıdır, kod değişikliği değil. `merchant.feed_config` (JSONB) bu iş için
zaten şemada vardı.

Aynı gerekçeyle REST sayfalaması iki **jenerik** biçim uygular (sayfa numarası
ve cursor); bunlar bir satıcının API tasarımı değil, sektörün iki yaygın
kalıbı.

**Neden `full_dump` şartı.** Bir delta feed'i veya yarım inmiş bir dosyayı tam
döküm sanıp katalogu pasifleştirmek, kurtarılması en pahalı hatalardan biri:
sessizdir, tüm merchant'ı kapsar ve fark edilmesi günler alır. Varsayılan
`false` olduğu için bir merchant'ı pasifleştirilebilir yapmak bilinçli bir
adımdır.

**Anahtarlar config'te durmaz.** `auth` bloğu okunacak ortam değişkeninin
**adını** taşır, değerini değil (`docs/ops.md`). Değişken boşsa koşu başlamaz.

## Reddedilen alternatifler

- **Merchant başına elle yazılmış connector sınıfı.** İlk üç merchant'ta hızlı,
  otuzuncuda otuz dosya bakımı. Farklılıklar veri değil kod haline gelirdi.
- **Public dokümandan Admitad alan adlarını çıkarmak.** Kullanıcı tarafından
  açıkça reddedildi: gerçek döküm eline geçene kadar tahmin yapılmayacak.
- **lxml.** `iterparse` stdlib'de var ve akış için yeterli; derleme gerektiren
  bir bağımlılık eklemeye değmedi.
- **`price_point` için "değiştiyse yaz".** `architecture.md` §1 tersini
  söylüyor: fiyat değişmese bile satır yazılır, sürekliliğin kendisi veridir.

## Sonucu

- `collect/sources/network_dump.py` yalnızca döküm mekaniği içerir: indirme,
  gzip, karakter kodlaması, ayraç, akıtma. Alan adı yoktur.
- `variant_stock_event` yazılmadan önce mevcut durum okunur; yalnızca değişimde
  satır eklenir. İlk görülme de bir değişimdir.
- Toplama katmanı `offer.product_id`'ye **dokunmaz** — eşleştirme B4'ün işi.
- Python tarafı `arilla_app` rolüyle bağlanır; `price_point` üzerinde UPDATE
  denemesi veritabanı tarafından reddedilir (`0011`).
