# 0171 — Sorgu niyeti sözleşmesi v2 (IntentV2): kaynak, uygulama kipi ve güvenli bağlama

Durum: Faz 1A (kullanıcıya etkisiz). İstek yoluna bağlı değil. İlgili: 0059, 0062, 0063,
0172 (Türkçe normalizasyon, ayrı iş), 0170 (anlamsal pilot, ayrı dal).

## Karar

1. **Gemini'nin görevi yalnızca niyeti yapılandırmaktır.** Çıkardıkları: ürün türü, rol
   (`main | accessory | part`), uyumlu cihaz, açıkça yazılmış marka, öznitelikler
   (`required | preferred | excluded`), açık bütçe, kullanım amacı, belirsiz alanlar ve en
   fazla bir soru önerisi. Her değer için ham metinden kanıt (`evidence`) verir. Ürün, fiyat,
   stok, mağaza, URL, SQL ya da puan üretmez. 0062'deki tek çağrının şeması genişler; yeni
   bir istek yolu çağrısı eklenmez.
2. **Kaynağı model değil, doğrulayıcı belirler** (`packages/core/src/intent/evidence.ts`):

   | Kaynak | Ne zaman |
   |---|---|
   | `explicit` | Kanıt, katlanmış ham sorguda ardışık tokenlar olarak birebir geçiyor |
   | `corrected` | Kanıt yalnızca normalizasyonun düzeltmesiyle eşleşiyor |
   | `inferred` | Kanıt yok ya da ham sorguyla ilişkisi kurulamıyor |

3. **Her değer dört kipten birine düşer** (`intent/validate.ts`):

   | Kip | Anlamı | Girebilenler |
   |---|---|---|
   | H | Sert filtre (sonuç dışlar) | Yalnızca `explicit` ve katalogda doğrulanabilir kolonlar: bütçe (kuruş), lexicon markası (dahil ya da `excluded_brands` ile hariç), `CATALOG_PRODUCT_TYPES` türü → `category.path` (yalnızca ana ürün aranıyorsa ve türün baş ismi kanıtta geçiyorsa) |
   | R | Sıralama ipucu (yalnızca sırayı değiştirir) | Uyumluluk, öznitelikler, rol, tür metni, kabul edilen düzeltilmiş değerler |
   | D | Yalnızca gösterim | `inferred` değerler, kullanım amacı, fiyat tercihi, uyumlu cihazın markası |
   | X | Atılır | Şema veya taksonomi dışı değerler, kanıtla çelişen değerler (ör. kanıtta olmayan sayı) |

   **Başlık tokenına dayanan hiçbir kriter H olamaz.** Katalogda yapılandırılmış uyumluluk
   ya da öznitelik verisi yok (`product.attributes` seyrek); bu yüzden uyumluluk ve olumsuz
   kriterler sonuç dışlamaz:
   - **Uyumluluk** üç kademede sıralanır: tam model eşleşmesi, model belirtmeyen genel ürün,
     yalnızca başka modeli adlandıran ürün. Hiçbiri dışlanmaz.
   - **Olumsuz öznitelik** ilgili ürünü alta iter. Karşıtı yalnızca sabit tablodan
     (`intent/antonyms.ts`) türetilir ve R kipinde tercih olarak eklenir.
   - Mevcut `product-title-guard.ts` davranışı değişmez.

4. **Çekirdek reddedilirse** (`product_type` metni ya da `role` geçersizse) tüm H ve R
   kriterleri D'ye iner. Güven puanı modelden alınmaz; doğrulama sonucundan türetilir.
5. **Soru yalnızca ürün türü anlaşılamadıysa engelleyicidir.** Diğer durumlarda arama
   yapılır ve soru isteğe bağlı bir öneri olarak kalır.
6. **Çağrı yönlendirme** (`intent/local-analysis.ts`, `intent/route.ts`): önce yerel analiz
   yapılır, Gemini koşullu çağrılır. Her karar neden kodlarıyla verilir.
   - Çağrı **oranı hedef değildir**; gözlenen bir çıktıdır.
   - Başlangıç eşikleri geçicidir. Faz 1B'de dev setinde kova bazında doğruluk kazancı,
     yanlış sert filtre, gecikme ve maliyetle kalibre edilir.
7. **Normalizasyonla sözleşme** (karar 0172):
   - **Tip ve sahiplik:** ortak tip `search/normalized-query.ts` normalizasyon işinindir. Niyet
     katmanı yapısal karşılığını `intent/normalized-query-adapter.ts`'te tanımlar ve yalnızca
     okur.
   - **Düzeltilmiş değer asla H olmaz.** R'ye girebilmesi için şunların hepsi gerekir:
     - güven eşiğin üstünde;
     - rakam/alfanümerik kod kümesi değişmemiş; bu bağımsız olarak da kontrol edilir
       ("s24" → "s23" reddedilir);
     - `span` ham metinle örtüşüyor;
     - `to` lexicon'da kanonik bir kayıt.

     Biri eksikse değer D'ye düşer.
   - **Gemini'ye ne gider:** yalnızca süzgeçten geçmiş ham metin. Normalizasyon ipucu
     gönderilmez.
   - **Diğer sahiplikler:** `fallback/stages.ts` ham metin aşaması, `ranking.ts` terimi,
     `query-resolution.ts` sürümleme, `/ara` çipleri ve `intent/**` bu işindir.
     `spelling/**` ve `normalized-query.ts` normalizasyon işinindir.
