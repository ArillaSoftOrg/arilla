# Hepsiburada canli urun kesfi - prototip bulgulari

**Tarih:** 12 Ekim 2026 · **Dal:** `feature/product-search-crawler` · **Durum:** prototip, uretime bagli degil

Kod: `packages/core/src/hepsiburada-discovery/`, CLI:
`packages/core/scripts/hepsiburada-discover.ts`. Veritabani, Gemini, Jina,
sohbet akisi ve uretim kaynaklarina dokunmaz.

## Sonuc: canli kesif BU ORTAMDAN calismiyor

Test sorgusu `iPhone 16 Pro 128 GB`. Dogrulanan tek canli istek:

| Istek | Sonuc |
| --- | --- |
| `GET https://www.hepsiburada.com/robots.txt` (durust User-Agent) | **HTTP 403**, Akamai bot-dogrulama sayfasi (`HBBlockandCaptcha`, `AKReferanceId`) |

- Bulunan gercek urun: **0**. Fiyat, gorsel, baglanti: **alinamadi**.
- robots.txt dogrulanamadigi icin baska hicbir sayfa (arama, urun, sitemap)
  istenmedi. Engel asilmaya calisilmadi: User-Agent taklidi, proxy, tarayici
  otomasyonu, yeniden deneme yok.
- Kullanim kosullari: web aramasiyla resmi metin dogrulanamadi. Otomatik veri
  cekmeye izin verip vermedigi **bilinmiyor**; hukuki inceleme gerekir.
- Resmi yol: aramada Hepsiburada icin guncel bir affiliate/urun feed'i
  bulunamadi (yalnizca satici tarafi Marketplace API'si ve kapali bir eski
  affiliate listesi). Dogrudan Hepsiburada ile gorusmek gerekir.

## Olan ve test edilen

- `robots.ts`: RFC 9309 ayristirma, en uzun eslesme, Sitemap satirlari.
- `polite-fetcher.ts`: durust UA, robots yuklenemezse hicbir sey istememe,
  istekler arasi bekleme, zaman asimi, istek butcesi, 403/429/captcha sayfasinda
  kalici durma.
- `extract.ts`: JSON-LD `Product`/`Offer` (`@graph`, `AggregateOffer` dahil) ->
  title, price (kurus tamsayi), currency, imageUrl, productUrl, merchant,
  availability, lastCheckedAt. Eksik alan `null`; deger uretilmez.
- `discover.ts`: robots -> arama sayfasi -> urun sayfalari -> sorguyla eslesme.
- 13 birim testi. Test HTML'leri **sentetiktir**; canli calistigini kanitlamaz,
  yalnizca cikarici ve engel davranisinin kodunu sinar.

## Acik: gercek Hepsiburada HTML'i dogrulanmadi

Canli sayfa alinamadigi icin sunlar **varsayimdir**, dogrulanmadi: urun sayfasinda
JSON-LD bulunmasi, urun yolu bicimi (`-p-KOD` / `-pm-KOD`), `/ara?q=` yolunun
robots.txt'te izinli olmasi ve arama sonuclarinin sunucu tarafinda HTML'e
yazilmasi (istemci tarafinda yukleniyorsa HTML'de baglanti olmaz).

## Trendyol prototipiyle birlestirme

Trendyol dali `packages/core/src/live-discovery/` altinda `robots.ts` ve
`polite-fetcher.ts` yaziyor (henuz commit'siz). Bu dal ayni sozlesmeyi izler
(`PoliteFetcher.get` -> `FetchOutcome`, 403/429'da kalici `blocked`). Birlestirme:

1. Ortak `robots.ts` + `polite-fetcher.ts` tek yerde (ornegin `live-discovery/`)
   toplanir; bu dizinden kopyalar silinir. Fark: burada `loadRobots()` sonucu
   (`FetchOutcome`) doner ve `sitemaps` okunur; ek olarak `HBBlockandCaptcha`
   engel sayfasi taninir.
2. Ortak `DiscoveredProduct` tipi (kurus tamsayi, `lastCheckedAt`) ve magaza basina
   bir `discover<Magaza>` islevi.
3. Tek bir `discoverLive(query)` hepsini sirayla calistirir; bir magaza engelliyse
   yalnizca o magaza `blocked` raporlanir.
4. Uretime baglamadan once CLAUDE.md kural 1 (istek yolunda model/dis cagri) ve
   kural 8 (dis cikis `click` kaydi) icin ADR gerekir; bu prototip istek yoluna
   bagli degildir.
