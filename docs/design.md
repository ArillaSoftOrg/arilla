# Tasarım

## Tasarımın işi

Bu ürün bir vitrin değil, bir **karar aracı**. Kullanıcı buraya "güzel bir şey
göreyim" diye gelmiyor; elinde bir ürün var ve "bunun daha uygunu var mı"
sorusunun cevabını istiyor. Tasarımın tek görevi bu cevabı mümkün olan en az
adımda vermek.

Üç sonuç:

1. **İçerik ürün fotoğraflarıdır, arayüz değil.** Arayüz geri çekilir. Renkli
   kartlar, gradyanlar, dekoratif çerçeveler fotoğrafla yarışır.
2. **Fiyat farkı sayfanın kahramanıdır.** Cesaret buraya harcanır, başka yere değil.
3. **Mobil öncelikli.** Kullanıcı Instagram'dan geliyor, tek elle, ayaktayken.

## Marka karakteri (karar 0026)

Arilla'nın public yüzü beş sıfatla tarif edilir; her tasarım kararı bunlardan
birine dayanmalı:

- **Sade.** Arayüz geri çekilir, içerik (ürün fotoğrafı, fiyat) öne çıkar.
- **Nötr.** Siyah/beyaz/gri temel. Renk anlam taşır (tasarruf, uyarı, hata),
  süs değildir. Geniş dekoratif palet yok.
- **Modern alışveriş/keşif ürünü.** Arama önce gelir; yuvarlak ama abartısız
  yüzeyler, büyük dokunma hedefleri, az arayüz kalabalığı.
- **Editoryal ama işlevsel.** Büyük başlıklar ve geniş boşluklar okumayı
  yönlendirir; hiçbir editoryal öğe karar vermeyi yavaşlatmaz.
- **Güven veren, gösterişsiz.** Parıltı, gradyan, yüzen kartlar, ağır gölge
  yok. İddia değil olgu.

Dupe.com bir ürün/UX referansıdır (arama öncelikli akış, bol boşluk, güçlü
tipografi hiyerarşisi, nötr temel), kopyalanacak bir tasarım değildir. Onun
logosu, metinleri, görselleri, illüstrasyonları, sayfa geometrisi ve bileşen
stilleri kullanılmaz. Arilla kendi markası, fontu ve bileşenleriyle kalır.

## Tema

Varsayılan açık tema. Kullanıcının cihaz tercihi koyuysa koyu tema. Ayrıca
`/hesap` altından elle geçiş yapılabilir, tercih çereze yazılır.

```css
:root { color-scheme: light dark; }
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
```

Tema elle zorlandığında `color-scheme` de o temaya sabitlenir; yoksa koyu
cihazda açık tema seçildiğinde form kontrolleri ve kaydırma çubukları koyu
çizilir (Faz 0 bulgusu).

**İki tema da ilk günden tanımlıdır.** Sonradan eklemek her rengi baştan gözden
geçirmek anlamına gelir.

### Renk belirteçleri

Belirteçler **anlamsaldır** (rol adı taşır), sayfaya özgü renk tanımlanmaz.
Mevcut adlar korunur; yeni roller için yeni ad eklenir. Tek kaynak
`packages/ui/src/tokens.css`.