8. **Önbellek doğruluğu:**
   - **`query_interpretation` (v2):** ham model çıktısı saklanır ve her okumada güncel
     doğrulayıcı ile lexicon'dan yeniden geçer. Kimlik özeti (`intentV2ContractHash`) şunları
     kapsar: talimat, şema, ürün türleri ve `NORM_VERSION` (`normalizeQueryText` sürümü). v1
     özetinden farklıdır, bu yüzden v1 satırları etkilenmez.
   - **`query_resolution`:** satırlar `RESOLVER_VERSION` ve lexicon içerik özetiyle
     damgalanır (`parsed._resolver`).
     - Damgasız ya da farklı damgalı satır okunmaz; aynı istekte yeniden ayrıştırılır.
     - Ayrıştırıcı kodu değişince `RESOLVER_VERSION` artırılır.
     - Lexicon'a panel dışından yazılınca değişiklik en geç süreç içi lexicon önbelleğinin
       ömrü (5 dk) sonunda görünür.
     - Migration gerekmez.

## Gerekçe

- Geçerli JSON yanlış içerik taşıyabilir. Kanıtı olmayan ya da katalogda doğrulanamayan
  değer filtre olursa doğru ürünler sessizce kaybolur (yanlış negatif), ve kullanıcı bunu
  göremez. Sıralama ipucu yanlış olsa bile ürün listede kalır.
- `query_resolution` tablosunda TTL ya da sürüm yoktu. Panel düzenlemesi tabloyu
  temizliyordu, ama ayrıştırıcı kodu değişince ya da toplu iş lexicon'a yazınca eski
  ayrıştırma süresiz kullanılıyordu.

## Reddedilen alternatifler

- **Her sorguda Gemini:** maliyet ve gecikme her aramaya eklenir, kota darboğazı yaratır;
  basit sorgularda doğruluk kazancı yok.
- **Sohbet şemasını (`chat/contract.ts`) `/ara` için kullanmak:** serbest kategori ve marka
  metni var; rol, uyumluluk, olumsuzluk ve kanıt yok.
- **Uyumluluk ve olumsuz kriteri başlık tokenıyla dışlamak:** başlıkta model ya da özellik
  yazmayan uygun ürünler kaybolur.
- **Normalize edilmiş metni modele vermek:** yanlış düzeltme modelin anlamasını bozar, ve
  normalizasyon sürümü değiştikçe model önbelleği boşa gider.
- **LLM ile yeniden sıralama:** MVP'de yok. Ek istek yolu çağrısı ve iki kat gecikme
  getirir; pilot sonucuna göre ayrı karar konusu.

## Entegrasyon güvenlik kapısı (3–4 Kasım 2026, `origin/main` 4910bd80)

| # | Sonuç |
|---|---|
| G1 | Geçti. Çalışma dalları `origin/main`'den; 9f120087 (anlamsal pilot) ata değil |
| G2 | Kayıt: pilot `product-title-guard.ts`'e `PART_REQUEST` ekliyor (+8/−1). Bu iş o dosyaya dokunmaz. Pilotun bu değişikliği varsayılan aramayı bayraktan bağımsız değiştirir; kararı pilot hattınındır |
| G3 | Çakışma: pilotun `0104_embedding_content_hash`/`0105_*` dosyaları, main'deki `0104_drop_product_title_fold_trgm` ile aynı numarayı kullanıyor; pilotta ayrıca `0106_*.draft` var. Bu iş migration kullanmıyor. Gerekirse 0107+ |
| G4 | Geçti. Tek kullanımlık temiz pgvector DB'de `origin/main`: arama ve fallback entegrasyon testleri 68 geçti (8 performans testi `SEARCH_PERF` gerektirdiği için tasarım gereği atlandı) |
| G5 | Temiz DB'de pilot 9f120087: 75 test geçti. Pilot raporundaki "3 kırık test" kod hatası değil, yerel DB kirliliği. Not: CI `integration` işi `src/search/search.integration.test.ts`'i koşturmuyor; ayrı bir CI açığı |
| G6 | Temel: 15 bin ürünlük pilot katalog kopyasında `eval:search` iki koşuda birebir aynı (zamanlama hariç). Sınır: JSON ürün kimliği içermiyor ve 38 sorgunun alaka etiketleri bu katalogla eşleşmiyor (P@5 = 0). Faz 2'de "bayrak kapalı birebir" karşılaştırması için çıktıya ürün kimlikleri eklenecek |

## Kapsam dışı (bu kararla)

İstek yoluna bağlama (`QUERY_INTENT_V2` bayrağı), niyet → arama eşlemesi, arayüz çipleri ve
geri bildirim olayı Faz 2'dir. Ücretli Gemini ölçümü (Faz 1B) ayrı kullanıcı onayı ister.
