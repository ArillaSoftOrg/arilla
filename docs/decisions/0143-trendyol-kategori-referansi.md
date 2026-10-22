# 0143 — Trendyol kategori referans ağacı (ayrı, salt okunur, eşleşmesiz)

**Tarih:** 22 Ekim 2026
**Durum:** Önerildi (PR). Birleştirme ve dağıtım kullanıcı onayına bağlıdır; üretim veritabanına
dokunulmadı. Migration 0096 (şema) + 0097 (tohum).
**İlişkili:** 0133 (merkezi kategori ağacı), 0138–0142 (sınıflandırıcı)

## 1. Girdi ve doğrulama

Kaynak: `https://apigw.trendyol.com/integration/product/product-categories` (HTTP GET, kimlik
doğrulamasız, 22 Ekim 2026 19:39 UTC, 200, 280.122 bayt). Ham dosya bayt bayt saklandı:
`docs/reference/trendyol/product-categories.raw.json` (sha256
`93fa96003aa6e9a901628c88f760c645a8cb8039eb5f658a27fb15364f1153ce`).

| Ölçü | Değer |
| --- | --- |
| Toplam kategori | **3.867** |
| Ana kategori (kök) | **16** |
| Yaprak | 3.361 |
| Maksimum derinlik | **6** |
| Seviye başına (1..6) | 16 / 119 / 1.134 / 1.870 / 697 / 31 |
| Tekrarlanan kimlik | **0** (3.867 benzersiz) |
| `parentId` ↔ gerçek ebeveyn uyuşmazlığı | 0 |
| Boş ad | 0 |

Ayrıştırıcı (`packages/db/scripts/trendyol-categories-lib.ts`) bütünlük bozulursa **hata verir**
(boş liste, geçersiz/yinelenen kimlik, boş ad, `parentId` ≠ ebeveyn); eksik ya da uydurma kategori
üretmez. Ağ erişimi başarısız olsaydı hiçbir şey yazılmazdı. Ham dosyayı yenilemek ayrı, bilinçli bir
adımdır (`docs/reference/trendyol/README.md`); betik ağdan okumaz.

## 2. Veri modeli (migration 0096)

ManiCepte `category` ağacı **değişmez**; Trendyol ağacı ayrı, salt okunur bir referanstır. Trendyol
kimliği (`external_id`) dahili `category.id` ile hiçbir yerde birleşmez; ikisi arasındaki tek köprü
`external_category_map`'tir ve **boş açılır**.

| Tablo | Amaç |
| --- | --- |
| `external_category_import` | Bir içe aktarımın kaydı: `source`, `source_sha256` (UNIQUE), sayılar. Aynı dosya iki kez içe aktarılamaz. |
| `external_category` | PK `(source, external_id)`. Hiyerarşi kaynak kimliğiyle: `(source, parent_external_id)` → aynı tablo (bileşik yabancı anahtar). `depth`, `is_leaf`, `path_ids` (Trendyol kimlik zinciri), `path_text`, `import_id`, `retired_at`. CHECK: kök ⇔ ebeveynsiz; `cardinality(path_ids) = depth`. |
| `external_category_map` | `(source, external_id)` → `category.id`; `status` `suggested/confirmed/rejected` (`category_source_map` ile aynı anlam). **Siniflandirici okumaz.** |
| `external_category_usage` (görünüm) | Kullanılmayan kategori raporu (§5). |

`source` sütunu ileride başka bir platformun (Hepsiburada, N11) aynı yapıya yazılmasına izin verir;
CHECK `trendyol`'a kilitlemez ama bugün yalnız `trendyol` yazılır.

## 3. Mevcut yapıyla uyumluluk

- `category`, `product`, `category_source_map`, `product_classification*` tablolarına **dokunulmaz**:
  yalnızca yeni tablolar ve bir görünüm. Mevcut kategori kimliği, slug'ı ve ebeveyn ilişkisi aynen kalır.
- Migration'lar geriye uyumludur (yalnız ekleme, `IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).
- **Sınıflandırıcıya açılmaz.** `services/ingest/classify` bu tabloları okumaz; `taxonomy.py` kuralları
  `category.path` ile çalışır ve içe aktarılan kategoriler yalnızca referans verisidir. Açmak için
  ayrı doğrulama ve ayrı karar gerekir.
- Mevcut ürünlerin kategori ilişkileri etkilenmez (`product.category_id` değişmez).
- İstek yolunda model çağrısı ya da yeni okuma yok; Drizzle şeması `packages/db/src/schema/external-category.ts`.

