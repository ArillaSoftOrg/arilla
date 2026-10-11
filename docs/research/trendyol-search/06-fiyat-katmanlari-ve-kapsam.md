# Fiyat katmanları, limitler ve kapsam ölçümü (2026-10-12)

## 1. Buybox limit çelişkisi: sonuç

Sayfalar (bir alt ajan okudu): servis limitleri (updatedAt 2026-08-25), Buybox belgesi (2026-07-20),
OpenAPI referansı (2026-06-09), yetkilendirme (2026-04-27).

- **Hiçbir sayfada "2 req/min" yok.** Önceki raporda yazılan değer "dakikada 200–600"dü.
- Buybox belgesi ve referansı: "Servis limiti 1000 req/min" + istek başına en fazla 10 barkod.
- Servis limitleri sayfası, 1000 req/min satırını "**14 Eylül 2026 tarihine kadar geçerli**" tablosunda
  veriyor. 14 Eylül'den itibaren "Ürün Buybox Bilgisi Kontrol Servisi", **Product Integration Write**
  grubunda: "Rate limitler, tekil endpoint bazlı değil, … servis grupları bazında **ortak** uygulanır."
  Grup üyeleri: Ürün Aktarma, Ürün Güncelleme, Buybox, Marka Yaratma, Arşivleme, Kilit Kaldırma, Silme.
- Kademe → limit: 50.000 → 200, 75.000 → 300, 150.000 → 400, 500.000 → 500, Limitsiz → 600 req/min.
  Satıcı bazında olduğu örnekten anlaşılıyor ("Limit 50.000 grubundaki bir satıcı için … 200 istek").
- Genel kural "aynı endpointe 10 saniyede en fazla 50 istek" (yetkilendirme sayfası) ayrıca geçerli mi?
  Hiçbir sayfa söylemiyor; ikisine birden uyulmalı.
- **Geçerli kabul:** Buybox = satıcının yazma kotasından (200–600/dk, ürün güncellemeleriyle ortak).
  1000/dk eski değer. ManiCepte, satıcının kendi stok/fiyat güncellemelerini aksatmamak için bu kotanın
  küçük bir payını (ör. ≤%10) kullanmalı → satıcı başına ~20–60 istek/dk ≈ 200–600 barkod/dk.

## 2. Samba ID0478: 3.999,50 TL (liste) ↔ 5.349 TL (ürün sayfası) farkı

Gerçek Chrome, normal ziyaret, 2026-10-11T23:33Z.

| Kaynak | Gözlem |
|---|---|
| Liste kartı (`adidas-samba-y-s10410`) | contentId 813659620, merchantId **106871 (SuperStep)**, `variantId "38-5"`, `variantValue "38,5"`, `campaignId 61`, `price {current 7999, originalPrice 5599.3, discountedPrice 3999.5}`, `hasCollectableCoupon false`; etiketler: "Son 10 Günün En Düşük Fiyatı", `eventdeal`, "Süper Avantajlı Ürün" (`kirmizi_kampanya_urunu`), "Troy Ekim 2026", "Peşin Fiyatına 3 Taksit" |
| Ürün sayfası (varsayılan, önceki ziyaret) | Varsayılan varyant teklifi: discounted 5.349, selling 5.524, original 5.349, kupon 5.349 |
| Ürün sayfası (`?merchantId=106871&v=38.5`) | Satıcı SuperStep; 38,5 barkodu `4066765863256`; görünen fiyatlar: **7.199 TL** (üstü çizili), **5.687,21 TL**, "**Sepette %25 İndirim** → 5.399,25 TL"; ayrıca 6.399,20 ve 6.332,31 TL (başka teklifler); kampanya adları "2. Ürüne %3 İndirim", "**Sepette %50 İndirim**" |

Aritmetik (doğrulanmış): `3.999,50 = 7.999 × 0,50` → liste kartındaki fiyat, kartın `current` değerine
**"Sepette %50 İndirim"** uygulanmış hâli. Ürün sayfasında `5.399,25 = 7.199 × 0,75` ("Sepette %25") ve
`5.687,21 = 7.199 × 0,79`.

