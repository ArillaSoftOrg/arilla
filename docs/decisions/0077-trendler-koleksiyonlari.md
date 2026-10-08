# 0077 — Trendler: editoryal ürün keşfi koleksiyonları

## Karar

1. `/trendler` (liste) ve `/trendler/<slug>` (detay) eklenir. Bir trend **blog değil,
   ürün keşfi koleksiyonudur**: kısa kapak + başlık + tek cümle açıklama, hemen altında
   ürün ızgarası. Makale gövdesi, SEO paragrafı, `Article`/`BlogPosting` yapısal verisi
   yoktur. Ürün tıklaması mevcut `/urun/<slug>` fiyat karşılaştırma sayfasına gider.
2. İki yeni tablo (migration 0056): `trend` (slug UNIQUE, `category`, `status`
   draft/published/archived, `trend_type` evergreen/seasonal/campaign, `featured`,
   `sort_order`, `active_from/until`, `hero_image_url` boş olabilir) ve `trend_product`
   (PK `(trend_id, product_id)`, ertelenmiş UNIQUE `(trend_id, sort_order)`, FK CASCADE).
   Tablo adları depo kuralı gereği tekildir.
3. Ürün seçimi **toplu işle** yapılır: `services/ingest/curate` (Python). Profil
   (core/boost/exclude terimleri, kategori, fiyat tavanı) → indeksli SQL ön süzgeç →
   puanlama → çeşitlilikli seçim → `trend_product` yeniden yazımı. İstek yolu yalnızca
   okur (kural 2); modele gitmez (kural 1). Varsayılan **kuru koşu**; `--apply` yalnızca
   yerel veritabanında, uzağa yazmak ayrıca `--allow-remote` ister.
4. 50 trendin **kimliği** (başlık, açıklama, tür, sıra) migration ile tohumlanır; ürün
   **bağları** tohumlanmaz (katalog ortama özeldir, `curate` doldurur).
5. Arayüzde bir trend ancak `MIN_PUBLIC_TREND_PRODUCTS` (4) gösterilebilir ürünü
   (görselli + fiyatlı + stokta) varsa görünür; yoksa listede yok, detay adresi 404.
   Gösterilebilirlik okuma anında uygulanır: `curate`'tan sonra stoktan düşen ürün kırık
   kart üretmez. Zorlama doldurma yok.
6. Kapak sırası: `hero_image_url` → sort_order 0 ürünün görseli → yer tutucu kutusu.
7. `/trendler` bir ürün rotasıdır: `requireProductAccess`, proxy ürün kapısı
   (`PUBLIC_PRODUCT_PATH_PREFIXES`), `robots.txt` ve sitemap ürün kapalıyken `/kesfet`
   ile aynı davranır. Trend sayfaları **günlük değişmez** (sıra `sort_order` ve
   `curate` koşusuyla değişir, gün ile değil).
8. Navigasyon: üst menü/altbilgi/404'teki "Trendler" artık `/trendler`e gider. Ana
   sayfadaki `#trendler` bölümü gerçek trendlerden (önce `featured`, ilk üç) beslenir;
   veri yoksa eski demo sete düşer.
9. Arayüz metni kuralı: başlık #40 kullanıcı listesinde "Pahalı Görünüp Ucuz Olanlar"
   idi; `docs/glossary.md` "ucuz" kelimesini arayüzde yasakladığı için
   **"Pahalı Görünen Uygun Fiyatlılar"** olarak tohumlandı. Kural değişirse tek satır
   (`trend.title`) güncellenir.

## Gerekçe

Dupe'taki "Obsessions" yapısı keşfi ürün odaklı tutar; blog içeriği bakım yükü ve
"yapay çeviri" riski getirir. Seçimi veritabanında ve toplu işte tutmak sayfayı hızlı,
deterministik ve denetlenebilir yapar. Eşik altı trendleri gizlemek, alakasız ürünle
doldurmaktan daha doğrudur: katalog büyüdükçe trendler kendiliğinden görünür.

## Reddedilen alternatifler

- `trend_snapshot` (0009) genişletmek: dönemlik/algoritmik/sponsorlu bir yapı;
  `product_ids BIGINT[]` FK bütünlüğü vermez. Ayrı ve dokunulmamış kalır.
- Ürün listelerini TS/JSX içine gömmek: katalogla senkron kalmaz, kural 3/7 ruhuna aykırı.
- İstek anında anahtar kelimeyle arama: sonuç her istekte değişir, sayfa kararlı olmaz.
- Python'dan HTTP ile TS'yi tetiklemek: mimari sınırı bozar. Tek kanal PostgreSQL.
- Modelle (LLM) trend-ürün eşleştirme: maliyet ve doğrulanamazlık; ilk sürüm kural tabanlı.

## Bilinen sınırlar

- Katalog bugün dar (kozmetik, kadın/erkek giyim ve ayakkabı-çanta, ev tekstili,
  klavye/mouse). Kahve köşesi, KYK odası, kampanya ve "pahalı görünen" trendleri bugün
  gösterilecek ürün bulamaz; profilleri `core` boş (`note` ile gerekçeli) ya da eşik
  altı kalır. Yeni mağaza/feed geldikçe `python -m curate --apply` yeniden koşulur.
- `featured` ve yayın pencereleri (`active_from/until`) editoryal tahmindir; veri
  olarak güncellenebilir (migration gerekmez).
