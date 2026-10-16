# 0113 — Bağımsız fiyat doğrulama, resmî kur ve besleme yönetim görünümü

**Tarih:** 14 Ekim 2026
**Durum:** Kabul edildi. Kod ve testler hazır. Üretimde zamanlama **yok**; TRY dışı
beslemelerin herkese açık gösterimi ayrıca karar ister.

## Bağlam

- Besleme fiyatı kaynağın beyanıdır. AliExpress (Admitad) beslemesi yalnız USD
  veriyor.
- CLAUDE.md: para birimi TRY. USD tutar TL gibi gösterilmemeli.
- Kur uydurulmamalı. Yaklaşık TRY gösterimi güvenilir, tarihli bir kaynağa dayanmalı.
- Doğrulama kaynağı izinli olmalı: erişim engelini aşmak, robots/ToS ihlali ve izinsiz
  kazıma yok.

## Karar

1. **Kur: TCMB günlük bülteni** (`https://www.tcmb.gov.tr/kurlar/today.xml`).
   - Resmî ve herkese açık bir kaynak. `robots.txt` yalnız arama sonuçlarını yasaklıyor.
   - `fx_rate` append-only'dir. Her kayıt şunları taşır: bülten tarihi
     (`effective_date`), bülten no, çekilme zamanı.
   - Aynı bülten ikinci kez yazılmaz.
   - `python -m pricing fx`; iş adı `fx_rates`.
2. **Yaklaşık TRY** (`packages/core/src/pricing/fx.ts`):
   - Döviz satış kuruyla, tamsayı/BigInt hesaplanır; yarım yukarı yuvarlanır.
   - Orijinal tutar ve para birimi değişmez.
   - Gösterimde "yaklaşık", kaynak ve kur tarihi birlikte verilir.
   - **Kur yoksa ya da 4 günden eskiyse dönüşüm yapılmaz.** 4 gün, uzun tatil
     boşluğunu kapsar.
3. **`price_verification` beslemeden bağımsızdır.**
   - Ayrı satır, append-only. Offer fiyatı değişmez.
   - Saklanan alanlar:
     - kaynak türü ve güvenilirliği (0–100);
     - para birimi, varyant ve satıcı;
     - zaman ve sonuç (`match`, `mismatch`, `unavailable`, `error`);
     - gözlenen ve beslemedeki fiyat;
     - stok, kargo, vergi, indirim ve kupon koşulları.
   - Kaynak bir koşulu vermiyorsa alan NULL kalır, yani "bilinmiyor"; uydurulmaz.
4. **`PriceVerificationProvider`** (`services/ingest/pricing/providers.py`):
   - Sağlayıcı iki şey sağlar: `supports(offer)` ve `verify(offer)`.
   - İlk ve tek sağlayıcı `shopify_product_js`: mağazanın kendi vitrin JSON'u.
     - Repoda zaten kullanılan uç (karar 0034/0036).
     - robots.txt'ye uyulur; host başına en az 2 sn ya da Crawl-delay.
     - 401/403/429 ya da robots yasağında o host için durulur.
     - Para birimi merchant için doğrulanmış olmalı.
     - Karşılaştırma yalnız offer'ın kendi varyantlarıyla yapılır. Shopify offer'ı
       renk grubudur; tüm ürünle karşılaştırmak yanlış `mismatch` üretirdi.
   - **AliExpress için izinli canlı kaynak yok.** Admitad yayıncı API'si ürün fiyatı
     döndürmüyor; AliExpress affiliate API'si ayrı anahtar ve sözleşme ister.
     İstek `unsupported` olur; sahte sonuç yazılmaz.
5. **Kuyruk** (`price_verification_request`):
   - Offer başına tek açık istek.
   - İşçi `FOR UPDATE SKIP LOCKED` ile istek alır.
   - Geçici hata geri çekilmeyle yeniden denenir; 3 denemeden sonra `failed` olur.
   - Erişim reddi isteği 6 saat bekletir.
   - TS tarafı yalnız satır ekleyebilir (mimari sınır).
6. **Affiliate takibi:**
   - `deeplink_template` artık `{affiliate_url}` kabul eder: offer başına takip
     bağlantısı, kodlanmadan yerleşir. Yönetici ağın belgelediği biçimi yazar, örn.
     `{affiliate_url}&subid={click_id}`; kod alt-kimlik parametresini tahmin etmez.
   - Takip bağlantısı yoksa click yine kaydedilir ve kanonik adrese gidilir.
   - `click.price_at_click` TL kuruş varsayar. TRY dışı offer'da boş bırakılır; USD
     analitiğe TL olarak girmez.
7. **Yönetim** (`/yonetim/ingest/beslemeler`, `ingest.read`):
   - Salt okunurdur. Gösterilenler:
     - kaynaklar, durum, bağlı mağaza, para birimi;
     - son başarılı aktarım ve son sürüm (red nedeni);
     - kayıt, yeni/değişen, pasifleşen ve hatalı kayıt sayıları;
     - hata kayıtları;
     - doğrulama özeti ve TCMB kuru.
   - Besleme adresinde kimlik parametresi yoktur. Hata ayrıntısı kırpılır; ham
     `payload` gösterilmez.
   - Yeni mutasyon yoktur, dolayısıyla yeni yetki yüzeyi de yoktur.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Sabit ya da elle girilen kur | Uydurma; tarih ve kaynak yok |
| Ticari kur API'si | Anahtar ve maliyet; TCMB resmî ve yeterli |
| AliExpress ürün sayfasını kazıyarak doğrulama | İzinsiz kazıma ve erişim engeli; kural dışı |
| Doğrulama sonucuyla offer fiyatını güncellemek | Besleme ve doğrulama karışır; kaynak izi kaybolur |
| `subid` parametresini koda gömmek | Ağın biçimi belgeden doğrulanamadı (belgeler 403); yönetici yapılandırması |

## Sınırlar ve açık işler

- **TRY dışı beslemelerin herkese açık gösterimi açık bir ürün kararıdır.**
  AliExpress kayıtları bugün hiçbir ürüne bağlanmıyor: kesin kimlik yok ve çözümleyici
  TRY dışını atlıyor. Ürün sayfası toplamları (`min_price`) TL varsayıyor.
  Gösterimin nerede ve nasıl olacağı ayrıca kararlaştırılmalı: ayrı "yurt dışı teklif"
  bölümü ya da yaklaşık TRY ile sıralama dışı gösterim. O zamana kadar merchant
  etkin olmayan durumda kalır.
- Zamanlama yok: `pricing fx` (günlük), `pricing enqueue/verify` ve `feeds sync-due`
  aktivasyon adımıdır.
- Admitad `subid` biçimi Admitad hesabından doğrulanıp `deeplink_template`'e
  yazılmalıdır.
