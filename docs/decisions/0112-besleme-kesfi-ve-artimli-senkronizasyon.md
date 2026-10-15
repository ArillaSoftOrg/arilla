# 0112 — Besleme keşfi ve artımlı senkronizasyon (Admitad / AliExpress)

**Tarih:** 14 Ekim 2026
**Durum:** Kabul edildi. Kod ve testler hazır. Üretimde zamanlanmış çalışma
**yok**; etkinleştirme ayrı onaylıdır. Karar 0111'in modeli üzerine kurulur.

## Bağlam

Admitad yayıncı API'si gerçek hesapla doğrulandı (manicepte.com reklam alanı):

- `POST /token/`: client_credentials, 7 gün geçerli token.
- `GET /websites/v2/`: reklam alanları.
- `GET /advcampaigns/website/{w_id}/?connection_status=active`:
  bağlı programlar ve `feeds_info` (`name`, `xml_link`, `csv_link`,
  `admitad_last_update`).
- İki bağlı program, 16 besleme:
  - **AliExpress WW (6115):** 10 besleme. Fiyat bantları, "hot products" ve
    2020'den beri güncellenmeyen bir FR beslemesi.
  - **Alibaba WW (20881):** 6 besleme, 2022'den beri güncellenmiyor.
- Besleme adresinde `code` ve `user` kimlik parametreleri var.

AliExpress besleme şeması gerçek örnekten çıkarıldı. Biçim YML:

| Alan | Durum |
| --- | --- |
| `offer@id` | 16 haneli ürün kimliği |
| `name`, `price`, `oldprice` | Var |
| `currencyId` | **Yalnız USD** |
| `categoryId` + kategori ağacı | Var |
| `picture` | En fazla 7 |
| `param` | `shopId` (mağaza), `discount`, `commissionRate` |
| `url` | Admitad takip bağlantısı. Gerçek ürün adresi `ulp` → `dl_target_url` içinde |
| GTIN, marka, SKU/varyant, stok, kargo | **Yok** |

"10-25$" beslemesi gzip ile sıkıştırılmış hâlde bile birkaç yüz MB'ı aşıyor.
İndirme 0,7 MB/sn civarında. Ölçüm: `docs/ops.md`.

## Karar

1. **Ağ bağlayıcısı** (`feeds/network.py`): her ağ `discover()` ve `download_url()`
   sağlar. İlk bağlayıcı `feeds/admitad.py`.
   - Kimlik bilgisi ortamdan okunur; token yalnız bellekte tutulur.
   - 429/5xx hatalarında üstel geri çekilme uygulanır.
   - Besleme kimliği `<program_id>:<feed_id>` biçimindedir.
2. **Keşif** (`python -m feeds discover`):
   - Yeni beslemeler `discovered` olarak kaydedilir.
   - **Etkinleştirme yöneticinin işidir** (`feeds bind --activate`).
   - Sonraki keşifler yönetici yapılandırmasını ezmez.
   - Kaybolan besleme `gone` olur; offer'lara dokunulmaz.
   - Boş keşif hiçbir şeyi `gone` yapmaz.
   - Kimlik parametreleri hiçbir yerde saklanmaz. İndirme adresi her senkronizasyonda
     API'den yeniden çözülür.
3. **Profil yalnız doğrulanmış program için** (`feeds/profiles.py`, `admitad:6115`).
   Alan eşlemesi gerçek örnekte görülen alanlardır. Beslemede olmayan GTIN, marka,
   stok ve varyant **üretilmez**.
4. **Kanonik adres ve affiliate bağlantısı ayrıdır:**
   - `offer.url` = `https://www.aliexpress.com/item/<id>.html`; takip
     parametresi taşımaz. Kimlik, gösterim ve eşleştirme için kullanılır.
   - `offer.affiliate_url` (0066) = kaynağın takip bağlantısı; yalnız izinli host.
   - Parmak izine girmez: takip parametresi değişince ürün değişmiş sayılmaz.
   - Çıkış her zaman `click` kaydıyla yapılır (kural 8). Takip bağlantısının
     tıklamada kullanımı fiyat doğrulama/gösterim PR'ındadır.
5. **Akışla indirme ve ayrıştırma:**
   - Dosya diske sıkıştırılmış yazılır. Tavan `FEED_MAX_BYTES` (4 GiB).
   - Boş alan koruması `FEED_MIN_FREE_BYTES` (15 GiB): PostgreSQL/WAL ve yedek diski
     korunur.
   - sha256 çözülmüş içerikten hesaplanır.
   - Desteklenen biçimler: YML/XML (`iterparse` + ebeveynden çıkarma), CSV, NDJSON,
     JSON dizisi (parça parça). Sıkıştırma içeriğe bakılarak tanınır: gzip, ZIP.
   - 30 bin kayıtta tepe bellek 8 MB'ın altında (test).
