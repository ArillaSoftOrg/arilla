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
  değerlendirmesinde **bir kez** koşulur. SHA-256 (`query-normalization.holdout.json`, 90 sorgu): `760537e6d436d563585907029ba23bb087f2a540fd797a77221a524aa87a183b`. Kurallardan önce ayrı commit ile eklendi.

Başarı ölçütleri önceden sabittir. Doğrulama kümesinde:

- hatalı yazılmış sorgularda doğru normalizasyon ≥ %85;
- yanlış düzeltme ≤ %2, "düzeltilmemeli" kategorisinde ≤ %1;
- doğru yazılmış sorgularda değişiklik yok ≥ %99;
- rakamlı kod korunması %100, marka korunması ≥ %98;
- normalizer p95 ≤ 3 ms.

Üretim sorguları değerlendirmeye yalnız ayrı kullanıcı onayıyla katılır.

## Faz 1 sonucu (yalnız geliştirme kümesi; doğrulama kümesi koşulmadı)

`node packages/core/scripts/eval-normalization.ts --split dev`: 137 sorgu, dağarcık 2.937 kelime.
Dağarcık kaynakları: Trendyol kategori adları, lexicon migration'ları, değerlendirme marka listesi
ve tohum.

| Ölçüt | Sonuç | Eşik |
|---|---|---|
| Doğru normalizasyon (düzeltme bekleyen 52 vaka) | %96,2 | ≥ %85 |
| Yanlış düzeltme, genel / "düzeltilmemeli" | %0 / %0 | ≤ %2 / ≤ %1 |
| Doğru yazılmışta değişmeme | %100 | ≥ %99 |
| Kod / marka korunması | %100 / %100 | %100 / ≥ %98 |
| Gecikme p50 / p95 | 0,02 / 1,05 ms | p95 ≤ 3 ms |

Kalan iki ıska (yanlış düzeltme değil):

- "kisa": dağarcıkta "kısa" yok;
- "ksiaomi": güven eşiğin altında kalıyor.

Sabit tohumlu sentetik regresyon testi (300 kelime, tek harf silme ya da yer değiştirme) şunları
ölçüyor:

- doğru kelimeler hiç değişmiyor;
- düzeltme oranı ≥ %60;
- doğru kelimenin ne hedefte ne alternatiflerde olduğu yanlış düzeltme oranı ≤ %5.

Bunlar gerçek kelime belirsizlikleri ("taşama" → "taşıma"); bu durumlarda güven düşer.

Dürüstlük notları:

- **Ayarlama yalnız geliştirme kümesiyle yapıldı.** Kurallar ve eşikler bu kümedeki hatalara
  bakılarak genel kurallarla düzeltildi; sorguya özel istisna yok. Kurallar: kısa token,
  yabancı yazım, ek tabanlı bilinen kelime, karakter geri kazanımında Türkçe harfin
  silinmemesi, fonetik indirimin yalnız yabancı kökenli hedeflere uygulanması.
- **Tohum ve geliştirme hedefleri örtüşüyor.** `SEED_WORDS` (iphone, ipad, airpods, galaxy,
  redmi, powerbank, usb, hdmi) geliştirme kümesindeki bazı hedefleri kapsar; bu yüzden
  geliştirme sonucu iyimserdir. Doğrulama kümesindeki hedefler tohumda yok.
- **Marka listesi yalnız değerlendirme içindir.** Üretimde dağarcık `brand` tablosundan gelir
  (en az bir ürünü olan markalar, en fazla 20.000). Bu tablonun gürültüsü Faz 2'de yerel
  DB'de ölçülmelidir.
- **İngilizce dağarcık açığı.** Katalog başlıklarındaki İngilizce kelimelerin çoğu
  ("phone", "stand", "holder") dağarcıkta yok. Bunlar "bilinmeyen kelime" olarak korunuyor ve
  düzeltilmiyor (yabancı yazım ve ek kuralları). Ancak bilinmeyen İngilizce kelimeye yakın bir
  Türkçe kelime varsa risk sürer. Faz 2 arama ölçümü bu riski göstermelidir.

## Faz 2: arama entegrasyonu (bayrak arkasında, varsayılan `off`)

**Bağlantı.** `/ara` metin araması tek bir çağrı yapar: `normalizeParsedForSearch(db, parsed)`
(`search/spelling/apply.ts`). Çağrı, `resolveQuery` ya da planlanmış sohbet sorgusundan
sonra gelir.

- `off`: iş yapılmaz, aynı nesne döner.
- `shadow`: normalizasyon hesaplanır; yalnız sayı ve sabit kod loglanır (sorgu metni yok).
- `on`: düzeltmeler `parsed` nesnesinin kopyasındaki metin slotlarına alternatif olarak eklenir.

**Uygulama kuralları.**

- Özgün token slotun ilk elemanı olarak kalır. Düzeltilmiş ifade ve onun `lexicon` eş
  anlamlıları aynı slota eklenir ("şarz aleti" → "şarj aleti", "charger"); Türkçe sorgudan
  İngilizce başlığa köprü bu yolla kurulur.
- `filters` ve `unparsed` değişmez.
- Olumsuzlanan kelime ("zamzung olmasın") aramada düzeltilmez.
- Önbellekteki `parsed` nesnesine dokunulmaz; bu birim testle doğrulandı.
- Her hata özgün `parsed` ile devam eder.
- Yönetim konfig ekranında `QUERY_NORMALIZATION_MODE` satırı gösterilir.

**Arama etkisi.** Yerel ve tek kullanımlık veritabanında, 15 bin ürünlük pilot katalog kopyası
üzerinde ölçüldü (`node packages/core/scripts/eval-normalization-search.ts`). Ölçüm etiketsiz ve
karşılaştırmalıdır; aynı veritabanı ve aynı kod kullanıldı, yalnız bayrak değişti. Yalnız
geliştirme kümesi kullanıldı.

| Ölçüt | `off` | `on` |
|---|---|---|
| Hatalı yazılmış 52 sorguda sıfır sonuç | %69,2 | %40,4 |
| — doğru yazılmış eşdeğeri sonuç veren 34 sorguda sıfır sonuç | %52,9 | %8,8 (göreli −%83) |
| Doğru yazılmış eşdeğerin ilk 10'uyla örtüşme | 0,660 | 0,933 |
| Doğru yazılmış 85 sorguda ilk 10'u değişen | — | 0 |
| 38'lik `bootstrap-queries.json` setinde ilk 10'u değişen | — | 0 |

Hatalı yazılmış 52 sorgunun 18'inde doğru yazılmış eşdeğer de sonuç vermiyor: katalogda
karşılığı yok, düzeltme bunları kurtaramaz. Eşdeğer sorgu, veri kümesindeki beklenen düzeltmeyle
üretilir. Bu ölçüm "doğru ürün bulundu" demez; "düzeltilmiş sorgunun sonucuna yaklaşıldı" der.

**Sınırlar.**

- Yerel veritabanında yalnız 32 marka var. Üretim `brand` tablosunun gürültüsü ölçülmedi;
  üretime erişim yok, `shadow` açılışında gözlenmeli.
- `scale.perf` (milyon ürün) bu turda koşulmadı. Slot başına en fazla 2 düzeltme alternatifi
  eklenir ve `lexicon` eş anlamlıları zaten mevcut yoldan gelir; aday kümesi sınırı
  (`CANDIDATE_LIMIT`) değişmedi.

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
