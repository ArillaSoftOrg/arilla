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
