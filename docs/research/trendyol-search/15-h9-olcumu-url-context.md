# H9 ölçüldü: Gemini URL Context Trendyol fiyatını ne kadar doğru veriyor? (2026-10-14)

Belge 14'teki düzenek ücretsiz bir API anahtarı bekliyordu. Bu ölçüm anahtarsız ve **maliyetsiz**
yapıldı: Google AI Studio arayüzünde **ücretli anahtar seçili değildi** ("No API key selected").
Google'ın fatura SSS'sine göre arayüz kullanımı, ücretli anahtar bağlanmadıkça ücretsizdir.

Ham sonuçlar: [`data/h9-url-context-olcumu.json`](data/h9-url-context-olcumu.json). Model çıktısının
kendisi saklanmadı (belge 14 §2.4 kuralı); yalnız eşleşme kararı, sapma yüzdesi ve kendi tarayıcı
gözlemimiz var.

## 1. Düzenek

| | |
|---|---|
| Model | Gemini 3 Flash Preview (AI Studio varsayılanı). **Üretimdeki model değil** (`gemini-3.5-flash-lite`, `web-search/config.ts`) |
| Araç | Yalnız URL Context. Google Search grounding ayrı denendi (§4) |
| İstem | "Yalnız sayfada birebir yazanı ver; okunamadıysa söyle; tahmin etme" + satır başına JSON |
| Yer gerçeği | Kullanıcının Chrome'u, `trendyol.com` sekmesinden aynı origin `fetch` (normal ziyaret, 2 sn aralık). JSON-LD `offers.price`, gömülü `discountedPrice` değerleri, satıcı |
| Zaman | Gemini okumasının **önünde ve arkasında** iki doğruluk turu (T1, T2). T1 ile T2 aynıydı, yani farklar ölçüm sırasında oluşmuş fiyat değişimi değil |
| Eşleşme | Gemini ana fiyatı, canlı sayfanın JSON-LD fiyatına ya da ilk gömülü `discountedPrice`'a kuruşu kuruşuna eşit |

## 2. Sonuçlar

| Set | Okunan sayfa | Ana fiyat doğru | Satıcı |
|---|---|---|---|
| Belge 14 ölçüm seti (10 referans + 10 popüler ürün) | **20/20** | **16/20 (%80)** | 16/20 doğru; 4 yanlış/belirsiz (biri markayı satıcı sandı) |
| Sitemap'ten rastgele 20 ürün | 19/20 | **11/18 (%61)**. 1 ürün canlı sayfada doğrulanamadı | Adını verdiği 7'si doğru; 6 kez platform adını ("Trendyol") satıcı yazdı; 5 boş |
| Negatif kontrol: Trendyol'da 404 olan 4 URL, 1 kanonik olmayan URL | 0/5 | — | **Hiçbirinde değer uydurulmadı** |
| İlk deneme: iPhone Çöl + 3 referans | 4/4 | 4/4 | 4/4 |

Belge 14'ün başarı ölçütü (20'de en az 18 birebir) **karşılanmadı**.

**Hatalar:**
- **Sapma:** 11 hatalı fiyatın sapması −30,3 ile +17,7 arasında. Çoğu küçük ve inandırıcı: −0,45, +2,7, −3,0, +4,9, +5,3, −7,6 vb. Yani bir kullanıcının fark edemeyeceği türden hatalar.
- **Kalıcılık:** Rastgele setteki 7 hatalı ürün ikinci kez okutuldu. 6'sında aynı yanlış değer geldi. Rastgele bir okuma hatası değil; büyük olasılıkla **Google'ın dizin önbelleğindeki eski sayfa kopyası**. Belge de aracın önce dizin önbelleğine baktığını söylüyor.
- **Tarih izleri:** Okunan kopyalarda "2026-10-08 17:39", "2025-11-07", "2024-07-08" gibi tarihler var. Bunların neyin tarihi olduğu (yorum, teslimat, kopya) dışarıdan ayırt edilemiyor.
- **Önbellek mi, canlı mı?** Araç her URL için yalnız `Success` ya da `Access denied` diyor; okumanın ne zaman yapıldığını vermiyor.

**Popülerlik farkı:** Popüler ve referans ürünlerde doğruluk %80 ile %100 arasında, rastgele üründe %61. Bu, popüler sayfaların Google dizininde daha sık yenilendiği hipoteziyle (H20) uyumlu, ama kanıtı değil.

## 3. Ne anlama geliyor

