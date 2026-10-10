# 0093 — Markalı footer, public dekoratif limon istisnası ve yüzen hızlı arama

**Tarih:** 10 Ekim 2026 · **Durum:** kabul edildi (ürün sahibi talebi)

0084'teki "`--brand` yalnızca `/yonetim`" kuralına public sayfalar için dar bir
dekoratif istisna ekler; ana sayfaya yüzen bir hızlı arama kutusu getirir.

## Karar

### 1. Public dekoratif limon istisnası

`--brand` (`#B7F52F`) public sayfalarda **yalnızca dekoratif atmosfer**
olarak kullanılabilir (bugün: footer parıltısı, düşük alfa). Metin, gövde
yazısı, tek başına çizgi, ikon rengi ya da durum rengi olarak **kullanılmaz**
(beyaz üzerinde ~1.3:1). Dekoratif katmanlar `aria-hidden`, `pointer-events:
none`; `forced-colors` ve baskıda gizlidir. Kontrast her zaman alttaki metne
göre ölçülür; dekor onu 4.5:1'in altına indiremez.

### 2. Markalı footer (`SiteFooter`)

- Tüm `SiteFooter` sayfalarında; `EditorialFooter` değişmedi. İçerik ve
  bağlantılar aynı.
- Zemin `--surface`; alta doğru iki radyal parıltı: nane/aqua
  (`--footer-glow-mint`) ve limon (`--footer-glow-lime`). Açık temada sıcak
  kırık beyazdan alta doğru çok hafif nane/limon tonu; koyu temada grafit
  üzerinde çok düşük alfalı limon/nane havası.
- En altta, iki yandan ve alttan kırpılmış büyük **"ManiCepte"** kelime
  işareti (site fontu IBM Plex Sans, kalın ve eğik — üst çubuktaki marka
  yazısıyla aynı dil). Marka yeşilinden naneye (açık) ya da yeşilden koyuya
  solan (koyu) degrade dolgu (`--footer-wordmark-from/-to`), arkasında güçlü
  limon parıltısı (`--footer-band-glow`). Yeni bir logo SVG'si
  çizilmedi/izlenmedi.
- Kelime işareti metnin **altındaki kendi şeridindedir**; hiçbir footer
  metniyle üst üste binmez (her genişlikte metinle arasında 32px). Bu yüzden
  yeşil orada güçlü kullanılabilir; yeşil asla footer metni değildir.
- Metin bölgesindeki parıltı alfa değerleri en kötü üst üste binmede bile
  `--ink-muted` için ≥ 4.5:1 bırakır (açık 4.81:1, koyu 4.90:1).
- **Footer affiliate cümlesi kaldırıldı** ("Bazı bağlantılardan alışveriş
  yaptığında komisyon kazanabiliriz…" + bağlantı). Bildirim, tıklama
  noktasında kalır: ürün sayfasında mağaza bağlantısının yanında ve fiyat
  tablosunun altında; `/affiliate-aciklamasi` sayfası ve footer "Yasal"
  sütunundaki bağlantısı aynen durur. Bu, 0026'nın "altbilgideki
  affiliate/fiyat bildirimi" kısıtını public site footer'ı için daraltır
  (fiyat/stok uyarısı footer'da kalır; `EditorialFooter` değişmedi).

### 3. Yüzen hızlı arama (yalnızca ana sayfa)

- **Görünürlük:** ana kutu ekrandayken gizli (IntersectionObserver, yalnızca
  `<search>` kutusu sayılır). Ana kutu ekran dışındayken aşağı kaydırma
  (≥ 8px) gösterir; yukarı ≥ 24px gizler; tekrar aşağı kaydırma gösterir.
  Eşik yön değiştirdiği noktadan ölçülür (histerezis). Kaydırma pasif dinleyici
  + `requestAnimationFrame`; iOS lastik sıçraması için konum [0, en alt]
  aralığına kırpılır. Odak kutudayken (yazma, mobil klavye) kaydırma gizlemez.
  Çerez bandı görünürken gizli.
- **Gönderim:** ana kutuyla **tek** `useHomeComposerSubmission` örneği
  (gönderim kilidi, giriş modalı, hazırlanan görsel, hata ortak). Metin ve
  yapıştırılan ürün bağlantısı doğrudan desteklenir (aynı `SearchComposer`,
  `variant="mini"`). "+" görsel seçmez: ana kutuya kaydırır ve fotoğraf
  düğmesine odaklanır. Hazırlanan görsel varsa küçük bir işaret olarak görünür
  ve aynı mesajla gider.
- **Yerleşim:** masaüstünde altta ortalı (en çok 640px); 640px altında alta
  yapışık, güvenli alan (`env(safe-area-inset-bottom)`) dahil.
- **Kapatma:** küçük "×". Kapatılınca o sayfa ömrü boyunca gizli; yenileme ya
  da gezinme sıfırlar. Depolama (çerez, `localStorage`) **yok**. Odak kutudaysa
  `<main id="icerik">`ye kaydırmadan taşınır.
- **Erişilebilirlik:** ayrı arama bölgesi adı "Hızlı arama"; "+" ve "×"
  etiketli; gizliyken `inert` + `aria-hidden`; azaltılmış harekette geçiş yok.
  Hata metni görünür ama yalnızca ana kutu duyurur (çift duyuru yok).
- Analitik olayı eklenmedi.

## Gerekçe

Uzun ana sayfada arama kutusu ilk ekranda kalıyor; geri kaydırmadan arama
yapmak dönüşümü artırır. Footer markasız ve düzdü; limon ikonla tutarlı,
düşük alfalı bir atmosfer kimlik kazandırırken metin kontrastını korur.

## Reddedilen alternatifler

1. **Logoyu SVG olarak izleyip footer'a koymak.** Reddedildi: resmi vektör
   yok (docs/brand.md); izlenmiş logo marka sahibinin onayı olmadan
   kullanılmaz. Site fontuyla yazılmış kelime işareti aynı izi verir.
2. **Kapatmayı `localStorage`/çerezde kalıcı tutmak.** Reddedildi: CLAUDE.md
   depolamaya bağımlı akışı yasaklar; oturumluk kapatma yeterli.
3. **Hızlı arama için ayrı gönderim mantığı.** Reddedildi: kilit ve görsel
   durumu ikiye bölünür; tek hook paylaşılır.
4. **Scroll olayında her karede durum yazmak.** Reddedildi: rAF ile kare başına
   tek okuma, durum yalnızca değişince yazılır.

## Sonucu

- `tokens.css`: `--footer-glow-mint`, `--footer-glow-lime`,
  `--footer-wordmark-from`, `--footer-wordmark-to`, `--footer-band-glow`
  (iki temada); `--brand` yorumu istisnayı anar.
- `docs/design.md` ve `docs/brand.md` güncellendi; `docs/copy.md`'ye
  `search.quick_label`, `search.quick_attach`, `search.quick_dismiss`.
