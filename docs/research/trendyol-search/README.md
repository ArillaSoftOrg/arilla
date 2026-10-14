# Trendyol bağımsız ürün arama araştırması

Amaç: kullanıcı yalnızca manicepte.com'da arama yaparak gerçek Trendyol
ürünlerini (ad, fiyat, görsel, bağlantı; mümkünse stok/satıcı) görebilsin;
eklenti yok, Trendyol'u ayrıca açmak yok, ücretli arama API'si yok.

- Kanıtlar ve ham test çıktıları: [`01-kanit-kaydi.md`](01-kanit-kaydi.md)
- Fiyat keşfi ve fiyat zenginleştirme mimarisi: [`02-fiyat-zenginlestirme.md`](02-fiyat-zenginlestirme.md)
- Satıcı kaynaklı fiyat (Partner API, kimlik eşleştirme, referans set): [`03-satici-kaynakli-fiyat.md`](03-satici-kaynakli-fiyat.md)
- Buybox, fiyat alanları, geniş kapsam: [`04-buybox-ve-kapsam.md`](04-buybox-ve-kapsam.md)
- Yetkili erişimde test protokolü: [`05-test-protokolu.md`](05-test-protokolu.md)
- Fiyat katmanları (Samba farkı), limitler, kapsam ve dizin istatistikleri: [`06-fiyat-katmanlari-ve-kapsam.md`](06-fiyat-katmanlari-ve-kapsam.md)
- Stok-Fiyat servisi, entegratörler, dizin doğrulaması, hipotez kaydı: [`07-entegratorler-dizin-hipotezler.md`](07-entegratorler-dizin-hipotezler.md)
- Fiyat dağıtım zinciri, Open Prices, satıcı mağaza sitemap'i, varyant eşleştirmesi: [`08-dagitim-zinciri-ve-varyant.md`](08-dagitim-zinciri-ve-varyant.md)
- Tam ürün dizini raporu (8.126.053 ürün, marka normalizasyonu, kimlik hiyerarşisi, arama kalitesi): [`09-tam-dizin-raporu.md`](09-tam-dizin-raporu.md)
- Ürün grupları (temsilci hipotezi yanlışlandı: %99,4), birleşik keşif, Gemini incelemesi: [`10-urun-gruplari.md`](10-urun-gruplari.md)
- Fiyat mimarisi (7 katman), H12–H13, 20 sayfalık kapsam (%99,86), sitemap fark ölçümü: [`11-fiyat-mimarisi-ve-kapsam.md`](11-fiyat-mimarisi-ve-kapsam.md)
- Fiyat doğrulama sistemi, satıcı pilotu (kota/anahtar), yeni sitemap üretimi (%99,906 süreklilik): [`12-dogrulama-sistemi-ve-pilot.md`](12-dogrulama-sistemi-ve-pilot.md)
- İki sitemap üretiminin kimlik bazlı karşılaştırması: [`13-uretim-karsilastirmasi.md`](13-uretim-karsilastirmasi.md)
- Yeni yöntemler (yorumlu ürün sitemap'i 505 bin, yurt dışı sitemap'ler), ücretsiz Gemini URL Context ölçüm düzeneği, katalog eşlemesi: [`14-yeni-yontemler-gemini-ve-katalog.md`](14-yeni-yontemler-gemini-ve-katalog.md)
- Kod (bu dal): `packages/core/src/trendyol-landing/`, `packages/core/scripts/trendyol-*-cli.ts`
- Dal / worktree: `research/trendyol-landing-discovery` → `../repo-docs-trendyol-landing`
- İlgili, dokunulmayan çalışmalar: PR #125 (`feature/trendyol-live-discovery-prototype`),
  `research/live-search-extension` (Chrome eklentisi + Hepsiburada CORS yoklaması)

## Durum (2026-10-12)

**Keşif çözüldü, erişim çözülmedi.**

- Trendyol'un kendi yayınladığı ve robots.txt'in izin verdiği sitemap'lerden iki
  dizin kurulabiliyor. Sunucu (Node) bunlara 200 ile erişiyor:
  1. **Liste sayfası dizini**: 455.549 filtre, marka ve arama terimi sayfası.
     Sorguyu doğru Trendyol sayfasına çeviriyor (5/5 test sorgusu).
  2. **Ürün dizini**: yaklaşık 8,1 milyon ürün; bağlantı, slug'dan ad ve gerçek
     CDN görseli içeriyor. **Fiyat ve stok yok.**
