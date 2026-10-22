# 0144 — Hepsiburada (sitemap) kategori referansı: hiyerarşisi bilinmeyen kaynak

**Tarih:** 22 Ekim 2026
**Durum:** Önerildi (PR). #205 (0143; migration 0096/0097) `main`de ve üretimde uygulandı. Birleştirme ve dağıtım kullanıcı onayına bağlıdır.
Migration 0098 (şema) + 0099 (tohum).
**İlişkili:** 0143 (Trendyol referansı), 0133 (merkezi ağaç), 0138–0142 (sınıflandırıcı)

## 1. Girdi

Hepsiburada'nın resmî kategori API'si (`mpop.hepsiburada.com/.../get-all-categories`) kimlik
doğrulamasız 403 verdi; sitemap'ler bu IP'den 403. Kaynak, kullanıcının sağladığı kategori sitemap'idir:
`docs/reference/hepsiburada/categories.raw.xml` (1.423.061 bayt, sha256
`824a48f3db7893795a0daf555f7588237f60dfae12322a628211799a54fbe2c5`), bayt bayt saklandı.
Erişim engeli aşılmadı; üçüncü taraf ücretli API kullanılmadı.

| Ölçü | Değer |
| --- | --- |
| Kayıt (`<url>`) | **6.320** — tamamı saklanır |
| Benzersiz ID / yinelenen ID / yinelenen URL | 6.320 / 0 / 0 |
| **Geçerli** (`quality = 'valid'`) | **6.293** |
| **Şüpheli** (`quality = 'suspect'`) | **27**: `id = 0` (`hepsiburada-com`, ana sayfa yer tutucusu) + 26 INT_MAX'a yakın yer tutucu ID (2147483601…2147483646: `kitaplar`, `telefonlar`, `muzik`…) |
| Bozuk URL (kurtarılan) | 1 (`sauna-ekipmanlari`: adres ve `-c-80857470` iki kez; iki parça aynı olduğu için ID alındı; `source_attrs.url_anomaly`) |
| Büyük harfli slug (bozuk İ/ı) | 33 (`source_attrs.slug_case_anomaly`; olduğu gibi) |
| Birden çok ID'de geçen slug | 303 (`source_attrs.same_slug_other_ids`; yalnızca gözlem) |

Sitemap yalnızca `slug-c-<id>` verir: **ebeveyn, derinlik, yol, yaprak ve durum yoktur.**

## 2. Karar

Hepsiburada kategorileri 0143'ün `external_category` mimarisinde, `source = 'hepsiburada_sitemap'`
altında saklanır. Sitemap kimliği ile resmî API `categoryId`'si aynı ad alanı olmayabilir; bu yüzden
`hepsiburada` değil `hepsiburada_sitemap` kullanılır. API verisi gelirse ayrı `source` ile eklenir.

Hiyerarşi **uydurulmaz**: tüm satırlar `hierarchy_status = 'unknown'` olarak yazılır ve `parent_external_id`,
`depth`, `is_leaf`, `path_ids`, `path_text` **hepsi NULL**'dur (CHECK bunu zorunlu kılar: kısmi ya da tahmini
bilgi yazılamaz). Ad slug'dan türetilir (`name_basis = 'slug'`; Türkçe karakterler geri getirilmez).

## 3. Migration 0098 (geriye uyumlu, yalnızca gevşetme + ekleme)

- `external_category_import`: `source_kind` (`api`/`sitemap`, varsayılan `api`), `suspect_count`;
  `root_count` ve `max_depth` NULL'lanabilir.
- `external_category`: `hierarchy_status` (varsayılan `verified`), `name_basis` (`source`), `quality`
  (`valid`), `quality_reason`, `slug`, `source_url`, `source_attrs JSONB`; `depth/is_leaf/path_ids/path_text`
  NULL'lanabilir.
