# 0128 — Affiliate dönüşümlerinin ağ raporundan aktarımı

## Karar

1. `conversion` tablosunu Python toplu işi `python -m affiliate conversions` yazar.
   İlk kaynak Admitad yayıncı API'sidir: `GET /statistics/actions/` (kapsam
   `statistics`), son 90 günün eylemleri, günlük VPS zamanlayıcısıyla
   (`arilla-affiliate-conversions`, 05:00 UTC). Şema değişmez; tablo 0007'den beri vardır.
2. İdempotent yazım: `external_order_id = "admitad:<action_id>"`, mevcut
   `(merchant_id, external_order_id)` benzersizliği üzerinden upsert. Aynı eylem tekrar
   gelirse yalnızca durum ya da tutar değiştiyse güncellenir ve `reconciled_at` yazılır.
   Bir kez bağlanan `click_id`/`creator_id` sonraki yanıtta boş gelse de korunur.
3. Program → merchant eşlemesi `feed_source (network = 'admitad', program_external_id)`
   üzerinden. Programa birden fazla merchant bağlıysa ya da hiç bağlı değilse eylem
   **atlanır**; yanlış merchant'a yazılmaz.
4. Attribution: `subid` geçerli bir UUID ise VE aynı merchant'ın teklifine ait bir
   `click` satırı varsa `click_id` bağlanır, `creator_id` o tıklamadan alınır. Aksi
   halde ikisi de boş kalır. Sahte attribution üretilmez.
5. Para: kuruş tamsayı, TRY. TRY dışı tutar, eylem tarihinden en fazla 7 gün önce
   yayınlanmış TCMB döviz **alış** kuruyla (`fx_rate`, karar 0113) çevrilir; kur yoksa
   eylem atlanır ve koşu `partial` olur.
6. Durum: `pending` → `pending`; `approved` / `approved_but_stalled` → `confirmed`
   (ödendiyse `paid`); `declined` → `cancelled`. Tanınmayan durum atlanır.
7. Kişisel veri yok: ağ yalnızca kendi eylem kimliğini, tutarı ve bizim tıklama
   kimliğimizi döndürür. Ham yanıt saklanmaz; koşu ayrıntısı yalnızca sayılardır.

## Doğrulanmamış varsayımlar

Keşif uçları gerçek API'de doğrulandı (0112); `statistics/actions` ucu **doğrulanmadı**.
Erişim ve alan adları ilk üretim koşusunda kontrol edilmeli:

- Uygulamaya `statistics` kapsamı verilmiş mi? Verilmemişse token isteği reddedilir ve
  koşu `failed` yazar.
- `action_date` saat dilimi. Belirtilmemişse UTC sayılır; gün sınırındaki eylemlerin
  kur seçimi bir gün kayabilir.
- Deeplink'e `subid = {click_id}` girilmiş mi (`merchant.deeplink_template`)?
  Girilmemişse dönüşümler yazılır ama tıklamaya bağlanmaz (`click_linked = 0`).

Ayrıştırma savunmacıdır: zorunlu alan eksik ya da bozuk olan eylem `unparsed` sayılır,
uydurulmaz.

## Gerekçe

Yönetimdeki Affiliate ekranı (0085) dönüşüm sayısını `conversion` tablosundan okuyor,
fakat tabloya yazan bir yol yoktu; ekran kalıcı olarak "—" gösteriyordu. Gelirin
ölçülmesi için ağın kendi raporu tek doğru kaynaktır. Tıklama sayımından tahmin yapmak
CLAUDE.md'nin "tahmin üretilmez" ilkesine aykırıdır.

## Reddedilen

- Postback (ağın bize HTTP çağrısı): Python herkese açık HTTP ucu sunmaz (mimari sınır).
  TypeScript ucu ise iş mantığını `apps/web`'e taşırdı ve imza doğrulaması için ayrı
  bir sır yönetimi gerektirirdi. Rapor okuma aynı veriyi gecikmeli ama sınırları
  bozmadan getiriyor.
- Kur yoksa son bilinen kuru kullanmak: haftalar eski kur gelir rakamını sessizce
  bozar; atlayıp `partial` ile görünür kılmak tercih edildi.
- Ayrı `affiliate_action` ham tablosu: şu an tüketen yok; `conversion` yeterli.