| Rol | Belirteç | Açık | Koyu |
| --- | --- | --- | --- |
| Sayfa zemini | `--paper` | `#FFFFFF` | `#0E0F11` |
| İnce/ikincil yüzey | `--surface` | `#F4F5F6` | `#17191C` |
| Yükseltilmiş yüzey | `--surface-raised` | `#FFFFFF` | `#1E2125` |
| Yüzey hover | `--surface-hover` | `#EBEDEF` | `#262A2F` |
| Birincil metin | `--ink` | `#16181D` | `#F2F3F4` |
| İkincil metin | `--ink-secondary` | `#41454C` | `#C9CDD1` |
| Soluk metin (meta) | `--ink-muted` | `#676B72` | `#9BA0A6` |
| Kenarlık (ayırıcı) | `--line` | `#E3E5E8` | `#2A2E33` |
| Güçlü kenarlık (kontrol sınırı) | `--line-strong` | `#82878E` | `#737982` |
| Birincil eylem zemini | `--accent` | `#16181D` | `#F2F3F4` |
| Birincil eylem metni | `--accent-foreground` | `#FFFFFF` | `#16181D` |
| Birincil eylem hover | `--accent-hover` | `#2E3138` | `#D6D9DC` |
| Odak halkası | `--focus-ring-color` | `#16181D` | `#F2F3F4` |
| Tasarruf / başarı | `--save` | `#1F6F4A` | `#4FBF8B` |
| `--save` üstü metin | `--on-save` | `#FFFFFF` | `#0E0F11` |
| Uyarı | `--warning` | `#8A5300` | `#E2A64A` |
| Hata / yıkıcı | `--alert` | `#A8321F` | `#E5705C` |