1. **"Kanıt metninde geçiyor" doğrulaması bayatlığı yakalamaz.**
   - `web-search/parse.ts`'deki `verified` kuralı, modelin verdiği kanıt metninde aynı tutarın geçmesine bakıyor.
   - Bu ölçümde hatalı fiyatların kanıtı da aynı bayat kopyadan geliyordu. Yani bu fiyatlar o kurala göre **"verified"** olurdu.
   - Belge 14 bunu kuramsal olarak öngörmüştü; burada ölçüldü.
2. **Kurala göre sonuç:** "Doğrulanamayan fiyat gösterilmez". Trendyol fiyatında URL Context, gösterilen fiyatların yaklaşık %20–40'ında yanlış ve bu yanlışlar tek tek ayırt edilemiyor. Bu yüzden **güncel Trendyol fiyatı kaynağı olarak kullanılamaz**.
3. **Üretime etkisi (öneri, kod değişmedi):**
   - 0102 hattı internet sonuçlarında Trendyol (ve muhtemelen diğer pazaryeri) fiyatlarını "doğrulanmış" gösterebilir.
   - Ayrı bir kararla şunlardan biri seçilmeli:
     - pazaryeri alan adlarında fiyatı göstermemek;
     - ya da fiyatı kaynak ve "Google'ın sayfa kopyasına göre, tarih bilinmiyor" ibaresiyle vermek. Bu seçenek kural gereği zayıf.
   - Bu dal production koduna dokunmaz; karar kullanıcınındır.
4. **Güçlü yanlar:**
   - Okunamayan ya da 404 sayfada değer uydurmadı.
   - Popüler ürünlerde çoğunlukla doğruydu.
   - Ad, görsel ve bağlantı zaten sitemap dizininde var. Bu yüzden H9'un tek katkısı fiyat olurdu, o da güvenilmez.
5. **Model farkı:** Ölçüm Gemini 3 Flash Preview ile yapıldı. Üretim modeli (`gemini-3.5-flash-lite`) ya da 2.5 Flash için oranlar farklı olabilir. Ancak bayatlık modelden değil, araçtan (dizin önbelleği) kaynaklanıyor. Belge 14'teki düzenek ücretsiz anahtarla aynı seti 2.5 Flash'ta koşabilir.

## 4. Google Search grounding (URL Context kapalı)

Aynı rastgele setin 7 hatalı ve 1 doğru ürünü için "Trendyol'daki güncel fiyatı Google Search ile bul" istendi.

- 8'in 1'inde canlı sayfada bulunan bir değer geldi. O değer de JSON-LD değil, gömülü `discountedPrice` değeriydi.
- 6'sı yanlıştı. 1'i null döndü; uydurma yoktu.
- URL Context'in doğru verdiği ürünü (881373867) Search grounding yanlış verdi.
- Kaynak parçalar arama dizinindeki eski metinlerdi ("Son 10 Günün En Düşük Fiyatı! …").

**Sonuç:** Fiyat için Search grounding URL Context'ten de kötü. Grounded sonuçlar Google şartları gereği saklanmadı.

## 5. Yan bulgu: Trendyol sayfasında "fiyat" hangisi?

Aynı sayfada birden çok fiyat var.

- **JSON-LD `offers.price`:** Çoğu üründe **sepet fiyatı ya da en düşük teklif**. Örnekler:
  - Samba 3.999,50 = 7.999 × %50, "Sepette";
  - Sony 312097758: JSON-LD 17.500 (başka satıcı), sayfanın ana teklifi 23.949.
- **Gömülü `discountedPrice`:** Diğer teklifleri de taşıyor, ürün başına 1–6 değer.
- **Gemini'nin seçimi:** Kimi üründe JSON-LD'yi, kimisinde ilk `discountedPrice`'ı "ana fiyat" olarak seçti.

Bu, 06 ve 11'deki çok katmanlı fiyat modelini doğruluyor. Tek bir "Trendyol fiyatı" sütunu yanıltıcıdır; katman (sepet, kampanya, teklif) ayrı tutulmalı (§7).

## 6. İzin değerlendirmesi

