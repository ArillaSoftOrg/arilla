# Fiyat mimarisi, yeni dağıtım zinciri hipotezleri, 20 sayfalık kapsam (2026-10-12)

## 1. Trendyol'da fiyat nasıl oluşuyor (gözlemlere dayalı model)

Kaynaklar: resmî Partner API belgeleri (03, 04, 07) ve gerçek tarayıcı gözlemleri (06 §2, 10). Dahili
servislerin iç işleyişi **bilinmiyor**; aşağıdaki katmanlar yalnızca gözlenen alanlardan çıkarılmıştır.

| Katman | Nerede üretiliyor | Gözlenen alan | Kanıt |
|---|---|---|---|
| 1. Satıcı fiyatı | Satıcı → Partner API "Stok ve Fiyat Güncelleme" (yazma) | API: `salePrice`, `listPrice`; sayfa: `sellingPrice`, `originalPrice` | Belge; Samba sayfası selling 5.524 |
| 2. Teklif | Satıcı × varyant (barkod) | `merchantId`, `variantValue`, barkod | Samba: aynı barkod 36 için 7.199 / 7.199,1 / 7.999 TL (farklı satıcılar) |
| 3. Buybox | Trendyol, barkod/content düzeyinde teklifler arası seçim | Liste kartındaki `merchantId`; API `buyboxPrice`, `buyboxOrder` | iPhone: 2 Trendyol satıcısı, sayfada 1; Samba: 7 satıcı |
| 4. Kampanya / indirim | Trendyol kampanya motoru (`campaignId`, "kırmızı kampanya", `eventdeal`) | `discountedPrice`, `discountPercentage`, etiketler | iPhone 127.999 → 124.999 |
| 5. Sepet indirimi | Sepette uygulanır ("Sepette %X") | Liste kartında `discountedPrice` buna eşitlenebilir | 3.999,50 = 7.999 × 0,50; 5.399,25 = 7.199 × 0,75 |
| 6. Kupon, 2. ürün, ödeme yöntemi | Sepet/ödeme anı | `couponApplicablePrice`, "2. Ürüne %3", "Troy Ekim 2026" | Samba sayfası |
| 7. Gösterim | Sunucu tarafında sayfaya gömülü JSON (SSR) | Liste: `__single-search-result__PROPS`; ürün: sayfa durumu | Tarayıcıdaki fiyatın kaynağı **sunucunun gömdüğü JSON**; sonradan yüklenen parçalar dahili ağ geçidinden (`apigw.trendyol.com/discovery-*`, robots `Disallow: /`; kullanılmadı) |

Kullanıcıya özel fiyatlandırma ne kanıtlandı ne dışlandı (aynı dakikada kart 7.999 / sayfa 7.199 farkı açıklanamadı).

**Sonuç:** "Trendyol fiyatı" = (content, varyant/barkod, satıcı, kampanya, sepet koşulu, zaman) altılısının
fonksiyonu. Dışarıdan yetkili olarak görülebilen katmanlar: satıcının kendi API'sinde 1–3 (V2, Stok-Fiyat,
Buybox); 4–6 için yalnızca tanımsız `priceSeenByCustomer` (V2 örneği) ipucu var.

## 2. Yeni dağıtım zinciri hipotezleri (bu tur)

| # | Hipotez | Teknik dayanak | Gerçek test / kanıt | Sonuç |
|---|---|---|---|---|
| H12 | **Market Fiyatı** (marketfiyati.org.tr, TÜBİTAK + Ticaret Bakanlığı) | Devletin zincir marketlerden topladığı fiyat verisi; Cimri Market ve Market Tamam ile paylaşılıyor | Kaynaklar: yalnızca 7 gıda zinciri (A101, BİM, CarrefourSA, HAKMAR, Migros, Tarım Kredi, ŞOK), ~50 bin ürün; Trendyol/Trendyol Go **yok**; açık API veya lisans belgesi **bulunamadı** | D (Trendyol için). Not: devletin zorunlu kıldığı fiyat paylaşımı örneği, e-ticarete genişlemesi izlenebilir |
| H13 | Trendyol influencer/affiliate (Takefluence/Admitad) ürün API'si | Ajans/yayıncı programlarında ürün feed'i olabilir | Belgelenmiş Takefluence API'si **bulunamadı** | Doğrulanamadı |
| — | Önceki turlar (tekrarlanmadı) | | Akakçe, Cimri, Epey, Sovrn, Common Crawl, IA, Google Merchant, Open Prices, Dopigo, kazıma servisleri | 02–08 |

