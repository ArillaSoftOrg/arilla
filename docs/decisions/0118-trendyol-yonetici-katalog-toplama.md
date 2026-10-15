# 0118 — Trendyol: yönetici tarayıcısından katalog toplama (eklenti, bildirilen yazılı izin)

**Tarih:** 15 Ekim 2026
**Durum:** Kabul edildi. Kod ve testler hazır. Kaynak iki yerden **kapalı** gelir:
- `collection_source.enabled = FALSE` (migration 0072);
- `TRENDYOL_COLLECTION_ENABLED` ortam bayrağı (yokken sayfa ve API 404).

Gerçek toplama başlatılmadı; ayrıca onay ister.

**Bağlam:**
- Karar 0117'nin (Hepsiburada) altyapısını kullanır. Bu PR, #147'ye bağlıdır.
- Araştırma: `research/trendyol-landing-discovery`, belge 16 (ilk 0118 taslağının yerini alır).

## İzin kaydı (kullanıcı beyanı; belgeler İNCELENMEDİ)

Ürün sahibinin bildirdiği görüşme:
- Trendyol resmî API vermiyor; CORS açılmayacak.
- Hepsiburada'daki tarayıcı tabanlı yöntemin benzerine izin verildi (önce sözlü).
- Yenileme: haftada en fazla 1, takvim ayında en fazla 4. İlk yükleme de bu kotaya tabidir.

**15 Ekim 2026, kullanıcı beyanı:** Ürün sahibi, Trendyol ve Hepsiburada'dan **yazılı izin e-postası** aldığını bildirdi.
- Belgeler paylaşılmadı, depoda ya da sistemde yok.
- Bu karar ve kod belgeleri **incelemedi**. İçerikleri, kapsamları ve geçerlilikleri doğrulanmadı.

Kayıt: `permission_basis = 'written_email_reported'`. Bu değer, Hepsiburada satırı ve kapsam kısıtı (`collection_source_reported_scope`) #147'deki 0070 ile gelir; 0072 Trendyol satırını aynı dayanakla ekler.
- `written_agreement` (incelenmiş yazılı sözleşme) **kullanılmadı**.
- Bildirilen kapsam değişmediği için 7 gün / ayda 4 kısıtı bu dayanağa da uygulanır ve ilk yükleme muaf değildir (`initial_load_exempt = FALSE`).
- Kısıtı gevşetmek için incelenmiş sözleşme ya da notlu `declared_extended` gerekir (0117).

## Kapsam (daraltılmış)

| Okunan | Okunmayan |
|---|---|
| Trendyol ürün kimliği (contentId) | Diğer satıcıların teklifleri |
| Ürün adı | Stok durumu ve miktarı |
| Gerçek satış fiyatı (TRY, kuruş) | Satıcının kişisel ve kurumsal bilgileri (vergi no, KEP, adres, unvan) |
| Görseller (en fazla 6, `cdn.dsmcdn.com`) | Yorumlar ve gereksiz ürün detayları |
| Kanonik ürün bağlantısı | |
| Ana (kazanan) satıcı: kimlik ve ad | |
| Beden/varyant kimliği (fiyat bedene aitse) | |
| Kaynak ve okunma zamanı | |

## Karar

1. **Okuma yöneticinin kendi tarayıcısında, açılmış Trendyol sayfasındandır. Ek ağ isteği yoktur.**
   - Eklenti (`apps/trendyol-collector-extension`, MV3, yalnız `storage` izni) içerik betiğiyle sayfadaki `<script>` metinlerini okur:
     - ürün sayfasında `__envoy__SHARED_PROPS`;
     - liste sayfasında `__single-search-result__PROPS`.
   - Sunucu ve yönetim sayfası Trendyol'u çağırmaz; CORS ve bot koruması aşılmaz; proxy ya da oturum taklidi yoktur.
   - Otomatik gezinme yoktur. "Sıradakini aç" düğmesi yalnız yöneticinin tıkladığı tek adresi açar.
   - Yalnız ürün sayfası ve liste sayfası okunur (`-p-`, `-x-`, `-y-s`, `/sr`).
   - Hesap, sepet, ödeme, sipariş, giriş ve favoriler sayfaları manifestte `exclude_matches` ile içerik betiğinin kapsamı dışındadır.
   - **Eklenti güvenliği** (`audit.mjs`, `pnpm test` ile her derlemede çalışır):
     - yalnız `storage` izni; `host_permissions`, arka plan, `externally_connectable` ve dışa açık kaynak yok;
     - derlenmiş pakette ağ ya da dinamik kod API'si yok (`fetch`, XHR, WebSocket, `sendBeacon`, `eval`);
     - aktarma betiği yalnız `manicepte.com` / `www.manicepte.com` yönetim yolunda çalışır; `localhost` yalnız `build:dev`'de vardır, denetim onu reddeder.
   - Eklenti deposunda yalnız ürün verisi ve açık koşu kimliği tutulur.
     - Yakalanan adres köken + yol olarak saklanır; arama terimi, takip ve oturum parametreleri yazılmaz.
     - Koşu kapanınca depo temizlenir.
     - Gizli bilgi (çerez, token, oturum) okunmaz, saklanmaz.
     - Admin API yetkilendirmesi değişmez: gönderimi eklenti değil sayfa yapar (aynı köken, oturum, `catalog.write`).
