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
- Sağ altta, alt kısmı kırpılmış büyük tipografik **"M"** (site fontu IBM Plex
  Sans, `--footer-motif`). Yeni bir logo SVG'si çizilmedi/izlenmedi.
- Alfa değerleri en kötü üst üste binmede (iki parıltı + motif) bile
  `--ink-muted` için ≥ 4.5:1 bırakacak şekilde hesaplandı (açık 4.54:1, koyu
  4.97:1); parıltının en yoğun yeri metnin altındaki motif alanındadır.

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
   kullanılmaz. Tipografik "M" aynı izi verir.
2. **Kapatmayı `localStorage`/çerezde kalıcı tutmak.** Reddedildi: CLAUDE.md
   depolamaya bağımlı akışı yasaklar; oturumluk kapatma yeterli.
3. **Hızlı arama için ayrı gönderim mantığı.** Reddedildi: kilit ve görsel
   durumu ikiye bölünür; tek hook paylaşılır.
4. **Scroll olayında her karede durum yazmak.** Reddedildi: rAF ile kare başına
   tek okuma, durum yalnızca değişince yazılır.

## Sonucu

- `tokens.css`: `--footer-glow-mint`, `--footer-glow-lime`, `--footer-motif`
  (iki temada); `--brand` yorumu istisnayı anar.
- `docs/design.md` ve `docs/brand.md` güncellendi; `docs/copy.md`'ye
  `search.quick_label`, `search.quick_attach`, `search.quick_dismiss`.