Sonuç: Trendyol'da "müşteri fiyatı" tek değer değildir. Katmanlar:
1. **Varyant/beden**: her bedenin barkodu ve fiyatı ayrı (kart 38,5'i, sayfa başka bir bedeni gösteriyordu).
2. **Satıcı/teklif**: aynı barkod için farklı satıcı fiyatları.
3. **Satış fiyatı ↔ indirimli fiyat** (`sellingPrice`, `discountedPrice`, `originalPrice`).
4. **Sepet indirimi** ("Sepette %X"): liste kartı en agresif sepet fiyatını gösterebiliyor.
5. **Kupon** (`couponApplicablePrice`), **2. ürün indirimi**, **ödeme yöntemi kampanyası** (Troy).
6. **Zaman**: aynı dakikada kartta `current 7.999`, sayfada 7.199 görüldü. Neden belirsiz (farklı teklif,
   önbellek gecikmesi ya da kullanıcı/oturuma bağlı sepet koşulu). **Doğrulanmadı**; kullanıcıya özel
   fiyatlandırma ne kanıtlandı ne dışlandı.

Bu yüzden `priceSeenByCustomer` ve `buyboxPrice`'ın hangi katmana karşılık geldiği **varsayılmamalı**.
`05-test-protokolu.md` T2/T3'e şunlar eklenmeli: varyant sabitlenerek karşılaştırma, sepet fiyatı ile
sepetsiz fiyatın ayrı kaydı, kampanya etiketleri. ManiCepte'de gösterim de katmanı belirtmeli
(ör. "Trendyol satış fiyatı" ve ayrıca "sepette X").

## 3. Kapsam: az sayıda satıcı ne kadar ürün kapsar?

Gerçek katalog boyutları (Trendyol satıcı listesi, `total`, gerçek Chrome):

| Satıcı | merchantId | Listelenen ürün | Alanlar |
|---|---|---|---|
| Trendyol (1P perakende) | 968 | **32.036** | ev, küçük ev aletleri, giyim, telefon… |
| SuperStep | 106871 | **6.001+** (gösterim sınırı olabilir) | spor ayakkabı/giyim |
| Akarsu İletişim | 724838 | **491** | telefon, kulaklık, aksesuar |

Ürün dizini (sitemap): **≈8,1 milyon** ürün (aşağıda §4). Ürün sayısı bazında bu üç satıcının toplamı
≈ 38.500 → **%0,5'in altında**. Buybox, her satıcının kendi listelediği barkodların kazanan fiyatını da
verdiği için kapsam satıcının **kendi kazandıklarından** genişler, ama **listelediği ürünlerin dışına
çıkmaz**. Talep ağırlıklı kapsam (popüler ürünler) daha yüksek olabilir; ölçmek için arama/talep verisi gerekir.

Satıcıların listelemediği ürünler için bu turda bulunan ek **izinli** fiyat kaynağı: **yok**.

## 4. Ürün dizini durumu (indirme sürüyor, bozulmadı)

200/337 dosya (2026-10-12):
- **4.823.146** URL, **4.823.146** benzersiz ürün kimliği (dosyalar arası yineleme yok); görselsiz %0.
- **158.899** marka slug'ı; en sık: `genel-markalar` 35.896, `lc-waikiki` 28.507, `koton` 20.856,
  `nike` 20.200, `defacto` 19.594, `u-s-polo-assn` 16.545, `adidas` 16.186.
- Sitemap kategori taşımadığı için **kategori dağılımı ölçülemez** (yalnızca marka).
- Arama (sayfa kapsamı yok, katı başlık eşleştirmesi): iPhone 16 Pro 128 GB → 1 (Siyah Titanyum;
  Çöl Titanyum p-857296094 henüz inmemiş dosyalarda), Adidas Samba → 387, siyah kadın elbise → 5.312,
  Sony WH-1000XM5 → 4, Nike Air Force 1 → 506.
- Tam sayılar indirme bitince bu bölüme yazılacak.

## 5. Bağımsız fiyat kaynakları (bu tur)

| Kaynak | Trendyol fiyatı veriyor mu | İzin | Sınıf |
|---|---|---|---|
| Google Merchant "Price competitiveness" (Market Insights) | Hayır: yalnızca **kendi sattığın** ürünler için tüm perakendecilerin karışık referans fiyatı; Trendyol'a özgü değil | Merchant Center şartları | D (Trendyol fiyatı için) |
| Bright Data, Apify, "T-Retail Scraper" | Evet ama kazıma + konut proxy | Yok | D |
| GS1 Türkiye | Fiyat yok (kimlik) | Başvuru | Yardımcı |

## 6. Güncel durum

- Sınıf A (ticari kullanımı doğrulanmış Trendyol fiyatı) yöntem: **yok**.
- En güçlü yol (B): yetkili satıcı Product V2 + Buybox. Kapsam satıcı kataloglarıyla sınırlı (<%1 ürün
  sayısı; 3 örnek satıcı).
- Fiyatın kendisi çok katmanlı; doğrulama protokolü varyant, satıcı ve sepet katmanını ayrı kaydetmeli.