Koyu temada `--save`, `--warning` ve `--alert` açılır, yoksa koyu zeminde
okunmaz. Aynı hex değeri iki temada kullanılmaz (tek istisna: `--accent`
ailesi bilerek `--ink`'in ters rolüdür, karar 0025).

**Kontrast (WCAG 2.2 AA, hesaplanmış):**

- Metin rolleri (`--ink`, `--ink-secondary`, `--ink-muted`, `--save`,
  `--warning`, `--alert`) `--paper`, `--surface` ve `--surface-raised`
  üzerinde en az **4.5:1** sağlar. En düşük değer: açık temada `--ink-muted`
  / `--surface` = 4.90:1 (eski `#6E7278` burada 4.43:1'di — Faz 0 bulgusu,
  düzeltildi).
- `--line-strong` bu üç zeminde ve `--surface-hover` üzerinde en az **3:1**
  sağlar (en düşük: açık tema `--surface-hover` üzerinde 3.08:1, koyu tema
  `--surface-hover` üzerinde 3.29:1). Etkileşimli kontrolün sınırını tek
  başına belirten her kenarlık (`input`, ikincil buton, chip) bunu kullanır
  (WCAG 1.4.11) — kontrol hover'da `--surface-hover` dolgusu alsa da.
- `--line` (~1.1–1.4:1) yalnızca **dekoratif** ayırıcı ve statik yüzey
  kenarı içindir; bir kontrolün bulunabilirliği ona bağlı olamaz.
- `--accent-foreground` / `--accent-hover` ≥ 12:1.

Yeni bir renk eklemek bu tabloya satır eklemek demektir; kontrast değeri
hesaplanmadan eklenmez.

Ürün fotoğrafları ve koyu tema için bkz. "Kutu modeli".

Kaçınılanlar: krem zemin + terracotta vurgu, kategori başına ayrı renk, marka
rengi olarak gradyan.

`--save` **sadece** tasarruf tutarında ve birincil eylemde kullanılır.

## Tipografi

İki zorunlu kısıt:

**Tam Türkçe karakter desteği.** ı, İ, ğ, Ğ, ş, Ş, ç, ö, ü hepsi düzgün
çizilmeli. IBM Plex Sans bu testi geçiyor (karar 0009).

**Tabular rakam.** Ürün baştan sona fiyat gösteriyor; sabit genişlikli rakamı
olmayan bir aile yan yana duran fiyatları hizasız gösterir.

```
Aile:      IBM Plex Sans (depodan, değişken dosya — karar 0009)
Ağırlık:   400 (regular), 500 (medium), 600 (semibold — yalnızca display/h1)
Fiyatlar:  font-variant-numeric: tabular-nums — istisnasız
Satır uz.: 70 karakteri geçmez
```

Başlık için ikinci aile kullanılmaz. Kişilik ağırlık, boyut ve boşlukla
kurulur. Font bu fazda değişmez; depodaki değişken dosya 100–700 aralığını
zaten taşıdığı için 600 ek dosya gerektirmez.

### Tip rolleri

Büyük başlıklar `clamp()` ile akışkandır: telefonda küçük uçta, geniş
masaüstünde büyük uçta durur; arada kırılma noktası gerekmez.

| Rol | Belirteç | Boyut (min → max) | Ağırlık | Satır yük. | Harf aralığı |
| --- | --- | --- | --- | --- | --- |
| Display | `--text-display` | 40 → 64px | 600 | 1.1 | -0.02em |
| H1 | `--text-h1` | 32 → 40px | 600 | 1.15 | -0.015em |
| H2 | `--text-h2` | 24 → 32px | 500 | 1.25 | -0.01em |
| H3 | `--text-h3` | 20px | 500 | 1.25 | 0 |
| Gövde büyük | `--text-body-lg` | 18px | 400 | 1.6 | 0 |
| Gövde | `--text-body` | 16px | 400 | 1.6 | 0 |
| Küçük | `--text-small` | 14px | 400 | 1.5 | 0 |
| Meta | `--text-meta` | 13px | 400/500 | 1.5 | 0 |

Satır yüksekliği sütunundaki her değer bir belirteçtir: 1.1 `tight`, 1.15
`snug`, 1.25 `heading`, 1.5 `normal`, 1.6 `body`.

Ağırlık belirteçleri `--font-weight-regular/medium/semibold`, satır
yüksekliği `--line-height-tight/snug/heading/normal/body`, harf aralığı
`--letter-spacing-display/h1/h2`. Eski sabit ölçek (`--font-size-xl` …
`--font-size-xs` = 32/24/18/16/14/13) mevcut bileşenler için korunur; yeni
iş rol belirteçlerini kullanır. Negatif harf aralığı yalnızca 24px ve
üstünde uygulanır; gövde metninde harf aralığı değiştirilmez.

Display rolü sayfa başına en fazla bir kez, yalnızca editoryal giriş
başlığında (ana sayfa hero'su gibi) kullanılır. Bir sayfanın tek `<h1>`'i
görsel olarak Display veya H1 rolünde olabilir — görsel rol ile HTML başlık
seviyesi ayrı şeylerdir.

**Yasak: ALL CAPS.** Türkçede `text-transform: uppercase` i/İ ve ı/I nedeniyle
yanlış harf üretir. Etiketler cümle düzeninde yazılır.

## Fiyat farkı bileşeni

Ürünün imzası. Rozet değil, tipografik bir olay:

```
3.400 TL              üstü çizili, --ink-muted, 16px
1.290 TL              32px, weight 500, --ink
2.110 TL tasarruf     14px, --save
```

Sola hizalı, fotoğrafın hemen altında. Kutu yok, gölge yok, kenarlık yok.

## Kutu modeli: köşe, kenarlık, gölge, odak (karar 0026)

Karar 0026 ile public arayüz tek bir görsel dile geçer. Eski "köşe 0, gölge
hiçbir yerde yok" kuralı ve karar 0025'in bileşen bileşen büyüyen istisna
listesi bunun yerine aşağıdaki **belirteç tabanlı** modelle değişir. Fiyat
farkı bileşeni için "kutu yok, gölge yok, kenarlık yok" kuralı aynen geçerli.

**Geçiş kuralı:** Belirteçler Faz 1A'da tanımlandı; mevcut bileşenler
yeniden tasarlandıkları fazda bu modele taşınır. Taşınana kadar bugünkü
görünümleri (köşesiz `Card`, `Badge`, `ProductCard`, ürün sayfası, yönetim
ekranları) değişmez — toplu, tek adımlık bir görsel değişim yapılmaz.

### Köşe yarıçapı

| Belirteç | Değer | Kullanım |
| --- | --- | --- |
| `--radius` | 0 | Eski köşesiz bileşenler; taşındıkça kullanımdan kalkar |
| `--radius-sm` | 6px | Küçük kontroller: rozet, etiket, küçük görsel |
| `--radius-md` | 12px | Buton, girdi, kart, ürün görseli |
| `--radius-lg` | 20px | Büyük editoryal yüzey, panel, modal, arama kutusu |
| `--radius-pill` | 999px | Chip, hap biçimli buton — koda `999px` yazılmaz |

İç içe yüzeylerde iç köşe dıştakinden küçük veya eşittir.

### Kenarlık

- `--border-width` = 1px. Kalın kenarlık yok.
- **Etkileşimli kontrol sınırı** (girdi, ikincil buton, chip): `--line-strong`
  (≥ 3:1, WCAG 1.4.11).
- **Dekoratif ayırıcı ve statik yüzey kenarı** (kart, liste satırı, bölüm
  çizgisi): `--line`.
- **Rozet:** dolgu yok, 1px kenarlık, `--ink-muted` metin.

### Gölge

Gölge istisnadır, varsayılan değildir. Yüzen kart estetiği yok.

| Belirteç | Kullanım |
| --- | --- |
| `--shadow-xs` | Zemin üstünde duran etkileşimli yüzeyin dinlenme hali (ör. arama kutusu) |
| `--shadow-sm` | Aynı yüzeyin vurgulu hali (hover/focus-within), kaydırılmış yapışkan üst çubuk |
| `--shadow-md` | Yalnızca katman üstü öğeler: açılır menü, modal |

Kartlar gölge kullanmaz; ayrım `--surface-raised` / `--surface` zemin
kontrastı ve gerekirse `--line` ile sağlanır. Koyu temada gölge neredeyse
görünmez; orada ayrımı yüzey tonu taşır.

### Odak

Tek bir klavye odağı sistemi vardır ve her etkileşimli öğe onu kullanır:

```css
outline: var(--focus-ring);          /* 2px solid var(--focus-ring-color) */
outline-offset: var(--focus-ring-offset); /* 2px */
```

Yalnızca `:focus-visible` üzerinde uygulanır. `outline: none` ancak aynı
öğede (veya `:focus-within` ile kapsayıcısında) eşdeğer görünürlükte bir
odak göstergesi varsa yazılır. Odak rengi koda gömülmez — Faz 0'da
`SearchComposer`'daki gömülü `rgba(...)` halkası koyu temada görünmüyordu.

### Ürün fotoğrafı ve koyu tema

Beyaz zeminli ürün fotoğrafı koyu arka planda yüzen bir dikdörtgen gibi
durur. Kart zemini `--surface-raised` olur, fotoğraf o kartın içinde kalır.

## Boşluk

4px tabanlı tek ölçek. Belirteç adındaki sayı 4px'in katıdır
(`--space-12` = 48px). Tek seferlik piksel değeri yazılmaz; ölçekte olmayan
bir değer gerekiyorsa önce ölçek tartışılır.

| Belirteç | Değer | Tipik kullanım |
| --- | --- | --- |
| `--space-1` | 4px | İkon–metin arası, sıkı iç boşluk |
| `--space-2` | 8px | Chip/buton içi dikey, küçük aralık |
| `--space-3` | 12px | Kontrol iç boşluğu |
| `--space-4` | 16px | Kart içi, mobil kenar boşluğu |
| `--space-5` | 20px | Kart içi (geniş) |
| `--space-6` | 24px | Kart arası, tablet kenar boşluğu |
| `--space-8` | 32px | Grup arası, masaüstü kenar boşluğu |
| `--space-10` | 40px | Başlık → içerik |
| `--space-12` | 48px | Mobil bölüm arası |
| `--space-16` | 64px | Tablet/laptop bölüm arası |
| `--space-24` | 96px | Masaüstü bölüm arası |
| `--space-32` | 128px | Büyük editoryal boşluk (yalnızca geniş ekran) |

Bölüm dikey boşluğu akışkandır:
`--section-space` = 48 → 96px, `--section-space-compact` = 32 → 64px
(`clamp()`, ekran genişliğiyle büyür). Bölümler bunu `Section` ilkeli
üzerinden alır; sayfa kendi dikey boşluğunu uydurmaz.

## Düzen ve kapsayıcılar

Sayfa gövdesi içerik türüne göre bir `max-width` ile sınırlanır. Beş değer
kasıtlıdır; yeni bir sayfa en yakın kategoriyi seçer, sayı uydurmaz.

| Bağlam | Belirteç | `max-width` | Örnek |
| --- | --- | --- | --- |
| Kompakt / form | `--content-width-compact` | 360px | `/giris` |
| Okuma akışı | `--content-width-reading` | 640px | hero + arama sütunu, yasal sayfalar |
| Karşılaştırma | `--content-width-comparison` | 720px | `/urun/<slug>`, `/yonetim/eslestirme` |
| Standart | `--content-width-standard` | 960px | tablo/yönetim, bölüm içeriği |
| Geniş | `--content-width-wide` | 1280px | ana sayfa bölümleri, keşif ızgarası |

Genişlik `Container` ilkeliyle uygulanır (`packages/ui/src/Container.tsx`);
`max-width` sayfaya satır içi yazılmaz. Mevcut sayfalardaki satır içi
`maxWidth: 360/720/960` değerleri ilgili sayfa yeniden tasarlanırken
`Container`'a taşınır.

**Kenar boşluğu (gutter)** — `--gutter`, içeriğin ekran kenarına değmesini
önler:

| Genişlik | `--gutter` |
| --- | --- |
| < 640px (telefon) | 16px |
| 640–1023px (tablet) | 24px |
| ≥ 1024px (laptop/masaüstü) | 32px |

## Duyarlı tasarım

Ayrı bir mobil görünüm yok, **tek akışkan düzen** var. Önce mobil yazılır,
geniş ekran `min-width` ile eklenir. Genişlik `flex`/`grid`, `max-width`,
`clamp()` ve `auto-fit`/`minmax()` ile akışkan tutulur; hiçbir bileşene sabit
piksel genişlik verilmez. Etkileşimli öğeler `min-height: 44px` taşır
(bkz. "Kalite tabanı").

**Referans kırılma noktaları.** Cihaz değil, içerik kırılır. Bir düzen
gerçekten değişmek zorundaysa (sütun sayısı, menü biçimi) yalnızca şu üç
değer kullanılır:

| Ad | `min-width` | Ne değişir |
| --- | --- | --- |
| `sm` | 640px | Tablet: gutter 24px, 2+ sütun ızgaralar |
| `lg` | 1024px | Laptop: gutter 32px, masaüstü gezinme, 3+ sütun |
| `xl` | 1440px | Geniş masaüstü: yalnızca ızgara yoğunluğu |

CSS özel özelliği `@media` koşulunda kullanılamadığından bu değerler
belirteç değil, belgelenmiş sabittir; `@media` yazan her dosya yalnızca bu
üç sayıyı kullanır. Cihaza özgü (`375px`, `414px`, `768px` vb.) sorgu
yazılmaz.

**Doğrulama genişlikleri.** Her yeni düzen şu genişliklerde kontrol edilir:
320, 360, 390 (telefon), 768 (tablet), 1024–1280 (laptop), 1440 ve 1920
(geniş masaüstü). 1920px ekran görüntüsü tek başına kabul ölçütü değildir.
320px'te yatay kaydırma olmaz; hiçbir metin taşmaz veya kırpılmaz. Flex
satırlarındaki metin girdileri `min-width: 0` taşır ki flex'in varsayılan
küçülmeme davranışı satırı taşırmasın (bkz.
`packages/ui/src/SearchForm.module.css`).

Keşif masonry ızgarası (`home-discovery.module.css`, 2/3/4/5 sütun) bu üç
noktayı zaten kullanır; artık istisna değil, kuralın örneğidir (dosyadaki
"istisna" yorumu bileşen yeniden tasarlanırken güncellenir).

## Katmanlar (z-index)

`z-index` yalnızca belirteçle yazılır:

| Belirteç | Değer | Kullanım |
| --- | --- | --- |
| `--z-base` | 0 | Normal akış |
| `--z-raised` | 1 | Kardeşinin üstüne çıkması gereken öğe (ör. kart içi rozet) |
| `--z-sticky` | 100 | Yapışkan üst çubuk |
| `--z-dropdown` | 200 | Açılır menü, mobil gezinme paneli |
| `--z-overlay` | 300 | Modal arka örtüsü |
| `--z-modal` | 400 | Modal, diyalog |
| `--z-toast` | 500 | Bildirim / kritik katman |

Mevcut `LoginModal` (`z-index: 100`) yapışkan üst çubukla aynı katmanda;
modal yeniden tasarlanırken `--z-modal`'a taşınır (Faz 1B).

Tek satırlık `<input>` placeholder'ları dar ekranlarda kırpılabilir — bu bir
düzen hatası değildir, tarayıcıların placeholder'ı sarmama (no-wrap)
davranışının doğal sonucudur. Placeholder metni yazarken bunu göz önünde
bulundur.

## Bileşen envanteri

| Bileşen | Nerede | Not |
| --- | --- | --- |
| Arama girdisi | ana sayfa, üst çubuk | Fotoğraf yükleme aynı girdide |
| Netleştirme çubuğu | `/ara` | Sonuçların üstünde, sonuçları beklemez |
| Sonuç sekmeleri | `/ara` | Üç sekme, tanımları `search.md` içinde |
| Ürün kartı | her yerde | Fotoğraf, başlık, fiyat, mağaza sayısı |
| Fiyat farkı | ürün sayfası | Yukarıdaki blok |
| Beden rozeti | ürün kartı ve sayfası | "Senin bedenin var" |
| Mağaza satırı | ürün sayfası | Logo, fiyat, kargo dahil toplam, stok, çıkış |
| Fiyat konumu cümlesi | ürün sayfası | "Son 90 günün en düşüğü" — grafikten önce |
| Fiyat grafiği | ürün sayfası | Tek çizgi, eksen etiketi minimum |
| Sahte indirim notu | ürün sayfası | Nötr olgu sunumu |
| Alternatif şeridi | ürün sayfası | Yatay kaydırma, 4-6 ürün |
| Giriş modali | `/ara`, 2-3 sorgu sonrası | Sonuçlar arkada kalır |
| Keşfet ızgarası | `/kesfet` | Masonry, fotoğraf hakim |
| Trend kartı | `/trend` | Kapak, başlık, ürün önizlemeleri |
| Sponsor rozeti | trend ve sonuçlar | Zorunlu, gizlenemez |
| Creator başlığı | `/@handle` | Avatar, isim, koleksiyon sayısı, takip |
| Eşleştirme kuyruğu | `/yonetim/eslestirme` | İki ürün yan yana, onayla/reddet |
| Sözlük editörü | `/yonetim/sozluk` | Tablo, satır içi düzenleme |
| Boş durum | her liste | Yönlendirme metni, illüstrasyon yok |
| Yükleniyor | görsel arama | İskelet kart, spinner değil |
| Affiliate bildirimi | çıkış öncesi ve altbilgi | Yasal zorunluluk |

## Ana ekranlar

**Ana sayfa.** Tek iş: arama başlatmak. Üstte girdi alanı, altında keşfet
ızgarası. Kayıt istenmez.

**Arama sonucu.** Netleştirme çubuğu (gerekiyorsa) → sekmeler → sonuçlar.
Netleştirme sonuçları asla bekletmez.

**Ürün sayfası.** Fotoğraf → fiyat farkı → fiyat konumu cümlesi → mağaza
listesi → alternatifler → fiyat grafiği. Kullanıcı ilk ekranda karar
verebilmeli.

**Creator vitrini.** Fotoğraf ızgarası hakim, metin minimum. Creator'ın kimliği
öne çıkar, platformun kimliği geri çekilir. Her kartta "daha uygununu bul"
eylemi görünür.

**Giriş modali.** Sonuçların üstünde, sonuçlar arkada okunur halde. Metin
kaydolmayı kazanç olarak sunar: "Hesabın yok mu? Ücretsiz kaydol, bu sonuçları
senin için saklayalım." SEO rotalarında asla gösterilmez.

## Metin kuralları

- Türkçe, cümle düzeninde, sade fiil.
- **"Satın al" yazılmaz.** Satışı biz yapmıyoruz. Doğrusu: "Trendyol'da aç".
- Buton, basınca ne olacağını söyler. Aynı eylem hep aynı isimle anılır.
- Boş ekran davettir: "Henüz kaydettiğin ürün yok. Beğendiğin bir ürünü kaydet,
  ucuzlayınca haber verelim."
- Hata ne olduğunu ve ne yapılacağını söyler, özür dilemez: "Bu mağazadan fiyat
  alamadık. Ürünü mağazada açabilirsin."
- Fiyatın yanında güncellenme zamanı yazılır: "2 saat önce güncellendi".
- Sahte indirim notu nötr olgudur: "Liste fiyatı 3 gün önce 2.400 TL'ydi."
- Seçilmiş içerik "kullanıcıların bulduğu" diye etiketlenmez.

## Hareket

Tek orkestre edilmiş an: görsel arama sonucunun gelişi, iskelet karttan gerçek
karta geçiş. Bölüm giriş animasyonu, kaydırma efekti, paralaks, kartı büyüten
hover yok. Etkileşimli öğelerin durum geçişleri (renk, kenarlık, gölge
tonu) kısa ve sakin olabilir.

| Belirteç | Değer | Kullanım |
| --- | --- | --- |
| `--duration-fast` | 120ms | Hover, basma, renk geçişi |
| `--duration-base` | 200ms | Açılır menü, odak halkası dışı durum değişimi |
| `--duration-slow` | 320ms | Modal/panel girişi, iskelet → kart |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Varsayılan |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Kapanış |

`prefers-reduced-motion: reduce` altında süre belirteçleri `tokens.css`
içinde 0'a çekilir; belirteci kullanan her geçiş kendiliğinden kapanır.
Bileşenler buna ek olarak geçişi `prefers-reduced-motion: no-preference`
içinde tanımlamaya devam edebilir.

## Kalite tabanı

Mobilde çalışır, klavye odağı görünür, kontrast oranları her iki temada
yeterli (bkz. "Renk belirteçleri"), fotoğraflar `alt` metinli, dokunma
hedefleri 44px. Ekranda görünmeyen ama ekran okuyucuya söylenmesi gereken
metin `VisuallyHidden` ile yazılır.

**Hedef (Faz 1B'de site kabuğuna bağlanır, bugün henüz yok):** her sayfa ilk
odaklanabilir öğe olarak `SkipLink` ("İçeriğe geç") taşır ve tek
`<main id="icerik">` içerir. `SkipLink`'in varsayılan hedefi bu id'dir.

## Düzen ilkeleri (packages/ui)

Faz 1A'da eklenen düzen ilkeleri; sayfa ve bileşenler satır içi `style`
yerine bunları kullanır. Görsel tasarım dayatmazlar — yalnızca genişlik,
boşluk ve akış.

| İlke | İşi |
| --- | --- |
| `Container` | `max-width` (beş boyut) + yatay `--gutter` + ortalama |
| `Stack` | Dikey akış, belirteçli `gap` |
| `Cluster` | Yatay, sarılabilen akış, belirteçli `gap` |
| `Section` | Bölüm dikey boşluğu, semantik öğe seçimi |
| `VisuallyHidden` | Görsel olarak gizli, erişilebilir metin |
| `SkipLink` | Odaklanınca görünen "İçeriğe geç" bağlantısı |

## Marka ile ilişki

Marka mavisi logo, pazarlama ve e-posta başlığında kullanılır; **ürün arayüzüne
girmez.** Arayüzdeki tek dekoratif olmayan vurgu tasarruf tutarıdır
(`--save`); `--accent` nötr birincil eylem rengidir (karar 0025), `--warning`
ve `--alert` yalnızca durum bildirir. Detay: `docs/brand.md`.

Font adayları ve onay testi de `docs/brand.md` içinde.

## Karara bağlanacaklar

1. Ürün kartında mağaza logosu gösterilecek mi? Logo hakları ve görsel gürültü.
2. Marka mavisinin kesin hex değeri (yeni logo çizildiğinde).
