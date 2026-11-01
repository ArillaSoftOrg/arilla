# Yeni platform ekleme prosedürü

Karar: `docs/decisions/0164`. Hedef: yeni platform = bir `SourceDefinition` + bir adapter eşlemesi.
Ortak motor (kapı, yayın, fiyat geçmişi, eşleştirme) değişmez.

## 1. Önce veri hakkı ve erişim (kodsuz)

- Veri nasıl alınıyor: resmi API, affiliate beslemesi, herkese açık besleme? Scraping birincil kaynak olamaz.
- Fiyat saklama/gösterme, görsel bağlantı/aynalama, yurt dışı para birimi gösterimi için yazılı izin var mı?
  Yoksa `data_license="unknown"` kalır ve fiyat gösterilmez.
- Gerçek bir besleme/API örneği incele. Tahmini alan adı yazılmaz (karar 0012).

## 2. Kayıt (`services/ingest/platforms/registry.py`)

1. `SourceDefinition` yaz: `slug`, `kind` (api/xml/csv/json/feed), `merchant` (ad, alan adı, source_type),
   `currency` (yalnızca onaylıysa), `constraints` (hak, saklama, güncelleme sınırları).
2. Pazar yeriyse `is_marketplace=True` ve `offer_key_scheme="listing_seller"` (aksi halde kayıt reddedilir).
3. Başlangıç `status="sample"`. Kimlik kuralı (`IdentityRule`: `id_pattern`, `url_pattern`, ilk grup = kaynak kimliği)
   gerçek örnekle doğrulanınca `status="verified"` yapılır; ancak o zaman `POLICIES` ve kapı/yayın hattına girer.
4. `registry.onboarding_problems(definition)` boş dönmeli.
5. `feeds/profiles.py`: `PROFILE_SOURCES`a (`ag:program` → slug) satır ekle; `MERCHANT_PROFILES` registry'den
   türetilir. Besleme alan eşlemesi gerekiyorsa `PROFILES`a (gerçek örnekle doğrulanmış) eklenir.
6. Kategori: kaynağın `category_raw` yolları için `source_parent_map.tsv` üretilmediyse `source_parent_map`
   açılmaz; otomatik hatta `parents` adımı atlanır (başka kaynağın haritası yanlış eşleşmesin).

## 3. Adapter (`services/ingest/platforms/adapters/`)

1. `FieldMapping` yaz (kaynak alan yolları, para biçimi, stok değer kümeleri). Kod yazmak gerekmez.
2. `build_adapter(definition, kaynak, mapping, ...)`: yol veya sayfa kaynağı (`PageSource`) verilir.
3. Örnek dosya yaz (`tests/fixtures/platforms/`): sentetik, bilinçli bozuk kayıtlı. Gerçek veri commit'lenmez.
4. Testler: bozuk kayıt `Rejection`, kaynak bozuksa `SourceUnavailable`, kontrol noktasından devam
   kayıpsız/tekrarsız, iki koşu aynı sonucu verir.

## 4. Akış ve hat

- Otomatik hat: `python -m catalog_build auto --merchant <slug> --confirm` (build → parents → gate → publish).
  Kayıt defteri kısıtları yalnızca sıkılaştırır (`stale_days` üst sınırı, yurt dışı yayın, fiyat hakkı yoksa
  yayın yok, harita yoksa `parents` yok). İmleç ve tam tarama mağaza başınadır. Zamanlayıcı birimi
  (`infra/vps/systemd`) mağaza başına AYRI eklenir; bu PR eklemez.

- `run_source` / `run_sources` kısıtlardaki sınırları uygular (parti, dakika/gün istek, ardışık hata, geri basınç).
- Yazım tarafı (sink) idempotent olmalı: `(merchant_id, external_id)` unique; `price_point` yalnızca INSERT.
  `price_point` yazım politikası (her gözlem mi, yalnızca değişim mi) henüz tek tipte değil; yeni kaynak için
  değişimde yazım önerilir (`docs/platform-scale.md`).
- Satıcılar `seller` tablosuna, teklifler `offer`a (`seller_id`, `feed_source_id`) yazılır.
- Kategori: kaynak yolu `offer.category_raw`; ürün kategorisi ayrı sınıflandırma kararlarıyla yazılır.

## 5. Eşleştirme

`platforms/matching.py` yalnızca geçerli GTIN ya da marka+MPN ile birleştirir. Çelişki `hold`, başlık/model
ipucu yalnızca aday. Kimlik vermeyen kaynak (AliExpress gibi) ilan = ürün olarak kalır (`listing_only=True`).

## 6. Çıkış kontrol listesi

- [ ] Lisans türü ve hakları yazılı kaynağa dayanıyor
- [ ] `onboarding_problems` boş, `status="verified"` için gerçek örnek incelendi
- [ ] Adapter testleri + eşleştirme testleri yeşil, `ruff` temiz
- [ ] Yük/darboğaz notu güncellendi (`docs/platform-scale.md`)
- [ ] Üretimde ilk koşu: küçük `--limit`, açık onay, kapıdan geçen ürünler yayından önce örneklenir