- Fiyat ve stok yalnızca HTML sayfalarında (liste sayfasının gömülü JSON'u, ürün
  sayfasının JSON-LD'si) bulunuyor:
  - Node istemcisi bu sayfalarda Cloudflare'den **403** alıyor.
  - Tarayıcıdan başka bir origin'le okuma **CORS** ile kapalı.
- Gerçek tarayıcıda 5 sorgunun 5'inde doğru ürünler, fiyat, görsel ve bağlantıyla
  bulundu. Bu, keşif ve eşleştirme mantığını kanıtlar; ManiCepte web uygulamasında
  çalıştığını kanıtlamaz.

## Sınıflandırma

| Sınıf | Çözüm | Karşılanan | Eksik | Geliştirme | Başlangıç / işletme maliyeti | Kapsam | Fiyat güncelliği | Ölçek | Hukuk |
|---|---|---|---|---|---|---|---|---|---|
| **A (kısmi)** | Sorgu → doğru Trendyol liste sayfasına bağlantı (455 bin sayfalık dizin) | Eklentisiz, ücretsiz, Trendyol sunucusuna sorgu başına istek yok | Ürün ManiCepte'de gösterilmez; kullanıcı Trendyol'a gider | Düşük (hazır) | 0 / günlük ~200 MB sitemap | Tüm site | — | Yüksek | Yalnızca bağlantı; affiliate takibi için program şart. "Ticari kullanım doğrulandı" denemez, hukuki görüş önerilir |
| **B** | Ürün sitemap metadata dizini (ad, görsel, bağlantı) | Eklentisiz, ücretsiz, Node ile erişilebilir, gerçek görsel ve bağlantı | **Fiyat ve stok yok**; ad slug'dan (Türkçe karakter yok) | Orta (hazır prototip; tam ölçek bellek ~1–2 GB) | 0 / yeniden kurulumda ~15 GB indirme | ~8,1 milyon ürün | Yok (sitemap'te fiyat yok) | Tek sunucu; sunucusuz ortama uygun değil | Kullanım koşulları "izinsiz kopyalanamaz, yeniden yayımlanamaz" → izin veya hukuki görüş şart; görsel hakları satıcıda olabilir |
| **C** | Hibrit: dizin (A/B) + canlı fiyat (liste sayfası JSON'u veya ürün JSON-LD'si) | Hedefin tamamı: ad, fiyat, görsel, bağlantı, satıcı, stok | Trendyol'un ManiCepteBot'u izin listesine alması (Cloudflare) + ticari izin | Düşük (kod hazır, `discover.ts`) | 0 / sorgu başına 1–3 istek | Tüm site | Canlı | Hız sınırlı | Trendyol ile yazılı izin |
| **C** | Productsup feed kanalı | Fiyat, görsel, bağlantı | Trendyol'un ManiCepte'yi export kanalı eklemesi | Orta (mevcut ingest hattı) | Anlaşmaya bağlı | Trendyol'un seçtiği | Feed sıklığı | Yüksek | Sözleşme; pratikte katalog depolama |
| **C** | Admitad / Takefluence | Affiliate link | TR teklifi kapalı görünüyor (doğrulanmadı); influencer şartı | — | — | — | — | — | Ana çözüm olarak önerilmiyor |
| **D** | Node ile HTML (`/sr`, liste, ürün) | — | 403 Cloudflare | | | | | | |
| **D** | Tarayıcıdan başka origin'den okuma | — | CORS | | | | | | |
| **D** | `/sr?q=` arama, `?pi=` sayfalama, `apigw.trendyol.com` | — | robots.txt yasak (apigw `Disallow: /`) | | | | | | |
| **D** | Common Crawl / Internet Archive | — | CC 403 almış; IA robots ile yasak | | | | | | |
| **D** | Sovrn (TR pazarı yok), Awin/Skimlinks (yalnız DE), Bing API (kapandı), Google CSE (yeni müşteriye kapalı) | — | — | | | | | | |
| ? | Akakçe / Cimri / Epey veri ortaklığı | — | Herkese açık API bulunamadı; iş ortaklığı sorulmadı | | | | | | |

Hiçbir yöntem bugün **A (ticari kullanım doğrulandı + ürün gösterimi)** değil.

## Prototipler

- `scripts/trendyol-landing-cli.ts "<sorgu>" [--resolve-only]` — sorgu → liste sayfası → (izin olursa) canlı fiyatlı ürünler (C).
- `scripts/trendyol-product-index-cli.ts build|search` — ürün sitemap dizini (B), kaldığı yerden devam eder.
- `scripts/trendyol-search-server.ts` — eklentisiz arayüz: ad + görsel + bağlantı + en uygun Trendyol sayfası; fiyat yok (A+B).

## Sonraki oturum için devam planı

1. **Tam ürün dizinini bitir** (kaldığı yerden devam eder):
   `cd packages/core && node --experimental-transform-types --no-warnings scripts/trendyol-product-index-cli.ts build --files 1-337`
   Ardından 5 sorguyu `search` ile çalıştır, sonuç sayılarını `01-kanit-kaydi.md` Faz 6'ya yaz.
2. **Sitemap güncelliğini ölç**: `sitemap_index.xml` `lastmod` değerlerini birkaç gün
   kaydet; aynı ürün dosyasının günlük farkını (yeni/silinen ürün) ölç.
3. **B için ürün kararı**: fiyatsız kart ("Güncel fiyat Trendyol'da") kabul edilebilir mi?
4. **Hukuk**: Trendyol kullanım koşullarındaki "önceden izin alınmadan ve kaynak
   gösterilmeden" maddesinin sitemap metadata'sı ve görsel gösterimi için yorumu.
5. **Trendyol başvurusu (C)**: ManiCepteBot için (a) robots ile zaten serbest liste ve
   ürün sayfalarına hız sınırlı erişim izni (sabit IP veya Cloudflare doğrulanmış bot /
   Web Bot Auth imzası), (b) ad, fiyat ve görsel gösterimi için ticari izin, (c) affiliate
   takibi. İzin gelirse `scripts/trendyol-landing-cli.ts "<sorgu>"` değişmeden uçtan uca test edilir.
6. Açık hipotezler: fiyat karşılaştırma platformlarıyla veri ortaklığı; Cloudflare Web Bot
   Auth'un Trendyol'da kabul edilip edilmediği (yalnızca Trendyol'un onayıyla).

## Kurallar (bu araştırmada uyulan)

CAPTCHA, proxy/IP rotasyonu, parmak izi taklidi, başka istemciyle 403 atlatma,
CORS dolanma ve dahili uç nokta kullanımı yok. 403/429'da durulur. Sabit ürün
URL'si okumak canlı arama başarısı sayılmaz.