| Konu | Durum |
|---|---|
| Trendyol robots.txt | `Google-Extended` için kural yok. Ürün sayfaları `*` grubunda serbest. Trendyol, Gemini grounding ve eğitim kullanımını robots ile engellemiyor (14 Ekim 2026'da yeniden okundu) |
| Google şartları | Search grounding sonucu önbelleğe alınamaz ve saklanamaz. URL Context için ayrı saklama kuralı yok; belge 14 §2.2'deki gri alan değerlendirmesi geçerli |
| Trendyol kullanım koşulları | "İzinsiz kopyalanamaz, yeniden yayımlanamaz". Fiyatın gösterimi için hukuki görüş gerekli (değişmedi) |
| Bu ölçüm | Kullanıcının kendi AI Studio arayüzü, ücretli anahtar yok, 5 istemde 56 URL Context okuması + 1 Search grounding istemi (8 ürün). Erişim engeli aşılmadı; Trendyol sayfaları kullanıcının tarayıcısında normal ziyaretle okundu |

## 7. Katalog tasarımına ekler (belge 14 §4'ün üzerine)

Belge 14'ün eşlemesi korunur. Bu ölçümden çıkan ekler:

1. **H9 sonucu hiçbir tabloya yazılmaz.** `price_verification.source_kind` CHECK'i (`merchant_storefront`, `merchant_api`, `affiliate_api`) bunu zaten engelliyor. Bu ölçüm, engelin doğru olduğunu gösteriyor.
2. **`source_reliability` değerleri ölçüme dayanmalı.** Öneriler:

   | Kaynak | Değer | Gerekçe |
   |---|---|---|
   | Satıcı API'si | Belirlenmedi | Doğrulanana kadar 05 protokolü T1–T6 sonucu beklenir |
   | Kendi tarayıcı gözlemi | Kataloğa girmez | Yer gerçeği; yalnız araştırma |
   | URL Context | Kullanılmaz | %61–80 |

3. **Fiyat katmanı ayrı saklanmalı.** Satıcı API'si geldiğinde:
   - `offer.current_price` = `salePrice` (belge 14);
   - sepet ya da kampanya fiyatı `price_verification.discount_conditions` içinde `{"layer":"basket","label":"Sepette %50"}` gibi, **kaynağın verdiği metinle** tutulur.
   - Yüzde ya da tutar matematikten çıkarılmaz (kural).
4. **Kanonik URL şart.** URL Context, kanonik olmayan URL'de `Access denied` verdi; Trendyol kısa URL'de 404 döndü. `offer.url` her zaman sitemap'teki kanonik yol olmalı: `<marka>/<slug>-p-<contentId>`. Satıcıya özgü bağlantı `?merchantId=` ile kurulur.
5. **Satıcı adı kimlik değildir.** Gemini platform adını ve markayı satıcı sandı. `seller` eşleşmesi yalnız `merchantId` (sayısal) ile yapılır (belge 14 ile aynı).

## 8. Hipotez kaydı (bu tur)

| # | Hipotez | Sonuç |
|---|---|---|
| H9 | Gemini URL Context güncel Trendyol fiyatını verir | **Kısmen.** Okuma %95–100. Fiyat doğruluğu %61 (rastgele), %80 (popüler). Hatalar kalıcı ve inandırıcı; kural gereği **kullanılamaz (D)** |
| H9b | Google Search grounding güncel fiyatı verir | **Hayır**: 8'de 1 (D) |
| H20 | URL Context bayatlığı popülerlikle azalır | Veri uyumlu (%80 / %61). Yorumlu ürün sitemap'iyle (H14) ölçülebilir; sonraki tur |
| — | Trendyol geliştirici belgelerinde yeni fiyat servisi | Yok. `llms.txt` ve değişiklik kaydı 8 Ekim'e kadar okundu (belge 14 H16 ile aynı sonuç) |
| — | Lisanslı Trendyol fiyat verisi sağlayıcısı, Akakçe API'si, resmî entegratör listesi | Bulunamadı (belge 14 H18 ile aynı). Yalnız kazıyıcılar ve entegratör tanıtımları çıktı |

## 9. Güncel durum

- İzinli ve doğruluğu ölçülmüş bir Trendyol fiyat kaynağı **hâlâ yok**.
- Kalan yetkili yollar değişmedi:
  - pilot satıcının API'si (onay ve anahtar);
  - Trendyol ile doğrudan anlaşma (ManiCepteBot erişimi, gösterim izni);
  - Akakçe veri ortaklığı.
- H9, bu yolların yerine geçemez. 0102'deki gösterim için yukarıdaki §3 kararı gerekli.
- "Fiyatı mağazada gör" nihai çözüm olarak kabul edilmedi. Boşluk ancak bu yetkili yollardan biriyle kapanır.
