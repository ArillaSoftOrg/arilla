# Eklentisiz canlı arama yoklaması (araştırma, 2026-10-12)

Soru: Kullanıcı eklenti kurmadan, yalnızca manicepte.com'u açarak Trendyol ve
Hepsiburada ürünlerini görebilir mi?

Kısa cevap: **Hepsiburada için teknik olarak evet** (ziyaretçinin tarayıcısından,
mağazanın açık CORS izniyle). **Trendyol için hayır.** Hukuki onay olmadan üretime
alınmamalı.

## Chrome prototipi veriye nasıl erişiyordu?

İçerik betiği mağazanın kendi sekmesinde, mağazanın kaynağında (same-origin)
çalışır. Sayfa zaten kullanıcının gerçek tarayıcısında, kullanıcının çerezleri,
IP'si ve tarayıcı parmak iziyle yüklenmiştir. Bot koruması normal bir ziyaret
görür. Betik yalnızca sunucunun sayfaya gömdüğü veriyi okur:

- Trendyol: `window["__single-search-result__PROPS"]` (36 ürün).
- Hepsiburada: `<script id="reduxStore">` içindeki
  `voltranState.fragmentsMap.*.ProductList.seoState.itemListElement`
  (schema.org ItemList, metin olarak).

Başka bir sitedeki sayfa bu ayrıcalıkların hiçbirine sahip değildir.

## Ölçümler (gerçek tarayıcı, Chrome)

| Test | Trendyol | Hepsiburada |
|---|---|---|
| example.com'dan `fetch(..., {mode:"cors", credentials:"omit"})` | **Başarısız** (`Failed to fetch`, CORS) | **200, gövde okunabilir** (2,7 MB, 36 ürün, doğrulama ekranı yok) |
| Aynı istek çerezle (`credentials:"include"`) | — | Başarısız (wildcard ACAO çerezli isteğe izin vermez) |
| `Access-Control-Allow-Origin` | Yok | `*` (ana sayfada doğrudan okundu) |
| iframe ile gömme | (denenmedi, okunamaz zaten) | `frame-ancestors` yalnızca `*.hepsiburada.com`, `*.hepsipay.com` |
| robots.txt arama yolu | `/sr?` yasak (tüm botlar) | `/ara` için kural **yok** |
| Sunucudan istek (PR #124, #125) | 403 | 403 (Akamai), robots.txt bile |
| Resmî veri kanalı | Partner API yalnız satıcı; affiliate yalnız sosyal medya linki (günde 8 link, cep telefonu komisyon dışı); feed/API yok | Merchant API yalnız satıcı; affiliate/Linkgelir var, feed doğrulanamadı |

Uygulanabilirlik testi (`index.html` + `probe.js`): localhost'tan (manicepte.com
yerine) ziyaretçinin tarayıcısıyla, eklentisiz:

- "iPhone 16 Pro": Hepsiburada 36 sonuç, 4 eşleşme, 2,3 sn, 2,8 MB (ör. Apple
  iPhone 16 Pro 128GB Natürel Titanyum, 124.999,00 TRY, stokta, görsel yüklendi).
  Trendyol: CORS engeli, sonuç yok.
- "Sony WH-1000XM5": Hepsiburada 25 sonuç, 5 eşleşme, 1,7 sn (ör. 15.489,00 TRY).
  Trendyol: CORS engeli.

## Mimari seçenekler

| Seçenek | Trendyol | Hepsiburada | Maliyet | Risk |
|---|---|---|---|---|
| A. Sunucu tarafı istek / proxy | Hayır (403, robots `/sr` yasak) | Hayır (Akamai 403) | — | Engeli aşmak gerekir: kapsam dışı |
| B. Sunucuda headless tarayıcı | Hayır | Hayır | Yüksek | Bot koruması aşma, robots ihlali: kapsam dışı |
| C. Ziyaretçi tarayıcısından CORS ile okuma (bu yoklama) | **Hayır** (CORS) | **Evet** | Sunucu maliyeti ~0; ziyaretçiye arama başına ~2–3 MB | Aşağıya bakın |
| D. iframe | Hayır | Hayır (`frame-ancestors`) | — | — |
| E. Mağazada arama bağlantısı ("Hepsiburada'da ara") | Evet (yalnız link) | Evet | 0 | Düşük; ürün ManiCepte'de gösterilmez |
| F. Resmî feed / API / veri anlaşması | Başvuru gerekir | Başvuru gerekir | İş geliştirme | En düşük hukuki risk; çoğu feed = katalog (mevcut ingest hattı) |
| G. Tarayıcı eklentisi / mobil uygulama WebView | Evet | Evet | Orta | Kurulum gerekir (hedef dışı) |

### C seçeneğinin riskleri ve gereksinimleri

- **Hukuki:** CORS izni teknik bir sinyaldir, içerik lisansı değildir. Hepsiburada
  kullanım koşulları doğrulanamadı (sözleşme sayfası girişe yönlendiriyor).
  Ürün verisi/görselini ManiCepte arayüzünde göstermek için yazılı izin veya
  hukuki görüş gerekir.
- **KVKK / CLAUDE.md:** ManiCepte sayfası ziyaretçinin IP'sini ve sorgusunu
  üçüncü tarafa (Hepsiburada) gönderir; görseller Hepsiburada CDN'inden yüklenir.
  Bu, "üçüncü taraf kaynak yükleme" kuralı ve karar 0087 ile çelişir; açık
  bilgilendirme/rıza ve ayrı bir karar gerekir. CSP'ye `connect-src`/`img-src`
  eklenmesi gerekir.
- **Kararlılık:** Hepsiburada `Access-Control-Allow-Origin: *` başlığını haber
  vermeden kaldırabilir; gömülü `reduxStore` yapısı resmî sözleşme değildir.
- **Performans:** Arama başına ~2–3 MB HTML ziyaretçi tarafından indirilir (mobil
  veri). Yalnız ilk sayfa (≤36 ürün).
- **Kurallar:** `click` attribution (kural 8) bu bağlantılar için üretilmez;
  affiliate değil. Sonuçlar saklanmaz (kural 3 istisnası gibi ayrı karar).
- **Ölçek:** Her ManiCepte araması Hepsiburada'ya bir istek demek; yoğun trafikte
  Hepsiburada bunu toplu otomasyon olarak görebilir. Hız sınırı ve bayrak gerekir.

## Sonuç

- Kullanıcı yalnızca ManiCepte'yi açarak **Hepsiburada** ürünlerini görebilir:
  teknik olarak kanıtlandı, hukuki olarak kanıtlanmadı.
- **Trendyol** ürünleri eklentisiz, ücretli API'siz ve kısıtlama aşmadan
  ManiCepte'de gösterilemez. Tek meşru yol resmî veri anlaşması; ara çözüm
  arama bağlantısı (E).
