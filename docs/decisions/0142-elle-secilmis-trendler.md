# 0142 — Elle seçilmiş (editoryal) trend koleksiyonları

**Tarih:** 22 Ekim 2026
**Durum:** Önerildi (PR). Migration 0095 (0092/0093 karar 0140'a, açık PR #201, ayrılmıştır).
**İlişkili:** 0077 (trend koleksiyonları)

## Sorun

`services/ingest/curate --apply`, okuduğu her trend için `trend_product` bağlarını tek işlemde
"sil + ekle" ile yeniden yazar (0077 §3). Profili olmayan ya da eşiğin altında kalan trendin
bağları **temizlenir**. Editörün gerçek ürünlerle elle kurduğu bir koleksiyon, filtresiz ilk
`curate --apply` koşusunda sessizce silinirdi. Depoda `trend_product`'ı yazan tek yol bu iştir
(yönetim paneli yalnızca `trend.status/featured/sort_order` yazar).

## Karar

1. `trend.curation TEXT NOT NULL DEFAULT 'auto' CHECK (curation IN ('auto','manual'))`
   (migration 0095). Bağların sahibi trend düzeyinde tek alandır.
   - `auto`: bugünkü davranış; curate okur, puanlar, yeniden yazar.
   - `manual`: bağları editör yazar; curate bu trendi **listelemez ve yazmaz**.
2. Mevcut trendler varsayılanla `auto` olur; otomatik kürasyonun çıktısı değişmez.
3. Curate tarafı (ayrı PR, `services/ingest`):
   - `load_trends` yalnızca `curation = 'auto'` trendleri döner (`--slug` ile istense bile).
   - Yazım yolu, silmeden önce trend satırını `SELECT … FOR UPDATE` ile kilitler ve
     `curation`'ı yeniden okur; `auto` değilse hiçbir şey yazmaz. Koşu sürerken trendi
     `manual`'a çeviren eşzamanlı bir işlem ya bu kilidi bekler (curate'in yazdığı otomatik
     bağlar COMMIT'le görünür, editör sonra kendi bağlarını yazar) ya da curate onun
     COMMIT'ini bekler ve `manual` gördüğü için atlar. Arada elle bağlar silinemez.
   - Kuru koşu yine sunucu tarafında `READ ONLY` işlemdir; hiçbir şey yazmaz.
4. `manual` → `auto` dönüşü bilinçli bir editör kararıdır: sonraki `--apply` bağları
   yeniden yazar.
5. Görünürlük kuralı değişmez (0077 §5): manuel trend de ancak `MIN_PUBLIC_TREND_PRODUCTS`
   gösterilebilir ürünle görünür; okuma yolu `curation`'a bakmaz.

## Reddedilen alternatifler

- **Ürün başına sabitleme (`trend_product.pinned`)**: curate'in silme/sıra yazımını ertelenmiş
  `(trend_id, sort_order)` benzersizliğiyle birlikte karmaşıklaştırır; ilk ihtiyaç tamamen elle
  seçilmiş koleksiyon. Karışık (yarı otomatik) koleksiyon gerekirse ayrıca ele alınır.
- **Profili olmayan trendi atlamak**: örtük; profil sonradan eklenince elle seçim yine silinir.
- **Yönetim panelinde ürün seçici / CMS**: kapsam dışı. Bağlar şimdilik gözden geçirilmiş
  veri migration'ı ya da yerel SQL ile yazılır.
