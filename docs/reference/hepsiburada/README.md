# Hepsiburada kategori referansı (araştırma, 22 Ekim 2026)

Kaynak: kullanıcının sağladığı `categories.raw.xml` (Hepsiburada kategori sitemap'i, 1.423.061 bayt, sha256
`824a48f3db7893795a0daf555f7588237f60dfae12322a628211799a54fbe2c5`), bayt bayt saklandı. Resmî API
(`mpop.hepsiburada.com/.../get-all-categories`) kimlik doğrulamasız 403 verdi; sitemap'ler bu IP'den 403.
**Veritabanına yazılmadı, sınıflandırıcıya ve mevcut kategorilere dokunulmadı.**

| Dosya | İçerik |
| --- | --- |
| `categories.raw.xml` | Ham sitemap |
| `categories.parsed.json` | Üretilmiş: `id`, `slug`, `url`, `name` (slug'dan), `nameBasis:"slug"`, `urlAnomaly`, `slugCaseAnomaly`, `placeholderId`, `sameSlugOtherIds` |
| `trendyol-name-matches.json` | ADAY ad eşleşmeleri (Trendyol 3.867 kategorisiyle) |
| `parse_categories.py` | Üretici: `python -I parse_categories.py categories.raw.xml ../trendyol/product-categories.parsed.json .` |

## Sayılar

| Ölçü | Değer |
| --- | --- |
| `<url>` / kategori | **6.320** |
| Benzersiz ID (`-c-<id>`) | 6.320 — **tekrarlanan ID yok**, tekrarlanan URL yok |
| Benzersiz slug | 5.953; **303 slug birden çok ID'de** (örn. `dus-aksesuarlari` 18021932 & 13003275) |
| Bozuk URL | 1 (`sauna-ekipmanlari`, ana adres ve `-c-80857470` iki kez; iki ID parçası aynı olduğu için ID 80857470 kurtarıldı, `urlAnomaly` ile işaretli) |
| Büyük harfli slug (`Icecekler`, `Ithal`) | 33 — Türkçe İ/ı'nın bozuk ASCII'leştirilmesi; olduğu gibi tutuldu |
| Yer tutucu ID | 27: `0` (`hepsiburada-com`) ve 2147483634…2147483646 (INT_MAX'a yakın; `kitaplar`, `telefonlar`, `muzik`, `filmler`, `giyim-ayakkabi`… eski üst başlık görünümlü) |
| ID aralığı | 0–2.147.483.646; 8 haneli 4.776, 5–7 haneli 1.376 |

Dosyada **ana/yaprak ayrımı, ebeveyn ID, derinlik ve durum yoktur**. 303 slug'ın birden çok ID'de görünmesi
aynı adın farklı dallarda geçtiğini gösterir ama hangi dallar olduğunu göstermez.

## Hiyerarşi

URL yalnızca `slug-c-<id>` taşır; **doğrulanmış hiçbir ebeveyn ilişkisi çıkarılamaz** ve kaydedilmedi.
Yalnızca gözlem: kardeş gibi görünen ID'ler bitişik (ör. 18021998, 18021999, 18022486) — bu bir ipucudur,
kanıt değil (2.145 ID kümesi sınırı; doğrulanmadı). Gerçek ağaç için resmî API (satıcı kimliği) ya da
kategori sayfası breadcrumb'ı gerekir.

## Trendyol karşılaştırması (ad eşitliği, ASCII katlama, "ve" atılır; ADAY eşleşme)

- 6.320 Hepsiburada kategorisinin **670'i** (%10,6) bir Trendyol kategorisiyle aynı adı taşır; bunlar
  Trendyol'un **548** farklı kategorisine denk gelir (3.867'nin %14,2'si). Bir Trendyol adı birden çok
  Hepsiburada ID'sine denk gelebilir. Doğrulama yok; ad eşitliği anlam eşitliği değildir.
- **5.650 Hepsiburada kategorisi Trendyol'da aynı adla yok.** Ad bazlı, kaba anahtar sözcük kümeleri
  (örtüşebilir; HB toplamı / bunlardan Trendyol'la eşleşen): kitap türleri 332 / 9, film-müzik-oyun konsolu
  184 / 8, oto-moto (araba, motosiklet) 396 / 21, yedek parça-filtre 101 / 5, evcil hayvan 161 / 4,
  gıda-içecek 68 / 9, ikinci el-yenilenmiş-outlet 10 / 0.
- Hepsiburada'ya özgü görünen türler: ince taneli **kitap alt türleri** (Trendyol'da tek "Kitap" kökü),
  **araç/motosiklet yedek parça ve aksesuar** dalları, **film/müzik/oyun konsolu** ve konsol "ikinci el /
  yenilenmiş / teşhir / outlet" kategorileri, **dijital dergi**, evcil hayvan ayrıntısı. Trendyol'da olup
  Hepsiburada dosyasında olmayanlar (örn. "Ek Hizmetler") bu dosyadan ayrıca çıkarılmadı.

## external_category (PR #205) ile birleştirme

Uyumlu: `source='hepsiburada'`, `external_id BIGINT`, `(source, external_id)` PK, `external_category_import`
sha256 kaydı, `external_category_map`, `external_category_usage`.

**Olduğu gibi yazılamaz**, çünkü 0096 şu alanları zorunlu kılıyor: `depth`, `is_leaf`, `path_ids`
(`cardinality = depth`), `(depth = 1) = (parent_external_id IS NULL)` ve `external_id > 0`. Düz sitemap bunları
bilmiyor; uydurmak "tahmini doğrulanmış gibi kaydetme" kuralına aykırı olur. Öneri (ayrı, geriye uyumlu
migration, #205 birleştikten sonra):
1. `depth`, `is_leaf`, `path_ids` NULL'lanabilir; CHECK'ler yalnızca `hierarchy_status = 'verified'` iken
   (Trendyol satırları `verified`; Hepsiburada sitemap satırları `unknown`).
2. Yeni sütunlar: `hierarchy_status`, `slug`, `source_url`, `name_basis` (`source`|`slug`), `source_attrs JSONB`.
3. `id = 0` (`hepsiburada-com`) içe aktarılmaz (ana sayfa); INT_MAX'a yakın 26 yer tutucu ID `source_attrs`
   içinde işaretlenerek alınır ya da dışarıda bırakılır (karar gerekir).
4. İçe aktarma kaynağı (`api`, `sitemap`) `external_category_import`'a yazılır; web ID'si ile API
   `categoryId` aynı olmayabilir, doğrulanana dek ayrı `source` değeri (örn. `hepsiburada_sitemap`) güvenli.
5. Üretici parametrelenir (kaynak başına ayrıştırıcı, ayrı tohum migration'ı).