- 0096'nın adsız hiyerarşi/kimlik CHECK'leri tanımlarına göre düşürülür ve adlı olarak yeniden kurulur:
  `external_category_hierarchy_chk` (`verified` ⇒ 0096'daki kurallar aynen; `unknown` ⇒ hepsi boş),
  `external_category_id_chk` (`external_id > 0`, ya da `= 0` yalnızca `suspect`),
  `external_category_quality_chk` (`suspect` ⇒ `quality_reason` dolu).
- **Şüpheli kayıt eşleştirilemez:** `external_category_map_guard` tetikleyicisi `suspect` bir kategoriye
  yalnızca `rejected` eşleşme yazılmasına izin verir. `external_category_usage` görünümü `suspect`
  kategoriler için `usage = 'suspect'` döndürür (yeni kolonlar sona eklendi, eski kolon sırası aynı).
- Mevcut 3.867 Trendyol satırı değişmez (DEFAULT ile `verified`/`valid`/`source`; kontrol: içerik özeti aynı).

## 4. Tohum 0099 (üretilmiş, idempotent)

`pnpm --filter @arilla/db db:hepsiburada-categories --generate`, ham XML'den `0099_hepsiburada_category_reference_seed.sql`
üretir; `--check` ham dosyayla uyumu doğrular. Tohum: sha256 ile bir `external_category_import` satırı
(`source_kind = 'sitemap'`, 6.320 kayıt, 27 şüpheli) ve 400'lük parçalarla
`INSERT … ON CONFLICT (source, external_id) DO NOTHING`; yalnızca ekleme, mevcut satırın üzerine yazmaz;
tekrar çalıştırma mükerrer kayıt üretmez.

## 5. Sınıflandırıcı ve mevcut veri

`category`, `product`, `category_source_map`, `product_classification*` ve `services/ingest/classify`
**değişmedi**; `external_category*` tablolarını sınıflandırıcı okumaz, eşleme yazılmadı. Şüpheli ve
hiyerarşisi bilinmeyen kayıtlar otomatik eşleştirme/sınıflandırmada kullanılmaz (tetikleyici + sınıflandırıcının
bu tabloları hiç okumaması).

## 6. Geri alma

```sql
-- 0099'u geri almak:
DELETE FROM external_category_map m USING external_category c, external_category_import i
 WHERE c.source = m.source AND c.external_id = m.external_id AND i.id = c.import_id
   AND i.source = 'hepsiburada_sitemap' AND i.source_sha256 = '<ham dosya sha256>';
DELETE FROM external_category WHERE source = 'hepsiburada_sitemap'
   AND import_id = (SELECT id FROM external_category_import WHERE source = 'hepsiburada_sitemap'
                     AND source_sha256 = '<ham dosya sha256>');
DELETE FROM external_category_import WHERE source = 'hepsiburada_sitemap'
   AND source_sha256 = '<ham dosya sha256>';
```

0098'i geri almak (yalnızca `hepsiburada_sitemap` satırları silindikten sonra) kolon silmeyi gerektirir
ve kural 14 gereği ayrı, bilinçli bir adımdır; gevşetilmiş NOT NULL ve yeni kolonlar zararsızdır, geri
alınmaları gerekmez. Trendyol (0097) satırlarına dokunulmaz.

## 7. Merge sırası ve bağımlılık

1. **PR #205** (0143; 0096/0097) birleşti ve dağıtıldı; bu PR `main` üzerine yeniden temellendi.
2. Bu PR (0098/0099). Numara: 0094/0095 ve 0096/0097 `main`de, 0100 başka PR'dan; 0098/0099 boş.
3. Karar numarası 0144 (#205: 0143; açık PR #203 de 0142 kullanıyor, etkilemez).

## 8. Kalan riskler / ayrı işler

- Hiyerarşi bilinmiyor: ağaç için resmî API (satıcı kimlik bilgisi) ya da breadcrumb gerekir; geldiğinde ayrı
  `source` ve `hierarchy_status = 'verified'` satırlarıyla eklenir.
- Şüpheli sınırı (`id = 0` ve `>= 2.147.000.000`) sitemap gözlemine dayanır; 26 INT_MAX'a yakın ID'nin gerçek anlamı
  doğrulanmadı (eski üst başlık olabilir). Silinmedi, işaretlendi.
- Tetikleyici yalnızca eşleme yazılırken çalışır; sonradan `quality` değiştirilirse mevcut eşleşme kalır (bugün
  hiçbir eşleşme yok).
- Ad Trendyol ile karşılaştırması (`docs/reference/hepsiburada/trendyol-name-matches.json`) aday eşleşmedir,
  doğrulanmış değildir ve veritabanına yazılmaz.
- Tohum dosyası ~0,9 MB (URL'ler dahil); yalnız bir kez uygulanır.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Düz sitemap'e uydurma `depth`/`path` yazmak | Doğrulanmamış tahmini doğrulanmış gibi saklar |
| Hepsiburada için ayrı tablo | 0143'ün mimarisi kaynak bazlıdır; ikinci tablo eşleme/rapor mantığını çoğaltır |
| `source = 'hepsiburada'` | Sitemap ID'si ile API `categoryId`'si aynı olmayabilir; karışma riski |
| `id = 0` ve yer tutucuları dışarıda bırakmak | "6.320 kaydın tamamını koru" ilkesine aykırı; işaretlemek bilgiyi korur |
| Slug'dan Türkçe karakter geri getirmek | Tahmin; `name_basis = 'slug'` ile açıkça belirtmek daha dürüst |
