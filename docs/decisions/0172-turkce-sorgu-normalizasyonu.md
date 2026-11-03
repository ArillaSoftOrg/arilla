# 0172 — Türkçe sorgu normalizasyonu: yazım düzeltme, ek çözümleme, fonetik eşleme

Durum: **taslak (Faz 1)**. Davranış değişikliği yok; bayrak varsayılan kapalı.

## Bağlam

Katalog başlıklarının ~%99,9'u İngilizce (AliExpress). Kullanıcılar Türkçe, eksik Türkçe
karakterle, yazım hatasıyla ve fonetik yazıyor ("zamzung şarz aleti", "blutut kulaklık",
"ayfon 15 kilif"). `/ara` metin araması token düzeyinde pg_trgm kapısı (karar 0029) ve `lexicon`
eş anlamlıları ile çalışır. Bulanık adım yalnız sıfır sonuçta ve 5+ harfli kelimelerde devreye
girer. Kısmi sonuç dönen sorguda yanlış yazılmış marka sessizce düşer. Eş anlam eşleşmesi
katlanmış tokenlarda birebir olduğu için ekli biçimler ("kılıfı", "pedi") tek tek yazılmak
zorunda kalır.

## Karar

1. **Saf, deterministik normalizasyon katmanı.** `packages/core/src/search/spelling/`.
   DB, ağ ve model çağrısı yapmaz. Girdisi bellek içi sözcük dağarcığıdır; istek yolunda ek DB
   çağrısı yoktur. Dağarcık mevcut verilerden gelir: `brand`, `category` adları, `lexicon`
   yüzeyleri ve küçük bir tohum. Yeni büyük sözlük yazılmaz.
2. **Ortak sözleşme:** `packages/core/src/search/normalized-query.ts` (`NormalizedQuery`).
   Normalizasyon üretir; niyet katmanı (karar 0171) ve arama tüketir. Tek sözleşmedir;
   değişiklikleri yalnız geriye uyumlu biçimde, bu dosyada yapılır.
3. **Görev ayrımı.** Normalizasyon yazım düzeltme, fonetik eşleme, Türkçe ek çözümleme ve
   marka/model adayı üretir. Ürün niyeti ve rol (ana ürün/aksesuar/parça) kararının tek kaynağı
   niyet katmanıdır. Normalizasyon yalnız bağlayıcı olmayan `hints` üretebilir.
4. **Düzeltme bir alternatiftir, yer değiştirme değildir.** Orijinal token korunur. Düzeltme
   arama slotuna ek alternatif olarak girer; slot başına en fazla 2 alternatif eklenir.
   Düzeltme sert filtreye (marka filtresi dahil) dönüşmez.
5. **Korumalar.** Şunlar asla düzeltilmez:
   - dağarcıkta birebir bulunan kelime;
   - rakamlı model kodu, sayı ve birim;
   - sürüm eki (pro, max…);
   - fiyat ifadesi ve olumsuzluk işareti.

   Belirsizlikte en fazla 2 aday döner; düşük güvende hiçbir düzeltme üretilmez.
6. **Önbellek kimliği değişmez.** Anahtar `norm = normalizeQueryText(raw)` olarak kalır;
   `corrected` hiçbir önbellekte anahtar olmaz. Normalizasyon çıktısı saklanmaz, her istekte
   hesaplanır ve `normalizerVersion` (kural sürümü + dağarcık hash'i) taşır. Önbellekteki
   `parsed` nesnesi değiştirilmez; normalizasyon yalnız kopyasına uygulanır.
7. **Bayrak:** `QUERY_NORMALIZATION_MODE = off | shadow | on`, varsayılan `off`. `off` iken
   mevcut arama davranışı birebir aynıdır.

## Sahiplik (karar 0171 ile)

| Normalizasyon (bu karar) | Niyet katmanı (0171) |
|---|---|
| `search/normalized-query.ts`, `search/spelling/**`, `eval/datasets/query-normalization*`, `scripts/eval-normalization.ts` | `intent/**` (adapter dahil), `clarification/interpreter.ts`, `query-resolution.ts` sürümleme, `realtime-interpretation.ts`, `fallback/stages.ts` ham metin aşaması, `ranking.ts` terimi, arayüz çipleri |

Ortak temas noktaları (`admin/config-view.ts`, `search/types.ts`, `docs/search.md`) PR
sırasıyla birleştirilir. Semantik pilot dalı (karar 0170) bu işin kapsamı dışındadır; o daldan kod
taşınmaz ve `product-title-guard.ts` bu işte değişmez.

## Değerlendirme

- **Geliştirme kümesi:** kurallar ve eşikler yalnız bununla ayarlanır.
- **Regresyon testleri:** CI'da koşar; sentetik hata üreteci ve mevcut 38 sorguluk set dahil.
- **Bağımsız doğrulama kümesi:** kurallardan önce yazılıp dondurulur. Entegre sistemin son
  değerlendirmesinde **bir kez** koşulur. SHA-256: _(Faz 1'de doldurulacak)_.

Başarı ölçütleri önceden sabittir. Doğrulama kümesinde:

- hatalı yazılmış sorgularda doğru normalizasyon ≥ %85;
- yanlış düzeltme ≤ %2, "düzeltilmemeli" kategorisinde ≤ %1;
- doğru yazılmış sorgularda değişiklik yok ≥ %99;
- rakamlı kod korunması %100, marka korunması ≥ %98;
- normalizer p95 ≤ 3 ms.

Üretim sorguları değerlendirmeye yalnız ayrı kullanıcı onayıyla katılır.

## Reddedilen alternatifler

- **Zemberek / ağır morfolojik çözümleyici:** JVM bağımlılığı istek yolunda olmaz. Markaları,
  İngilizce ürün adlarını ve fonetik yazımları bilmez.
- **Hunspell / genel sözlük denetleyicisi:** alan dışı öneriler getirir; marka adlarını hata
  sayar.
- **pg_trgm eşiğini düşürmek ya da her sorguda bulanık arama:** kısa kelimede ve fonetik
  yazımda zayıf kalır, DB yükünü artırır, yanlış pozitifleri kontrolsüz bırakır.
- **Her sorguda Gemini:** kural 1 istisnalarının dışındadır; maliyet ve gecikme getirir.
  Gemini (0062) yalnız ham metni alır.
- **Embedding ile çözmek:** ayrı iş (0170). Marka/model yazım hatasını güvenilir çözmez.
