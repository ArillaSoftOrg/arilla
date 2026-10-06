# 0072 — Merchant bazında Shopify seçenek eşlemesi: kanıt ve düzeltme

> **Eski numara: 0067.** Bu ADR dalda ilk 0067 olarak yazildi; `main`'deki baska kararlarla cakistigi icin 0072'e tasindi. migration 0052 basligi ve denetim kaydi metnindeki 'docs/decisions/0067' bu ADR'yi (eski numarasiyla) kasteder; uygulanmis migration dosyalarina bu yuzden dokunulmadi.

**Tarih:** 2026-10-07
**Durum:** kabul edildi (yalnızca `for-fun` düzeltildi ve canlıya alındı; diğer beş merchant bilerek bırakıldı)

## Bağlam

Toplu turda kalan 6 merchant (`riva-istanbul`, `casadora-baby`,
`eveline-cosmetics-turkiye`, `jura-store`, `wraith-esports`, `for-fun`)
REVIEW/NOT_READY'ydi. Gerçek `/products.json` örnekleri (guarded_client, robots'a
uygun `limit=50` sayfalama, en fazla 200 ürün) `services/ingest/bootstrap/option_evidence_20261007.json`
dosyasında. Özet:

| Merchant | Kanonik host | Seçenek kanıtı | Sonuç |
| --- | --- | --- | --- |
| for-fun | (yönlendirme yok) | 198 ürün `["Beden","Renk"]`, 2 ürün `["Size","Renk"]` (Beden=option1, Renk=option2) | Mevcut konumsal eşleme (`color_option=option1`, `variants.size=option2`) bedeni renk, rengi beden sanıyor: **düzeltildi → READY** |
| casadora-baby | www.casadorababy.com | 138 `Title`, 44 `size`, 18 `Beden` (option1) | Eşleme düzeltmesi gerekir; ama readiness örneğinde (ilk 5 ürün) seçenek yok → REVIEW kalır |
| riva-istanbul | www.rivaistanbul.com | 200/200 `Title` (Default Title) | Eşleme sorunu kanıtlanamadı; REVIEW |
| eveline-cosmetics-turkiye | eveline.com.tr | 14/14 `Title` | REVIEW |
| jura-store | jurastore.co | `Pil Seçeneği`(14), `Vücut rengi`, `Renk`, `Color`, `Ölçü` | Tanınmayan seçenek adları; REVIEW |
| wraith-esports | wraithesports.com | `Model`, `Renk`, `Adet`, `Switch`, `Kutu`, ... çok boyutlu | Eşleme düzelse de tanınmayan adlar (Model) kalır; REVIEW |

Düzeltmeyi öngörmek için `verify_readiness.check_target` önerilen ad tabanlı
yapılandırmayla (yazmadan) kanonik host üzerinde çalıştırıldı: yalnızca `for-fun`
READY'ye döndü; casadora/riva/eveline değişmedi (REVIEW), jura REVIEW, wraith
NOT_READY → REVIEW.

## Karar

1. **Yalnızca `for-fun`** için `0052_for_fun_option_mapping.sql`: üç anahtar
   (`transport.shopify.color_option_names`, `transport.shopify.size_option_names`,
   `mapping.variants.size = "size"`). Listeler `bootstrap/shopify_merchants.json`
   `defaults` ile aynı (global kurallar gevşetilmedi, test/dry-run ile doğrulandı).
   Production dry-run (ROLLBACK): yalnızca `for-fun` satırı değişti, yalnızca bu
   üç anahtar; ikinci çalıştırma no-op; denetim kaydı `merchant.config_change`.
2. **Diğer beş merchant'ın `domain`/`feed_url`'u ve eşlemesi DEĞİŞTİRİLMEDİ.**
   Domain'i taşınmayan merchant'ta `robots.txt` yönlendirmesi (`0042`) bir
   emniyet ağıdır: eşlemesi düzelmemiş bir merchant yanlışlıkla toplanmaz.
   Eşlemesi READY olmadan domain'i taşımak bu ağı kaldırırdı.
3. READY'ye ulaşamayanlar için gereken (ayrı, onaylı iş): casadora için
   readiness örneğinin seçenek içeren ürünleri kapsaması (örnek boyutu/seçimi),
   jura ve wraith için tanınmayan seçenek adlarının (Pil Seçeneği, Model, ...)
   rol kararı; riva/eveline için seçenekli ürün kanıtı yok (eşleme gerekmeyebilir).

## Sonuç (production)

`for-fun`: `ingest_run #27` success, 835 offer / 831 Shopify ürünü (renk bölmesi),
4.391 varyant (beden olarak, `XS..XXL`), 9 chunk, 33 sn; batch resolve 835/835,
18,9 sn. Eski eşlemeyle her beden ayrı offer olacaktı.

## Reddedilen alternatifler

- **Tüm beş merchant'ı tahmini eşlemeyle migrate etmek:** kanıtlanmamış; wraith
  ve jura'da doğru rol belirsiz.
- **Readiness örneğini genişletip REVIEW'ları READY yapmak:** bu görevin kapsamı
  dışı (readiness kuralı gevşetilmez; genişletmek ayrı karar).
- **Domain'i eşlemeden önce taşımak:** emniyet ağını kaldırır.
