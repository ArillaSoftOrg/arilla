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

## Tema

Varsayılan açık tema. Kullanıcının cihaz tercihi koyuysa koyu tema. Ayrıca
`/hesap` altından elle geçiş yapılabilir, tercih çereze yazılır.

```css
:root { color-scheme: light dark; }
```

**İki tema da ilk günden tanımlıdır.** Sonradan eklemek her rengi baştan gözden
geçirmek anlamına gelir.

### Belirteçler

| Belirteç | Açık | Koyu |
| --- | --- | --- |
| `--paper` | `#FFFFFF` | `#0E0F11` |
| `--surface` | `#F4F5F6` | `#17191C` |
| `--surface-raised` | `#FFFFFF` | `#1E2125` |
| `--ink` | `#16181D` | `#F2F3F4` |
| `--ink-muted` | `#6E7278` | `#9BA0A6` |
| `--line` | `#E3E5E8` | `#2A2E33` |
| `--save` | `#1F6F4A` | `#4FBF8B` |
| `--alert` | `#A8321F` | `#E5705C` |

Koyu temada `--save` ve `--alert` açılır, yoksa koyu zeminde okunmaz. Aynı hex
değeri iki temada kullanılmaz.

**Ürün fotoğrafları koyu temada zorluk çıkarır.** Beyaz zeminli ürün fotoğrafı
koyu arka planda yüzen bir dikdörtgen gibi durur. Çözüm: kart zemini
`--surface-raised` olur, fotoğraf o kartın içinde kalır, doğrudan sayfa
zemininde durmaz.

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
Aile:      IBM Plex Sans, iki ağırlık (400, 500)
Fiyatlar:  font-variant-numeric: tabular-nums — istisnasız
Ölçek:     32 / 24 / 18 / 16 / 14 / 13
Satır yük: gövde 1.6, başlık 1.25
Satır uz.: 70 karakteri geçmez
```

Başlık için ikinci aile kullanılmaz. Kişilik ağırlık ve boşlukla kurulur.

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

## Kart ve buton kutu modeli

Fiyat farkı bileşenindeki "kutu yok, gölge yok, kenarlık yok" kuralı genele
uygulanır:

- **Köşe yarıçapı: 0.** Hiçbir bileşende `border-radius` kullanılmaz.
- **`box-shadow` hiçbir yerde kullanılmaz** — hiçbir temada.
- **Etkileşimli öğeler** (buton, girdi): 1px `--line` kenarlık. Dokunma
  hedefi ve klavye odağı sınırı burada başlar.
- **Statik yüzeyler** (kart): kenarlık yok. Ayrım `--surface-raised`
  dolgusunun `--surface`/`--paper` zeminden renk kontrastıyla sağlanır
  (bkz. yukarıdaki "Tema" bölümü, karar 0007).
- **Rozet:** dolgu yok, 1px `--line` kenarlık, `--ink-muted` metin.

Bu kural `packages/ui`'deki her bileşen ve bu bileşenleri kullanan her sayfa
(D2, D3, D5 dahil) için geçerlidir.

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
karta geçiş. Kart hover'ı, bölüm giriş animasyonu, kaydırma efekti yok.
`prefers-reduced-motion` her zaman dinlenir.

## Kalite tabanı

Mobilde çalışır, klavye odağı görünür, kontrast oranları her iki temada
yeterli, fotoğraflar `alt` metinli, dokunma hedefleri 44px.

## Marka ile ilişki

Marka mavisi logo, pazarlama ve e-posta başlığında kullanılır; **ürün arayüzüne
girmez.** Arayüzdeki tek vurgu rengi tasarruf tutarıdır. Detay: `docs/brand.md`.

Font adayları ve onay testi de `docs/brand.md` içinde.

## Karara bağlanacaklar

1. Ürün kartında mağaza logosu gösterilecek mi? Logo hakları ve görsel gürültü.
2. Marka mavisinin kesin hex değeri (yeni logo çizildiğinde).
