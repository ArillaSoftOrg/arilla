# 0136 — Arama olay kuyruğu (search_outbox) tüketicisiz kalır; arama PostgreSQL'i doğrudan okur

**Tarih:** 18 Ekim 2026
**Durum:** Önerildi (PR). 0111'in "harici arama motoru gelince tüketici eklenir" notunu netleştirir.

## Sorun

Üretimde `search_outbox` 5.572.716 kayıt; `processed_at` dolu satır **0**, en eski işlenmemiş olay
14 Ekim 2026. Bu bir kuyruk tıkanması gibi görünüyor.

## Bulgular (kod ve ölçümle doğrulandı)

1. **Üreticiler:** `catalog_build/publish.py` (yayınlanan her ürün için `source_listing_published`),
   `feeds/sync.py` (teklif eklendi/yeniden etkinleşti/parmak izi değişti: `feed_*`; besleme dışı
   kalan teklif: `delete/feed_missing`). Üretimdeki ~5,57 M ≈ 2,77 M yayın + ~2,8 M teklif eklemesi.
2. **Tüketici yok:** depoda `processed_at`'i yazan, `search_outbox`'ı okuyan hiçbir kod, worker,
   cron ya da systemd birimi yok. 0065/0111 tabloyu "harici arama motoru gelince" için ayırmıştı.
   VPS `catalog-publish` betiği outbox sayısını yalnızca yayın doğrulaması için okur.
3. **Arama outbox'a bağlı değil:** `/ara`, `/ara/gorsel`, `/ara/link` ve `/sohbet` doğrudan
   `product`/`offer` tablolarını okur; PostgreSQL indeksleri (`product_title_fold_*_trgm`, 0083)
   yazımla aynı işlemde günceldir. Yerel 1,04 M ürünlük katalogda (1 M yalnız USD teklifli
   AliExpress benzeri) yeni yayınlanan ürün aynı anda aramada bulunur:
   - `/ara` 33 sorgu: p50 94 ms, p95 887 ms (geçici yükte en kötü 3,6 sn; tekrar ölçümde ≤ 1,2 sn).
   - Sohbet (`searchByIntent`, 4 sn sınırı) 10 sorgu: p50 485 ms, p95 1,1 sn; zaman aşımı yok.

Yani %0 işlenmiş olması bir arıza değil, tüketicinin hiç yazılmamış olmasıdır; arama, sohbet ve
ürün erişimi bundan etkilenmez.

## Karar

1. **Tüketici/indeksleme servisi yazılmaz.** İşleyecek harici bir hedef yok; boş bir tüketici
   satırları "işlendi" diye işaretlemekten başka bir iş yapmazdı (yanlış sinyal).
2. **Üreticiler korunur.** Kayıtlar yayın doğrulamasında kullanılıyor ve ileride harici arama
   motorunun ilk doldurma sonrası artımlı değişim kaynağıdır.
3. **Kayıt silinmez, işlenmiş işaretlenmez.** Saklama/sıkıştırma (ör. aynı varlığın eski olaylarını
   kaldırmak) ayrı bir karardır; harici motor kararıyla birlikte verilir.
4. **Görünürlük:** `pnpm db:health` salt okunur rapora "Arama indeksi olay kuyruğu" bölümü eklenir:
   toplam (tahmin), işlenmemiş (kısmi indeksten tam sayım), boyut, en eski olayın yaşı ve "tüketici
   yok" notu. Yönetim kapsam kaydında sinyal `unmeasured` → `data_no_ui`.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Outbox'ı işleyen worker | Hedef yok; arama doğrudan PostgreSQL; gereksiz servis ve yük |
| Satırları `processed_at = now()` ile kapatmak | İşlenmeden işlendi demek; gelecekteki tüketici için veri kaybı |
| Üretimi kapatmak | Yayın doğrulaması (`catalog-publish`) bozulur; gelecekteki değişim kaynağı kaybolur |
| Toplu silme | Geri alınamaz; saklama kuralı henüz kararlaştırılmadı |

## Sonuçlar

