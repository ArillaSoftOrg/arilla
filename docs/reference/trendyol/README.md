# Trendyol kategori referansı

Karar: `docs/decisions/0143-trendyol-kategori-referansi.md`. Biçimlendirici (biome) bu klasörü atlar;
dosyalar bayt bayt korunur.

| Dosya | İçerik |
| --- | --- |
| `product-categories.raw.json` | Kaynağın **değiştirilmemiş** yanıtı (`GET https://apigw.trendyol.com/integration/product/product-categories`, 22 Ekim 2026 19:39 UTC, 200, 280.122 bayt, sha256 `93fa96003aa6e9a901628c88f760c645a8cb8039eb5f658a27fb15364f1153ce`) |
| `product-categories.parsed.json` | Ham dosyadan **üretilmiş** düz ağaç: `id`, `name`, `parentId`, `depth`, `isLeaf`, `pathIds`, `pathText`. Elle düzenlenmez |

Özet: 3.867 kategori, 16 ana kategori, 6 seviye, 3.361 yaprak, tekrarlanan kimlik yok.

## Aktif ağaca entegrasyon (karar 0153, migration 0102)

| Dosya | İçerik |
| --- | --- |
| `category-tree-map.csv` | **Kalıcı eşleme** (üretilmiş): her Trendyol kimliği için eylem (`match`/`create`), ManiCepte yolu, slug'ı ve adı, keşfet bayrağı. 3.867 satır |
| `category-tree-rollback.sql` | Elle, onayla çalıştırılan geri alma (yalnız oluşturulan 3.862 kategori + eşleme; ürün bağlıysa hiçbir şey silinmez). Migration değildir |
| `../categories/manicepte-baseline-158.tsv` | Entegrasyon ÖNCESİ 158 ManiCepte kategorisinin değişmez görüntüsü (yol, slug, ad, keşfet) |

`pnpm --filter @arilla/db db:trendyol-category-tree` planı özetler, `--check` uyumu doğrular, `--generate`
migration, CSV ve geri alma betiğini yeniden yazar. Elle düzenlenmez.

## Yenileme (bilinçli adım)

1. `curl -sS -o product-categories.raw.json https://apigw.trendyol.com/integration/product/product-categories`
   (yanıt 200 ve `{"categories":[…]}` değilse DURUN; eksik dosya commit edilmez).
2. `pnpm --filter @arilla/db db:trendyol-categories` — sayıları ve bütünlüğü yazdırır (hata verirse düzeltin).
3. Yeni sha256 için tohum migration'ı ayrı numarayla eklenir; `--generate` yalnızca şu anki tohumu
   (0097) yeniden üretir, var olan migration'ın üzerine farklı bir ham dosya yazmayın.
4. `pnpm --filter @arilla/db db:trendyol-categories --check` ve `pnpm --filter @arilla/db test`.

Trendyol `id`'leri dahili `category.id` ile **karıştırılmaz**.
