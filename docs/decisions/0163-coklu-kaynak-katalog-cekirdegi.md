# 0163 — Çoklu kaynak katalog çekirdeği: kaynak kayıt defteri, ortak sözleşme, kaynak kısıtları

Durum: önerildi (31 Ekim 2026). Birleştirme kararı, süren AliExpress işleri bitince birlikte verilecek.
Şema değişikliği YOKTUR; üretime hiçbir şey yazılmadı.

## Bağlam

Katalog hattı (taslak → kapı → yayın, fiyat geçmişi, eşleştirme) büyük ölçüde platform bağımsızdı, ama
"bu kaynak nedir" bilgisi üç yere dağılmıştı: kimlik kuralı (`catalog_build/policy.py`), besleme profili ve
merchant satırı (`feeds/profiles.py`), yenileme/para birimi ayarları (`feeds/daily.py`). Lisans, saklama ve
güncelleme kısıtları hiçbir yerde veri olarak yoktu. Hedef: onlarca platform, binlerce satıcı, milyonlarca ürün;
yeni platform eklemek ortak motoru yeniden yazdırmamalı.

## Karar

1. **Kaynak kayıt defteri** (`services/ingest/platforms/registry.py`): bir platformu tanımlayan tek yer.
   `SourceDefinition` = kimlik kuralı + merchant alanları + para birimi + anahtar şeması + kısıtlar.
   `catalog_build.policy.POLICIES` ve `SOURCE_LISTING_MERCHANTS` buradan **türetilir** (davranış değişmedi;
   mevcut testler değişmeden geçer).
2. **`status`**: `verified` (gerçek örnekle doğrulanmış kimlik kuralı; kapı/yayın hattına girer) ve `sample`
   (yalnızca örnek veriyle yazıldı; hatta GİRMEZ). Trendyol bu aşamada `sample`dır: gerçek erişim/kimlik kuralı
   yoktur (karar 0118), uydurulmadı.
3. **Ortak sözleşme** (`platforms/contract.py`): her kaynak türü (API, XML, CSV, JSON, besleme) `CanonicalListing`
   ya da `Rejection` üretir. Fiyat kuruş `int` (float reddedilir), stok bilinmiyorsa `None` ("yok" değil),
   zaman damgası saat dilimli. `SourceAdapter` protokolü: tembel iterator, tek kayıt hatası `Rejection`,
   kaynağın tamamı erişilemezse istisna, aynı `Checkpoint` ile idempotent.
4. **Kimlik ayrımı**: platform (`merchant`) ≠ satıcı (`seller`) ≠ ilan (listing) ≠ teklif (`offer`).
   `offer.external_id` UNIQUE (merchant_id, external_id) olduğundan, ayni ilanı birden çok satıcının sattığı
   pazar yerlerinde anahtar `<ilan>~<satıcı>` olur (`offer_key`, şema `listing_seller`). Pazar yeri kaydı
   bu şemayı zorunlu kılar. Fiyat ve stok geçmişi teklife aittir.
5. **Kaynak kısıtları** (`platforms/constraints.py`): `UsageRights` (lisans türü, fiyat saklama/gösterme,
   görsel bağlantı/aynalama, tıklama izleme, yurt dışı para birimi gösterimi), `RetentionPolicy` (fiyat geçmişi,
   ham yük, kaybolan ilan), `UpdateLimits` (en kısa yenileme aralığı, azami fiyat yaşı, dakika/gün istek
   sınırı, eşzamanlılık, parti, ardışık hata eşiği). Varsayılan en kısıtlıdır (`unknown` lisans: fiyat
   saklanmaz/gösterilmez); kısıt ancak açıkça gevşetilir. `price_history_days` sınırı konfigüre edilebilir,
   ama `price_point` değiştirilemezliği (kural 4) korunur: temizlik yalnızca ayrı, onaylı bakım işiyle.
6. **Eşleştirme** (`platforms/matching.py`): saf, deterministik, sıradan bağımsız. Kesin kimlik (geçerli GTIN;
   marka+MPN) dışında hiçbir şey birleşmez; çelişki (marka/varyant/kategori) `hold`; başlık/model ipucu
   yalnızca aday. Mevcut `resolve/identity_policy.py` kuralları yeniden kullanılır.
7. **Akış kontrolü** (`platforms/flow.py`): parti, kontrol noktası (yalnız kalıcı yazımdan sonra), hız sınırı,
   günlük bütçe, geri basınç (`throttle`), kaynak bazlı hata izolasyonu, değişmeyen kaydın yeniden yazılmaması.

## Gerekçe

- Şema zaten çok kaynaklı: `merchant`, `seller`, `feed_source`, `offer(seller_id, feed_source_id)`,
  `product_identity`. Eksik olan kaynak bilgisinin tek yerde ve veri olarak tutulmasıydı.
- Şema değişmediği için migration numarası çakışması ve geriye uyumluluk riski (kural 14) yoktur.

## Reddedilen alternatifler

- **Kısıtları `merchant.feed_config` JSONB'sine / yeni tabloya koymak:** şema değişikliği ister (kural 5) ve
  AliExpress işleriyle migration numarası çakışması riski taşır. Kayıt defteri kodda; DB'ye taşıma, birleşme
  kararından sonra ayrı bir migration olarak ele alınabilir.
- **Mevcut `feeds/` ve `collect/` hatlarını tek yeni hatta yeniden yazmak:** süren AliExpress dallarıyla
  doğrudan çakışır ve gereksiz büyük refactor olur. Bu karar yalnızca sözleşme ve kayıt defterini ekler;
  mevcut hatlar kendi hızında bu sözleşmeye geçirilir.
- **Başlık/görsel benzerliğiyle otomatik birleştirme:** yanlış birleştirme, eksik birleştirmeden pahalıdır.

## Sonuçlar ve sınırlar

- `feeds/profiles.py` ve `feeds/daily.py` henüz kayıt defterini okumaz (açık AliExpress dallarıyla çakışmamak
  için); `tests/test_platforms_core.py` kayıt defteri ile `MERCHANT_PROFILES` arasındaki sapmayı yakalar.
- 10 milyon+ ürün kapasitesi DOĞRULANMADI. Darboğaz analizi ve yük testi planı: `docs/platform-scale.md`.
- Yeni platform ekleme adımları: `docs/platform-onboarding.md`. AliExpress uyumluluk değerlendirmesi:
  `docs/platform-aliexpress-compat.md`.