- Maliyet: satır başına küçük bir ekleme (ürün yazımının WAL'i yanında ihmal edilebilir) ve
  kısmi `search_outbox_pending_idx` tüm satırları taşır. Büyüme yayın/besleme değişimiyle orantılı.
- Harici arama motoru gündeme gelirse: ilk doldurma tablolardan, sonrası bu kuyruktan; o kararda
  tüketici (artımlı, yeniden başlatılabilir, idempotent) ve saklama birlikte tasarlanır.
- Bilinçli kapsam dışı (0129 madde 6, değişmedi): link araması aday üretimi, mağaza karşılaştırma
  ve internet sonucu katalog görseli TRY-only; yalnız USD teklifli AliExpress ürünleri orada yoktur.

## Ek A — Uzun vadeli büyüme ve güvenli saklama seçenekleri (18 Ekim 2026)

**Boyut (ölçüldü, yerel 500 bin satır):** satır başına ~143 B (yığın 89 B + birincil anahtar 27 B +
kısmi `search_outbox_pending_idx` 27 B). Üretimdeki 5,57 M ≈ **~800 MB**.

**Büyüme kaynağı:** yayın ürün başına bir kez yazar (sınırlı). Asıl büyüme `feeds/sync.py`:
teklifin parmak izi (fiyat dahil) her değiştiğinde bir `feed_change` satırı. AliExpress fiyatları sık
değiştiğinden tam bir senkronizasyon günde ~2,8 M satıra (~400 MB/gün) kadar çıkabilir; gerçek oran
ölçülmedi. Ölçüm: `pnpm db:health` "Arama indeksi olay kuyruğu" bölümünü birkaç gün aralıkla
karşılaştırmak (toplam ve en eski olay).

| Seçenek | Ne yapar | Kayıp | Ön koşul |
| --- | --- | --- | --- |
| A. Bugünkü gibi bırak + izle | Hiçbir şey silinmez | Yok | — (bu karar) |
| B. Varlık başına sıkıştırma | Aynı `(entity, entity_id)` için yalnız en yeni olay kalır | Ara durumlar (tüketici zaten son hali okur) | Ayrı karar; parti parti, `processed_at` dokunulmaz |
| C. Üretimi daralt | Yalnız fiyat değişiminde `feed_change` yazılmaz (fiyat `price_point`'ta) | Yok (aramayı etkilemez) | Ayrı karar; yayın doğrulaması (`catalog-publish`) yalnız `source_listing_published` sayar |
| D. Aylık bölümleme | Eski ay `DROP PARTITION` ile ucuz silinir | Saklama süresi dışı | Migration + tablo yeniden kurulumu; harici motor kararıyla |
| E. Süreli saklama | N günden eski satır silinir | N günden eski değişim | Harici motor ilk doldurmayı tablolardan yaptığında |

**Güncelleme (karar 0143):** C uygulandı, genişletilerek: `feed_change` yalnız başlık/marka/kategori/kapak
görseli değişince yazılır (fiyat, stok, indirim, komisyon yazmaz).

**Öneri:** şimdilik A. Günlük büyüme ölçüldüğünde ~100 MB/gün'ü (≈ ayda 3 GB) aşıyorsa önce C (en
ucuz, kayıpsız), gerekirse B. D/E harici arama motoru kararıyla birlikte. Hiçbiri bu karar kapsamında
uygulanmaz; 5.572.716 kayıt silinmez ve işlenmiş işaretlenmez.

## Ek B — Yalnız USD teklifli AliExpress ürünleri ve arama politikası

Fiyat özeti TRY-only'dir (`offer_count`, `min_price`; karar 0127): yalnız USD teklifli ürün
`offer_count = 0`, `foreign_offer_count > 0`. Yüzey bazında (karar 0129, 0132):

| Yüzey | AliExpress (yalnız USD) ürünü | Not |
| --- | --- | --- |
| `/ara` metin araması | **Görünür** | Ayrı aday bölümü + `product_title_fold_foreign_trgm` (0083); sıralamada yurt dışı güven ×0,8 |
| `/sohbet` | **Görünür** | Aynı arama yolu (`searchByIntent`), 4 sn sınırı |
| Ürün sayfası, alternatif şeridi | **Görünür** | Tutar kendi para biriminde; kur varsa "yaklaşık TL" |
| TL fiyat süzgeci (`price_min/max`) | Kur yoksa **görünmez** | Kursuz tutar NULL; kur uydurulmaz (0132) |
| "En iyi fırsatlar" sekmesi | **Görünmez** | TRY-only (0129 B.4) |
| `/ara/gorsel` | Yalnız görsel embedding'i varsa | Uygunluk 0129 #2'de açık; embedding toplu iştir (`enrich`), maliyetli |
| `/ara/link` aday üretimi, mağaza karşılaştırma | **Görünmez** | Bilinçli TRY-only (0129 #6) |
| İnternet sonucu katalog görseli | **Görünmez** | Bilinçli TRY-only (0129 #6) |

Bu tabloyu değiştirmek (ör. link aramasında yurt dışı aday) ayrı bir ürün kararıdır.

## Ek C — Bu çalışmanın dışındakiler

- **Marka/kategori eksikliği** ayrı görevdir: sınıflandırma altyapısı #177 ile `main`'de (karar 0133);
  üretimde `classify sources/report` (salt okunur) → `products --confirm` → `lexicon --apply`
  sırası kullanıcı onayıyla çalıştırılır.