6. **Senkronizasyon** (`feeds/sync.py`):
   - Besleme başına advisory lock; kayıt sırasına göre sabit parçalar (varsayılan
     1.000).
   - Her parça tek işlemde yazılır:
     - COPY;
     - satıcı upsert;
     - offer upsert;
     - `price_point` (yalnız yeni ya da değişen fiyat/stok; INSERT);
     - `search_outbox`;
     - besleme üyeliği;
     - `ingest_chunk = merged`;
     - kontrol noktası.
   - Değişiklik parmak izi ile tespit edilir.
   - Tekrar: içerik **en son** tam sürümle aynıysa `duplicate` olur ve yazım yapılmaz.
   - Çökmeden sonra kaldığı yerden devam edilir; birleştirilmiş parçalar atlanır.
   - Kayıt hataları `ingest_error`'a yazılır (sınırlı sayıda).
   - Parçalar arasında bekleme ve aktif bağlantı sayısına göre geri basınç uygulanır.
   - Kaynağın `admitad_last_update`'i değişmediyse indirme yapılmaz. Bu imleçtir.
     Kaynak delta sunmadığı için fark, sürüm karşılaştırmasıyla bulunur.
7. **Tamlık kapısı.** Kapı geçmezse sürüm `rejected` olur. Birleştirilen kayıtlar
   kalır ama **hiçbir offer pasifleşmez**. Kapı koşulları:
   - dosya sonuna hatasız ulaşılmış;
   - red oranı %2'nin altında;
   - kayıt sayısı son tam sürümlerin medyanının en az %85'i;
   - örnek kipi değil.
8. **Güvenli deaktivasyon** (0066 `feed_source_offer`):
   - Aynı ürün birden fazla beslemede olabilir: fiyat bandı beslemeleri ve "hot
     products". Ürün tek satırdır; çoğalmaz, silinmez.
   - Kapıyı geçen sürümden sonra yalnız o beslemenin **üyeliği** düşer.
   - Offer pasifleşmesi için üç şart birlikte gerekir:
     - hiçbir etkin ya da duraklatılmış beslemede üyeliği kalmamış olmalı;
     - **48 saatlik bekleme süresi** dolmuş olmalı. Fiyat bandı değişen ürün diğer
       beslemeye geçerken arada pasifleşmez;
     - tavan (%10) aşılmamış olmalı.
   - Geri gelen ürün aynı satırda yeniden etkinleşir.
9. **Para birimi** (CLAUDE.md: TRY):
   - Orijinal USD fiyat ve para birimi saklanır; çevrilmez, TL olarak yazılmaz.
   - Yaklaşık TRY gösterimi (TCMB kuru, zaman damgası, "yaklaşık" etiketi; kur yoksa
     dönüşüm yok) fiyat doğrulama/gösterim PR'ındadır.
   - O PR'a kadar TRY dışı beslemeler yalnız **etkin olmayan** merchant'a yazılır
     (doğrulama aşaması). TRY dışı offer'lar puanlı çözümleyiciye girmez. Böylece
     USD fiyat hiçbir sayfada TL gibi görünemez.
   - Offer'lar pasifleştirilmez (`is_active=true`); kısıt merchant düzeyinde ve
     geçicidir.
10. **Eşleştirme:** besleme `product_id`'ye dokunmaz. AliExpress kayıtlarında kesin
    kimlik (GTIN/MPN) olmadığı için 0111 politikası gereği otomatik bağlanmazlar.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Besleme URL'sini (`code`'lu) `feed_source`'ta saklamak | Yedek ve yönetim ekranı sırrı taşır |
| Deaktivasyonu `offer.last_snapshot_id` ile yapmak | Aynı ürün başka beslemede olunca yanlış pasifleştirir |
| Tekrar tespitini "bu içerik daha önce tamamlandı mı" ile yapmak | A → B → A dönüşünde aradaki deaktivasyonlar geri alınmaz (testte yakalandı) |
| Her koşuda değişmese de `price_point` yazmak (Shopify yazıcısı) | Milyonlarca offer'da tablo şişer. Süreklilik `offer.last_seen_at` ve sürüm kayıtlarından okunur |
| Takip bağlantısını `offer.url` olarak saklamak | Kimlik ve eşleştirme takip parametresiyle kirlenir; kanonik adres kaybolur |
| USD'yi TL'ye sabit kurla çevirip yazmak | Kur uydurmaktır. Fiyat kaynağı ve zamanı kaybolur |
| Ham dosyayı belleğe almak (mevcut `network_dump`) | Yüzlerce MB'lık beslemede KVM 4 belleğini tüketir |

## Sınırlar ve açık işler

- **Üretimde zamanlama yok.** `feeds sync-due` için zamanlayıcı ve kaynak sınırlı
  container (CPU/RAM) aktivasyon adımıdır.
- **Beslemeler çok büyük.** Tam aktarım öncesi şunlar ölçülmeli: indirme süresi, disk,
  aktarım süresi ve WAL/yedek büyümesi. V4.1 §20 aşama kapıları geçerli; milyonlarca
  ürün doğrudan yüklenmez.
- Kaynak gerçek delta sunmuyor; her koşu tam dosya indirir. Yalnız
  `admitad_last_update` değişmediyse indirme atlanır.
- Alibaba beslemeleri 2022'den beri güncellenmiyor; etkinleştirilmemeli.
