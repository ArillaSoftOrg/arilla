# 0117 — Trendyol: tarayıcı tabanlı sayfa okuma (sözlü izin, bayraklı)

**Tarih:** 15 Ekim 2026
**Durum:** Önerildi. Kod `packages/core/src/live-search-browser/`, bayrak **kapalı**. Yazılı izin
kapsamı gelene kadar otomatik toplu okuma ve katalog aktarımı **yok**.
Numara, merge öncesi main ve açık PR'larla yeniden doğrulanır (0115, 0116 açık PR'larda).

## Bağlam

- Trendyol ile görüşüldü:
  - Resmî API verilemiyor; CORS açılmayacak.
  - Hepsiburada'daki tarayıcı tabanlı yöntemin **benzerine sözlü izin** verildi.
  - Katalog yenileme sınırı: **haftada en fazla 1, ayda en fazla 4**.
- Sunucu (Node) Trendyol HTML'ine Cloudflare 403 alıyor. Başka origin'den tarayıcı okuması CORS ile kapalı (araştırma 01).
- Trendyol'un **kendi origin'inde açık** ürün ve liste sayfası, sunucunun gömdüğü yapılandırılmış veriyi taşıyor. Ölçüm araştırma 16'da:
  - `window["__envoy__SHARED_PROPS"].product`;
  - JSON-LD `Product` / `ProductGroup`;
  - `window["__single-search-result__PROPS"]`.
- CLAUDE.md "scraping birincil kaynak olamaz" der. Bu yöntem kazıma altyapısı değildir: kullanıcının ya da operatörün tarayıcısında, izinli kapsamda, sayfada zaten bulunan veri okunur. Yine de izin yazılı olana kadar **birincil kaynak yapılmaz**.

## Karar

1. **Okuma yalnız Trendyol origin'inde açık sayfada yapılır.**
   - Okuyan: tarayıcı eklentisinin içerik betiği (izole dünya; `<script>` metinleri DOM'dan okunur).
   - Ağ isteği, proxy, CORS dolanma, bot koruması atlatma, oturum ya da kimlik taklidi, dahili servis (`apigw.trendyol.com`) **yok**.
   - Diğer satıcıların teklifleri sayfaya sonradan dahili servisten yüklendiği için okunmaz; yalnız sayıları alınır.
2. **İş mantığı core'da.** Eklenti ince istemcidir (CLAUDE.md kural 6). Taşınan modüller:
   - `apps/live-search-extension/extract.js` → `search-page.ts`;
   - ürün sayfası ayrıştırıcısı (`trendyol-product-page.ts`);
   - yenileme kotası (`refresh-quota.ts`);
   - sitemap eşlemesi (`sitemap-match.ts`);
   - katalog satır önizlemesi (`catalog-rows.ts`).
3. **Bayraklar** (varsayılan kapalı):
   - `TRENDYOL_BROWSER_READ_ENABLED`: ayrıştırma ve kuru çalışma.
   - `TRENDYOL_BROWSER_SCOPE_CONFIRMED`: izin kapsamı **yazılı** netleşti. Toplu yenileme ve aktarım için ikisi birlikte gerekir.
4. **Kota.** Haftalık ve aylık sınır muhafazakâr yorumlanır:
   - Bir yenileme döngüsünden sonraki **7 × 24 saat** içinde yenisi başlamaz (kayan pencere).
   - İstanbul takvim ayında en fazla **4** döngü başlar.
   - Başlayan her döngü kotadan düşer.
   - Kesilen döngü yalnız kendi 7 günlük penceresinde, aynı hedef listesiyle (sha256) kaldığı yerden devam eder.
   - Bir ürün döngü başına en fazla bir kez okunur.
5. **Veri en aza indirilir.** Sayfadaki satıcı nesnesi vergi no, KEP e-postası, adres ve unvan taşır. Ayrıştırıcı yalnız satıcı `id` ve `name` alanlarını okur.
6. **Fiyat uydurulmaz.** Fiyat yalnız kaynağın verdiği alandan, kuruş tamsayı olarak alınır.
   - Katmanlar ayrı tutulur: `discounted` (sayfanın ödenecek gösterdiği), `selling`, `original`, kupon.
   - Kaynak etiketleri saklanır; yüzde ya da kampanya matematikten çıkarılmaz.
   - Fiyat yoksa `price_point` yazılmaz. Stok bilinmiyorsa ürün stokta sayılmaz.
   - Her satırda kaynak (`trendyol_browser_page`) ve gözlem zamanı bulunur.
7. **Katalog eşlemesi** (araştırma 14 §4 ile aynı):
   - `seller` = sayısal satıcı kimliği;
   - `offer` satıcı başınadır (`<contentId>:<saticiId>`);
   - `offer_variant` = `itemNumber`, GTIN yalnız GS1 geçerliyse;
   - `price_point` yalnız INSERT.

## Reddedilen alternatifler

| Alternatif | Neden değil |
|---|---|
| Sunucudan farklı istemciyle (curl, gerçek tarayıcı taklidi) HTML çekmek | Bot korumasını atlatmak; izin "tarayıcı tabanlı" |
| CORS proxy / sunucu aracılı okuma | CORS engelini yetkisiz aşmak |
| `apigw.trendyol.com` dahili servisleri (diğer satıcılar, sayfalama) | robots `Disallow: /`; belgelenmemiş dahili servis |
| Gemini URL Context ile fiyat (H9) | Ölçüldü: %61–80 doğru, hatalar kalıcı ve ayırt edilemez (araştırma 15) |
| Kullanıcı eklentilerinden kitle kaynaklı veri toplamak | İzin kapsamı belirsiz, KVKK (kullanıcının gezinmesi). Yazılı izin ve ayrı karar ister |
| Haftalık sınırı takvim haftası olarak yorumlamak | Pazar + Pazartesi iki yenileme olur; sözlü sınırın amacına aykırı |

## Sonuçlar

- Mevcut CHECK'lere uymayan değerler var. Aktarım öncesi `packages/db`'de ayrı ve geriye uyumlu bir migration ile karar gerekir (kural 5, 14):
  - `merchant.source_type`;
  - `offer.discovery_source`;
  - `offer_variant.gtin_source`.
- Kapsam 8,13 milyon ürün **değildir**. Döngü başına okunabilecek sayfa sayısı izinli hıza bağlı ve bilinmiyor (araştırma 16 §5). Liste sayfasında ilk 36 ürün okunur; sayfalama (`?pi=`) robots ile yasak.
- **Açık:**
  - izin kapsamının yazılı hâli: kim okur (operatör / kullanıcı), hangi hız, hangi sayfalar, ManiCepte'de gösterim ve saklama;
  - affiliate takibi;
  - migration.