2. **Aktarım 0117'in API'siyle yapılır.**
   - Eklentinin ikinci içerik betiği, yalnız `/yonetim/katalog/toplama/trendyol` sayfasında yakalananları `postMessage` ile aynı pencereye iletir.
   - Sayfa, `POST /api/yonetim/katalog-toplama`'ya aynı köken, oturum ve `catalog.write` ile gönderir.
   - Bir açılan ürün ya da liste sayfası bir kaynak isteğidir; koşu başına 500 sınırı vardır.
   - Beklenen yapı yoksa (engel ya da değişiklik) koşu durur; yeniden deneme yoktur.
3. **Fiyat kuralı. Sepet indirimi satış fiyatıyla karışmaz.**
   - Satış fiyatı:
     - ürün sayfasında `winnerVariant.price.sellingPrice`;
     - liste kartında `price.current`.
   - Sepet fiyatı (`discountedPrice`) ayrı ve koşullu tutulur: listede yalnız `binaryPrice.discountType = "basketPromotion"` ise, ürün sayfasında satıştan düşükse.
     - Kayıtlı 108 kartta: 97 `rrp` kartta indirimli fiyat satış fiyatına eşit; 11 `basketPromotion` kartta daha düşük.
     - `price_point`'a ve `offer.current_price`'a girmez; `attributes_raw.basket_price` olarak taşınır.
   - Liste fiyatı yalnız satıştan yüksekse tutulur.
   - JSON-LD `offers.price` satış fiyatı **değildir** (Samba'da 3.999,50 sepet / 7.999 satış).
   - Satış fiyatı okunamazsa kayıt üretilmez; fiyat uydurulmaz.
     - Karşılaştırma ve arama yalnız `current_price` dolu teklifleri gösterir.
   - **Varyant fiyatları karışmaz.**
     - Ürün sayfasında fiyat, kazanan satıcının kazanan varyantınındır.
     - Diğer bedenlerin `product.variants` fiyatları (başka satıcıya ait olabilir) okunmaz.
     - Bir ürünün yeni fiyatı önceki fiyatından farklı bir bedene aitse yazılmaz. `ingest_error` altında `variant_changed_held` olarak incelemeye ayrılır; mevcut fiyat ve beden değişmez.
4. **Bayat veri reddedilir.** Sayfa içinde gezinmeden sonra gömülü veri adresteki ürüne ait değilse (kimlik uyuşmazlığı) kayıt atılır.
5. **Kimlik ve eşleme.**
   - `offer.external_id` = contentId. Sitemap `-p-<id>` ve sayfa `product.id` ile aynı kimlik uzayıdır; ayrı eşleme tablosu gerekmez.
   - Offer satıcı başına değil **ürün başınadır**: kazanan satıcı değiştiğinde ürün çoğalmaz, `seller_id` güncellenir.
   - Aynı koşuda bir ürün tek kayıttır: `(run_id, external_id)` benzersiz.
     - Liste kartı kayıtları koşu sonuna dek bekletilir.
     - Aynı ürünün ürün sayfası gelirse liste kaydı düşer (ana satıcı adı ve kazanan beden ürün sayfasından gelir).
   - Renk ayrı contentId'dir. Beden yalnız fiyatın ait olduğu varyant olarak `variant_id` / `variant_label` alanlarında tutulur.
6. **Birleştirme 0117 ile aynıdır** (`python -m feeds collect-merge --run N`; `hb-merge` adı korunur).
   - `FeedSync` parmak izi: değişmeyen ürün yeniden yazılmaz (test: `xmin` aynı), WAL üretilmez.
   - `price_point` yalnız yeni ya da değişen fiyatta eklenir.
   - Parmak izine giren `param` alanları koşudan koşuya sabittir (`found_via` gibi keşif izi yok).
   - `no_deactivate`: eksik ya da kısmi taramada hiçbir ürün silinmez ve pasifleşmez.
   - **Stok toplanmaz; bilinmeyen durum korunur.** Şemada `offer.in_stock` NOT NULL olduğundan:
     - `in_stock = TRUE` yazılır. Bu, katalogun kullanılabilirlik bilgisi olmayan beslemelerdeki kuralıyla aynıdır (normalize).
     - `attributes_raw.stock_state = "unknown"` işaretlenir.
     - `false` yazılmaz: ürün aramada stoksuz cezası almaz ve "stokta yok" denmez.
   - Okuma tarafı bilinmeyen durumu korur:
     - `MerchantOffer.stockKnown = false`;
     - mağaza listesinde stok etiketi ve ürün JSON-LD'sinde `availability` yok;
     - "stokta olanlar" filtresi doğrulanmamış stoğu dahil etmez.
   - `price_point.in_stock` da NOT NULL'dur. Bu kaynakta stok bilgisi taşımaz; yorum `stock_state` ile yapılır.
   - Hepsiburada (0117) şimdilik `false` kuralındadır; aynı ayar (`unknown_stock_available`) kaynak bazlıdır.
7. **Kota sistem seviyesindedir** (0070 tetikleyicisi, `trendyol` satırı): en az 7 gün aralık, takvim ayında 4 koşu, ilk yükleme dahil. `arilla_app` politikayı değiştiremez.
8. **Kapsam ölçülür, varsayılmaz.**
   - Koşu kapanışında ürün ve liste sayfası sayıları, benzersiz ürün sayısı raporlanır.
   - `scripts/trendyol-sitemap-coverage.ts` katalog / sitemap oranını yalnız okuyarak ölçer.
   - Bir koşu en fazla 500 sayfadır; liste sayfası ≤ 36 ürün. Ayda 4 koşuyla ulaşılabilecek üst sınır bile 8,13 milyonun küçük bir kısmıdır.

## Reddedilen alternatifler

| Alternatif | Neden değil |
|---|---|
| Yönetim sayfasından `fetch` (0117'teki gibi) | Trendyol CORS açmıyor; açılmayacak |
| Sunucu/VPS'ten çekme, farklı istemci, headless tarayıcı | Bot korumasını aşmak olur |
| `apigw.trendyol.com` (diğer satıcılar, sayfalama) | robots `Disallow: /`, dahili servis; ayrıca diğer satıcılar istenmiyor |
| JSON-LD fiyatını satış fiyatı saymak | Sepet fiyatına eşit olabiliyor |
| Offer'ı satıcı başına açmak (`contentId:satıcı`) | Kazanan satıcı değişince aynı ürün çoğalır ve eski teklif aktif kalır |
| Otomatik sekme gezintisi | İzin kapsamı (belgeler incelenmedi) teyit edilmedi; toplu tarama sayılır |
| Bilinmeyen stoğu `in_stock=false` yazmak | Ürün aramada cezalanır, "stokta yok" diye yanlış gösterilir |
| `offer.in_stock`'u NULL'a açmak | Geniş şema değişikliği; tüm okuyucular etkilenir. `stock_state` yeterli |
| `permission_basis = 'written_agreement'` | Belgeler incelenmedi; bildirilen izin doğrulanmış sözleşme gibi kaydedilemez |
| Kullanıcıların tarayıcısından toplama | KVKK ve izin kapsamı dışında |

## Sonuçlar ve açık işler

- **Belgelerin incelenmesi:** Bildirilen yazılı izinlerin kapsamı (hız, sayfa türleri, gösterim, görsel kullanımı) ekip tarafından okunmalı. Gerekirse `written_agreement`'a yükseltilir (migration).
- **Üretimde açılış:**
  1. `TRENDYOL_COLLECTION_ENABLED=true`;
  2. `feeds ensure-merchant --profile tycollect:trendyol`;
  3. `collection_source.enabled` (sahip rol).
- **Eklenti dağıtımı:** Yönetici kendi tarayıcısına "paketlenmemiş" olarak yükler; mağazaya konmaz.
- **Numaralar:** migration 0072, karar 0118. Main'de 0069'a kadar; #147 0070 ve 0117 kullanıyor. 0071, #144'ün yeniden numaralanmasına bırakıldı (0068'i main ile çakışıyor). Merge sırası #147 → bu PR.
