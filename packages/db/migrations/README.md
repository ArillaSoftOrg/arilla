# Migration'lar

`docs/schema.sql` referans belgedir, calistirilmaz. Gercek semayi bu klasordeki
migration'lar olusturur.

## Kurallar

- Dosya adi: `NNNN_kisa_ad.sql`, sirali.
- **Geriye uyumlu yazilir.** Once kolon eklenir, kod dagitilir, sonra eski
  kolon kaldirilir. Tek adimda kolon silen migration reddedilir.
- Semanin tek sahibi `packages/db`. Python tarafi okur ve yazar, migration
  uretmez.
- Her migration staging'de calismadan production'a gitmez.
- `docs/schema.sql` her migration'dan sonra guncellenir; ikisi ayrisirsa
  referans belge yalan soyler.

## Sira

| Dosya | Icerik |
| --- | --- |
| `0001_extensions.sql` | vector, pg_trgm, uuid-ossp |
| `0002_catalog.sql` | merchant, brand, category, product, product_slug_history, offer, offer_variant, variant_stock_event |
| `0003_price_history.sql` | price_point (partitioned + default), product_price_stats |
| `0004_semantic.sql` | embedding, match_candidate, similarity_edge, generated_content |
| `0005_auth.sql` | app_user, auth_token, session |
| `0006_creator.sql` | creator, creator_affiliate_account, collection, collection_item, follow, saved_item, alert |
| `0007_attribution.sql` | click, conversion, api_usage, ingest_run |
| `0008_search.sql` | query_resolution, lexicon |
| `0009_discovery.sql` | product_view, user_size_profile, user_consent, trend_snapshot, public_find, discovery_slot |
| `0010_append_only_grants.sql` | arilla_app rolu, GRANT/REVOKE, append-only yetkileri |
| `0011_click_result_position.sql` | click.source_similarity_kind, click.result_position |
| `0013_user_intake.sql` | image_upload, link_resolution_request (D4: görsel arama, kök catch-all link çözümleme) |
| `0014_polymorphic_integrity.sql` | embedding/generated_content polimorfik `target_id` icin silme yonu trigger'lari (0020) |
| `0015_polymorphic_trigger_comments.sql` | 0014 trigger fonksiyonlarina `COMMENT ON` ile yetki notu (0021) |
| `0016_category_expansion.sql` | `category.slug` UNIQUE kisiti (eksik kalmisti) + 8 yeni ana kategori + kozmetik→saglik-kozmetik yeniden ebeveynleme (0023) |
| `0017_offer_variant_sku_and_shopify_source.sql` | `offer_variant.sku` kolonu + `merchant.source_type` CHECK'ine `'shopify'` eklendi (0024 — Shopify connector'i renk/beden/SKU'yu destekliyor) |
| `0018_merchant_shopify_discovery.sql` | brand-discovery/endpoint-verification zincirinden 19 merchant kaydi, `is_active = FALSE` (0023; `source_type`/`feed_config.mapping` 0024 icin yerinde guncellendi — para birimi hala dogrulanmadigi icin `is_active` FALSE kaldi). 0017'den SONRA calismali: source_type='shopify' 0017'nin genislettigi CHECK'e bagli. |
| `0019_product_title_fold_trgm.sql` | Katlanmis (Turkce+ASCII) `product.title` uzerinde trigram GIN indeksi; metin aramasinin aday kapisi icin (0029). Yalnizca ekleme. |
| `0020_lexicon_synonym_kind.sql` | `lexicon.kind` CHECK'ine `'synonym'` + gercek katalog bosluklarindan baslangic esanlam seti (0029). Genisletici. |
| `0021_shopify_currency_verified.sql` | 0018'in 18 merchant'ina `feed_config.currency = "TRY"`, `currency_verified = true` (0031; kanit `services/ingest/bootstrap/currency_verification_20260926.json`). Yalnizca veri; `is_active` DEGISMEZ, `turkish-finds` (PHP) dokunulmaz. Beklenmeyen durumda RAISE EXCEPTION ile durur. |
| `0022_link_search_signals.sql` | `link_resolution_request`: `normalized_url` (onbellek anahtari) + `source` (sayfa sinyalleri) + `error_code` + `image_embedding_id` + kismi indeks (0035). Yalnizca ekleme. |
| `0023_offer_variant_gtin.sql` | `offer_variant.gtin` + `gtin_source` + kismi indeks: varyant duzeyinde barkod (0036). Yalnizca ekleme. |
| `0024_oauth_identity.sql` | `user_identity`: Google OAuth `sub` kimligini mevcut `app_user`/`session` modeline baglar; OAuth token'lari saklanmaz. |
| `0025_apple_phone_identity.sql` | `user_identity.provider`a `apple` + `phone`; `app_user.email` NULL olabilir; `phone_login_code` (HMAC kod, TTL, `consumed_at`, deneme sayisi). Geriye uyumlu. |
| `0026_variant_price_event.sql` | `variant_price_event` (append-only): cok boyutlu tekliflerde boyut bazli fiyat gecmisi, yalnizca degisimde yazilir (0037). Yalnizca ekleme. |
| `0027_admin_audit_event.sql` | `admin_audit_event` (append-only): `/yonetim` mutasyonlarinin denetim izi — aktor, eylem, hedef, izinli alanlarla once/sonra (0039). Yalnizca ekleme. |

