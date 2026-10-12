# Ürün grupları, varyantlar ve birleşik keşif (2026-10-12)

Yöntem: 5 liste sayfası gerçek Chrome'da normal ziyaretle açıldı (iPhone 16 Pro, Stanley termos,
Koton kadın elbise, Crocs terlik, Adidas Samba). Her üründen `contentId:groupId` alındı (liste JSON'u
`groupId` taşır = ürün sayfasındaki `productGroupId`). Sitemap üyeliği yerel ikili dizinle
(`<tmp>/manicepte-trendyol-ids.bin`, 8.126.053 sıralı uint32) kontrol edildi. Ham çiftler:
`$TEMP/groups.txt` (oturum geçici).

## 1. Hipotez "sitemap grup başına bir temsilci listeler": **YANLIŞ**

| Ölçü | Değer |
|---|---|
| Liste sayfalarında görülen benzersiz ürün | 180 |
| Bunların sitemap'te olanı | **179 (%99,4)** |
| Görülen grup | 164 (155 tek üyeli, 9 çok üyeli) |
| Tek üyeli grupların sitemap'te olanı | 155/155 |

Çok üyeli 9 grup (≥10 grup koşulu: 164 grup incelendi, 9'u çok üyeli):

| groupId | Sayfa | Görülen üye | Sitemap'te |
|---|---|---|---|
| 595261670 | Stanley (Aerolight Transit Mug) | 6 | **6/6** |
| 566551 | Crocs (Crocband) | 4 | **4/4** |
| 631892523 | Stanley (Quencher) | 3 | **3/3** |
| 923552304 | iPhone (yenilenmiş 17 Pro, iki satıcı) | 2 | 2/2 |
| 921010094 | Koton (mini elbise) | 2 | 2/2 |
| 916384632 | Koton (kadife midi elbise) | 2 | 2/2 |
| 619065780 | Crocs (Bayaband) | 2 | 2/2 |
| 608940998 | Samba (çocuk/bebek) | 2 | 2/2 |
| 653969108 | iPhone 16 Pro 128GB | 2 | **1/2**: Siyah 857296083 ✓, Çöl 857296094 ✗ |

**Sonuç:** Sitemap renk varyantlarını ayrı ürünler olarak listeliyor ve neredeyse tam (%99,4). 8.126.053,
ürün grubu sayısı değil, **content (renk düzeyi) sayısıdır**. iPhone Çöl tekil bir eksik; nedeni bilinmiyor
(sitemap üretim gecikmesi, dışlama kuralı vb.; doğrulanmadı). Önceki belgedeki (09 §2) "temsilci"
hipotezi bu verilerle düzeltildi.

## 2. Kimlik hiyerarşisi (gözlenen)

```
groupId / productGroupId  (renk grubu; sitemap'te YOK, liste JSON'unda VAR)
  └─ contentId            (renk/ürün; sitemap'te VAR, -p-<id>)
       ├─ slicingAttributes  (ör. {"Internal Memory":"128 GB","DsmColor":"Siyah Titanyum"})
       └─ varyant/barkod     (beden; "38,5" → 4066765863256; Samba tek content'te birden çok beden)
            └─ satıcı teklifi (merchantId; fiyat katmanları: 06 §2)
```

- Ürün sayfasının gömülü JSON'u yalnızca **mevcut** content'in `slicingAttributes`'ını ve `productGroupId`'sini
  taşıyor; grubun diğer renklerinin contentId'leri **gömülü değil**. iPhone sayfasında renk seçicide yalnızca
  mevcut renk vardı; sayfadaki diğer `-p-` kimlikleri öneri bloğuna aitti. Ek veri Trendyol'un dahili ağ
  geçidinden (`apigw.trendyol.com/discovery-…`; robots `Disallow: /`) yükleniyor; **kullanılmadı**.
- Grup üyelerini keşfetmenin izinli yolu: liste JSON'undaki `groupId` (tarayıcıda okunur; sunucu 403).

## 3. Sunucu tarafında grup kurulabilir mi? (sitemap slug'larıyla)

Renk sözcüklerini atıp aynı marka + kalan slug'ı aynı grup sayan sezgi, 179 ürünlük gerçek veriyle:
**kesinlik 0,11, duyarlılık 0,10** (doğru çift 29; tahmin 28; tp 3, fp 25, fn 26). Neden: aynı grubun
üyelerini farklı satıcılar çok farklı adlandırıyor (Stanley 595261670: "aerolight-seyahat-kupasi-…" ile
"termos-the-aerolight-transit-mug-…"); farklı gruplarda birebir aynı başlıklar var. → **groupId sitemap'ten
çıkarılamaz.**

## 4. Birleşik keşif: sitemap dizini ↔ liste sayfası dizini

| | Sitemap ürün dizini (A) | Liste sayfası dizini (B) |
|---|---|---|
| Sunucudan erişim | **Evet** (Node 200) | Hayır (HTML 403; yalnızca adres listesi) |
| Kapsam | 8,13 milyon content, renkler ayrı, %99,4 | Sayfa başına ilk 36 ürün |
| Kimlik | contentId, slug, görsel | contentId, **groupId**, **merchantId**, **varyant**, **fiyat**, kategori |
| Model sorgusu | Güçlü (Samba 614, AF1 847, Sony 5) | Güçlü (`-y-s` sayfaları) |
| Öznitelik sorgusu (renk + cinsiyet + kategori) | Zayıf (başlıkta "kadın" yoksa kaçar: SHEBARA) | Güçlü (Trendyol facet'i) |
| Fiyat | Yok | Var (yalnızca tarayıcıda) |

- **Tamamlayıcılık:** A, B'nin ürünlerinin %99,4'ünü zaten içeriyor (179/180). B'nin katkısı yeni ürün değil,
  **kimlik ve fiyat bağlamı** (grup, satıcı, varyant, fiyat) ve öznitelik sorgusunun doğruluğu.
- **Tekrar:** Aynı model farklı content'lerde (Sony WH-1000XM5: 3 content/3 satıcı; yenilenmiş iPhone 17 Pro
  aynı grupta iki satıcı). Kart düzeyinde gruplama için groupId gerekir (yalnızca B).
- **Yanlış eşleşme:** varyant çelişkisi kuralı (08 §3) renk ve kapasite farklarını reddeder.

## 5. Kod

`listing.ts` → `TrendyolListingProduct`'a `contentId`, `groupId`, `supplierId` (merchantId), `variant`
(variantValue) eklendi; liste erişimi olursa kimlik hiyerarşisi doğrudan kurulur. Testler: 44.

## 6. Fiyat (Aşama 3) ve Gemini (Aşama 4)

- Grup düzeyinde fiyat diye bir şey yok: fiyat teklif düzeyinde (content + varyant + satıcı + katman).
- **Gemini grounding (0102, salt okunur inceleme):** Şartlar grounded sonuçların önbelleklenmesini, analiz
  edilmesini ve veritabanına dönüştürülmesini yasaklar; sonuç yalnızca sorgu anında, Search Suggestions ile,
  değiştirilmeden gösterilir. Fiyat yalnızca URL Context sayfayı okuyup kanıt aynı TRY tutarını içerirse
  "doğrulanmış"tır. Maliyet: ayda 5.000 ücretsiz, sonra 14 USD/1.000 sorgu + token. **Sonuç:** sorgu başına
  gerçek Trendyol fiyatı gösterebilir (doğrulama oranı ölçülmedi), ama dizini fiyatla **zenginleştirmek için
  kullanılamaz**. Ücretli çağrı yapılmadı.
- Yeni izinli fiyat kaynağı: bu turda **bulunamadı**. Grup/varyant düzeyinde fiyat veren belgelenmiş servis yok;
  satıcı API'si (03–07) varyant düzeyinde fiyat verir ve `variant` alanı artık eşleştirmeye taşınıyor.

## 7. Sonraki oturum

1. iPhone Çöl tipi eksiklerin oranı: 5 sayfalık örneklem 1/180; 20 sayfayla genişlet.
2. Sitemap'in günlük değişimi (yeni content'ler kaç günde giriyor?) — Çöl eksikliği gecikme mi?
3. H9 (Gemini URL Context) doğrulama oranı — yalnızca kullanıcı ücret onayı verirse.
4. Satıcı pilotu gelirse: V2 `productMainId` (satıcının grup anahtarı) ile Trendyol `groupId` ilişkisi.