**Ara sonuç:** Trendyol fiyatını bilen ve üçüncü taraflara **aktarma yetkisi belgelenmiş** bir sistem
bulunamadı. Yetkili halkalar: Trendyol'un kendisi ve her satıcı (yalnızca kendi teklifi için).

## 3. Kimlikten fiyata

- Elimizdeki kimlikler: contentId (8,13 milyon, sitemap), slug, görsel. Barkod/GTIN **yok** (yalnızca ürün
  sayfasında; sunucuya kapalı).
- GTIN kullanan izinli bir fiyat kaynağı (Trendyol fiyatı için) bulunamadı. Satıcı API'si contentId ve barkod
  döndürür → dizindeki contentId, yetkili satıcının kataloğuyla doğrudan eşlenir (03–04).
- Varyant çelişkisi kuralı (08 §3) ve liste kimlik alanları (10 §5) satıcı/varyant doğrulamasını sağlar.

## 4. İndeks doğrulaması: 20 liste sayfası

10'daki 5 sayfaya ek olarak 15 sayfa (Samsung, Dyson, LEGO, Philips Airfryer XXL, Tefal, Puma, Xiaomi,
Arçelik, Karaca, Bosch, Mavi erkek jean, New Balance, JBL, U.S. Polo, Vans). Tarayıcı içinden, aynı site,
sayfalar arası 2 sn.

| | Değer |
|---|---|
| Sayfa | 20 |
| Liste ürünü | 720 |
| Sitemap'te | **719 (%99,86)** |
| 15 yeni sayfanın her biri | 36/36 |
| Eksik | yalnızca iPhone Çöl `857296094` |

Eksiğin nedeni: yeni ürün değil (id 857 milyon < sitemap en büyük 1,21 milyar; sayfa 2024'ten beri var).
Nedeni **bilinmiyor**; tek örnekle genelleme yapılamaz.

## 5. Sitemap değişim ölçümü (tekrarlanabilir)

`scripts/trendyol-sitemap-diff.ts [--files 1,150,300]`: TR `sitemap_index.xml`'den dosya `lastmod`'unu okur,
dosyayı indirir, önceki anlık görüntüyle (ilk seferde tam dizin önbelleği) karşılaştırır, `+eklenen/-silinen`
yazar ve yeni görüntüyü `<tmp>/manicepte-trendyol-sitemap-snapshots/<n>/<lastmod>.json` olarak saklar. Aynı
`lastmod` tekrar indirilmez.

İlk çalıştırma (dosya 1 ve 150): aynı üretim (`2026-10-11T16:39:34Z`) içinde **+0 / −0** (beklenen).
Asıl ölçüm, sonraki üretimde aynı komutla yapılmalı.

## 6. Sonraki oturum

1. `trendyol-sitemap-diff.ts`'yi yeni `lastmod` sonrası çalıştır → günlük ekleme/silme oranı; Çöl eklendi mi?
2. Yetkili satıcı pilotu gelince 05 protokolü (T2: `priceSeenByCustomer` ↔ sayfa katmanları).
3. H9 (Gemini URL Context) — yalnızca kullanıcı ücret onayıyla.
4. H12'nin e-ticarete genişlemesi (Ticaret Bakanlığı / TÜBİTAK duyuruları) izlenebilir.