Not: `0016` repodaki ilk veri-tasiyan migration'dir — buraya kadar hepsi saf
DDL'ydi (`grep -l "INSERT INTO" migrations/*.sql` bos donerdi). Kategori
verisi referans/lookup verisi oldugu icin (kullanici verisi degil) migration
icinde tutuluyor; gelecekte "migration = sadece sema" varsayimiyla
sasirmayin.

## Calistirma

```bash
pnpm db:migrate          # sirayla uygular, uygulananlari schema_migration'da tutar
pnpm db:bootstrap-role   # arilla_app rolune LOGIN + parola verir (APP_DB_PASSWORD)
pnpm db:partitions       # icinde bulunulan ay + 3 ay ileri
pnpm db:verify           # Drizzle semasi uyumu + append-only yetki kaniti + polimorfik butunluk
pnpm db:orphans --check  # yetim embedding/generated_content satiri var mi (izleme)
pnpm seed                # gelistirme katalogu (A3) — mevcut katalogu SILER
```

Her migration kendi isleminde calisir: biri patlarsa oncekiler kalir,
sonrakiler denenmez.

## Roller

| Rol | Kim kullanir | Yetki |
| --- | --- | --- |
| `arilla` | migration, partition uretimi, tohum verisi | sahip, superuser |
| `arilla_app` | `apps/*`, `services/ingest` | tablo basina GRANT; `price_point` ve `variant_stock_event` uzerinde **yalnizca SELECT ve INSERT** |

Uygulama `arilla` ile baglanirsa append-only kurali **etkisiz kalir** —
superuser butun yetki kontrollerini atlar. `pnpm db:verify` bu durumu yakalar
ve hata verir.

`0014`'un trigger fonksiyonlari `SECURITY DEFINER`'dir: sahip rolun
(`arilla`) yetkisiyle kosarlar. Bu yuzden polimorfik butunluk icin
`arilla_app`'e HICBIR ek yetki verilmez — rol fonksiyonu dogrudan cagirma
yetkisine bile sahip degildir (`PUBLIC`'ten `EXECUTE` geri alinmistir),
trigger yine de calisir. `search_path` fonksiyon uzerinde sabitlenmistir.

> **`arilla_app`'in yetkilerini degistirecekseniz once
> `docs/decisions/0021-security-definer-yetki-istisnasi.md` okuyun.**
> `DEFINER` cagiranin yetkisini atlar, yani yetki daraltmasi bu trigger'lari
> SESSIZCE etkisiz birakmaz — calismaya devam ederler. `embedding` ya da
> `generated_content` append-only yapilirsa `0014` o kuralin bilincli
> istisnasi olur ve kendini ilan etmez. 0021 kontrol listesini icerir.

`arilla_app` migration tarafindan parolasiz olusturulur; parola
`APP_DB_PASSWORD` ortam degiskeninden `db:bootstrap-role` ile verilir. Parola
depoya girmez (`docs/ops.md`).

## Partition bakimi

`price_point` aya gore partition'li. Iki katmanli korunur:

1. **Onceden uretim.** `scripts/partitions.ts` icinde bulunulan ay ve **en az
   3 ay ileri** icin partition acar. Uc ay, tek bir kacirilmis cron kosusunun
   veri kaybina donusmemesi icindir. Idempotent; aylik cron ile calistirilir.
2. **`price_point_default` guvenlik agi.** Aralik disi bir satir gelirse INSERT
   patlamaz, default'a duser.

**Default partition normal durumda BOSTUR.** Dolu olmasi, partition uretiminin
calismadigi anlamina gelir ve kritik uyaridir — sessiz bir cop kutusu degildir.

```bash
pnpm db:partitions --check   # dolu ise sifirdan farkli cikis kodu
```

Dolu bulundugunda izlenecek adimlar `docs/ops.md` icindeki runbook'tadir.
Ozetle: dolu default varken o ayin partition'i **olusturulamaz**, once default
DETACH edilir.