Ad karşılaştırması (bilgi amaçlı; DB'ye yazılmaz): mevcut ağaçta 158 düğüm (10 kök); 38'inin adı
(Türkçe katlama sonrası) bir Trendyol kategorisiyle birebir aynı (ör. `moda/ayakkabi` ↔ 403
Ayakkabı, `elektronik/telefon` ↔ 5250 Telefon, `saglik-kozmetik/kozmetik/parfum` ↔ 661 Parfüm). Köklerin
hiçbiri bire bir eşleşmez: Trendyol "Anne & Bebek & Çocuk", "Giyim", "Kozmetik & Kişisel Bakım" gibi
farklı bölünmüş 16 kök kullanır; ManiCepte'nin "Moda", "Oto / Bahçe" kökleri Trendyol'da birden fazla
kökün parçasıdır. Bu yüzden **otomatik eşleme yazılmadı**; öneri üretmek ayrı iştir.

## 4. İçe aktarma (idempotent)

`pnpm --filter @arilla/db db:trendyol-categories --generate` ham JSON'dan ayrıştırılmış ağacı
(`product-categories.parsed.json`, düğüm başına bir satır) ve `0097_..._seed.sql`'i üretir; `--check`
ikisinin ham dosyayla uyumunu doğrular (CI'da `pnpm --filter @arilla/db test` bunu koşar).
0097: `external_category_import`'a sha256 ile bir satır, `external_category`'ye 400'lük parçalarla
`INSERT … ON CONFLICT (source, external_id) DO NOTHING`. İkinci koşu sıfır satır ekler; var olan satırın
üzerine yazmaz. Kaynak güncellenirse yeni ham dosya yeni sha256 ile **yeni bir migration** üretir
(yeni kategoriler eklenir; kaynaktan kalkanlar silinmez, `retired_at` ile işaretlenir — bu ek, ilk
içe aktarımda gerekmediği için henüz yazılmadı).

## 5. Kullanılmayan kategori raporu

`external_category_usage` her Trendyol kategorisi için bir durum verir:

| `usage` | Anlamı |
| --- | --- |
| `unmapped` | ManiCepte kategorisine eşleşme yok (başlangıçta **tümü**; 3.867) |
| `mapped_empty` | Eşleşen ManiCepte kategorisinde ürün yok |
| `in_use` | Eşleşen kategoride ürün var |
| `rejected` | Eşleşmesi reddedilmiş |

Örnek: `SELECT usage, count(*) FROM external_category_usage GROUP BY 1;` ve ölü dal için
`SELECT path_text FROM external_category_usage WHERE is_leaf AND usage IN ('unmapped','mapped_empty')
AND retired_at IS NULL;`. Ürün sayımı yalnızca eşleşen (az sayıda) kategori için `product_category_idx`
üzerinden `EXISTS` ile yapılır; tüm katalog taranmaz. İleride kullanım ölçüsü ürün sayısından
sorgu/tıklama sinyaline genişletilebilir (ayrı iş).

## 6. Geri alma

Ürün, eşleşme ve sınıflandırıcı bağı olmadığı için güvenlidir. Sırayla:

```sql
-- yalnızca 0097'yi geri almak (tabloları ve eşleşmeleri korur):
DELETE FROM external_category_map m USING external_category c, external_category_import i
 WHERE c.source = m.source AND c.external_id = m.external_id AND i.id = c.import_id
   AND i.source = 'trendyol' AND i.source_sha256 = '<ham dosya sha256>';
DELETE FROM external_category WHERE source = 'trendyol'
   AND import_id = (SELECT id FROM external_category_import WHERE source = 'trendyol'
                     AND source_sha256 = '<ham dosya sha256>');
DELETE FROM external_category_import WHERE source = 'trendyol'
   AND source_sha256 = '<ham dosya sha256>';
-- 0096'yı geri almak (0097 geri alındıktan sonra):
DROP VIEW external_category_usage;
DROP TABLE external_category_map, external_category, external_category_import;
```

Geri alma `category` ve `product`'a dokunmaz.

## 7. Kalan riskler / ayrı işler

- Eşleme (Trendyol → ManiCepte) yok; sınıflandırıcıya açmak için insan doğrulamalı ayrı karar gerekir.
- Trendyol ağacı satıcı entegrasyonu içindir (ör. "Ek Hizmetler" kökü ürün değil hizmet kategorisi);
  hangi dalların ürün kategorisi sayılacağı eşleme aşamasında belirlenir, burada filtrelenmedi.
- Kaynak, kimlik doğrulamasız bir entegrasyon uç noktasıdır; kullanım koşulları/hız sınırı Trendyol
  kararıdır. Ham dosya depoda tutulur, uç nokta betiklerden çağrılmaz.
- 0092/0093 açık PR #201'de ayrılmış; bu PR 0096/0097 alır, karar numarası 0143 (açık PR #203 de 0142
  kullanıyor, bu PR'ı etkilemez).
- Yerelde PostgreSQL sunucusu yok: 0096/0097 süreç içi PostgreSQL motoru (PGlite) ile denendi — iki kez
  uygulama, 3.867 satır, yol/yaprak tutarlılığı, kısıt ihlalleri, görünüm sayıları ve §6 geri alma + yeniden
  tohumlama temiz. Gerçek PostgreSQL 16 + CI şema/entegrasyon doğrulaması PR'da koşar.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| 3.867 kategoriyi `category` tablosuna eklemek | Keşfet/arama/sınıflandırıcı bunları görür; 2,77 M ürün için boş dallar ve yanlış atama riski (kural 0133: ikinci ağaç yok, ama dış ağaç ayrı referans) |
| Trendyol kimliğini `category`'ye sütun olarak eklemek | Mevcut tabloyu (büyük bağımlı yüzey) değiştirir; birden çok kaynak olamaz |
| Uygulama başlangıcında ağdan çekmek | Tekrarlanabilir değil, hata durumunda eksik veri riski; ham dosya depoda ve doğrulanır |
| Tohumu Python içe aktarıcıyla yazmak | Migration/şema sahibi `packages/db`; veri migration'ı idempotent ve sürümlü |
| Adı benzer kategorileri otomatik eşlemek | Yanlış eşleme sessizdir; köklerde bire bir uyuşma yok, insan doğrulaması gerekir |
