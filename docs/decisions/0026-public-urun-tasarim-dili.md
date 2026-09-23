# 0026 — Arilla public ürün tasarım dili

**Tarih:** 2026-09 · **Durum:** kabul edildi · **Yerini aldığı:** 0025'in
kutu modeli istisnası (0025'in `--accent` kararı geçerliliğini korur)

## Karar

Public site (ana sayfa, arama, keşif, ürün, bilgi sayfaları) tek, belirteç
tabanlı bir görsel dile geçer. Tanım `docs/design.md` içindedir; tek kaynak
`packages/ui/src/tokens.css`.

1. **Belirteçler genişletilir:** anlamsal renk rolleri (ikincil metin,
   güçlü kenarlık, hover, odak, uyarı), akışkan tip rolleri (display → meta),
   ağırlık/satır yüksekliği/harf aralığı, 4px tabanlı boşluk ölçeği
   (48/64/96 dahil) ve akışkan bölüm boşluğu, beş kapsayıcı genişliği ve
   duyarlı gutter, köşe (`sm/md/lg/pill`), kenarlık, gölge (`xs/sm/md`),
   odak halkası, hareket ve z-index katmanları.
2. **"Köşe 0, gölge yok" kuralı ve 0025'in bileşen bileşen istisna listesi
   kaldırılır;** yerine her yarıçap ve gölgenin hangi yüzey türünde
   kullanılacağını söyleyen tek bir kutu modeli gelir.
3. **Düzen ilkeleri** `packages/ui`'ye eklenir: `Container`, `Stack`,
   `Cluster`, `Section`, `VisuallyHidden`, `SkipLink`. Sayfalar satır içi
   `style` ile genişlik/boşluk uydurmaz.
4. **Geçiş kademelidir.** Faz 1A yalnızca belgeyi, belirteçleri ve ilkeleri
   ekler. Mevcut bileşenler kendi yeniden tasarım fazında yeni modele taşınır;
   o güne kadar görünümleri değişmez. Toplu görsel geçiş yapılmaz.

## Gerekçe

Faz 0 denetimi mevcut uygulamanın ürün kalitesinde bir vitrin için yetersiz
olduğunu gösterdi:

- **İki görsel dil.** Ana sayfa karar 0025 istisnalarıyla yuvarlak ve
  kart ağırlıklı; arama, ürün ve hesap sayfaları köşesiz. İstisna listesi her
  fazda bir bileşen daha büyüdü (Faz 2–4) — kural fiilen işlemiyordu.
- **Eksik belirteçler.** z-index, hareket, odak, ağırlık, 360/720/960
  genişlikleri ve hap yarıçapı yoktu; sayfalarda 64 satır içi `gap`, 19
  `fontSize` ve ölçek dışı değerler (20px, 12px), bileşenlerde gömülü `999px`
  vardı.
- **Erişilebilirlik açıkları.** `--ink-muted` / `--surface` 4.43:1 (AA altı),
  `--line` kontrol sınırlarında ~1.3:1 (3:1 altı), `SearchComposer`'da koyu
  temada görünmeyen gömülü odak halkası, tema zorlanınca sabitlenmeyen
  `color-scheme`, atla bağlantısı yok.
- **Editoryal ölçek yok.** En büyük başlık 32px'ti; gelecek ana sayfa
  tasarımının istediği büyük editoryal başlık ve bölüm boşlukları (96px)
  ifade edilemiyordu.

Tek bir belirteç sistemi sonraki fazların (üst çubuk, ana sayfa, arama,
kartlar, ürün sayfası) aynı dili konuşmasını sağlar ve istisna birikimini
durdurur.

**Referans.** Dupe.com yalnızca ürün/UX referansıdır: arama öncelikli akış,
bol boşluk, güçlü tipografi hiyerarşisi, nötr siyah/beyaz temel, sade
yuvarlak yüzeyler, büyük dokunma hedefleri. Onun logosu, metinleri,
görselleri, illüstrasyonları, sayfa geometrisi ve bileşen stilleri
kopyalanmaz. Arilla kendi adını, IBM Plex Sans'ı (karar 0009), renk
belirteçlerini ve bileşenlerini korur. "dupe" kelimesi arayüzde geçmez
(CLAUDE.md).

**Canlı katalog olmadan çalışmalı.** Admitad başvurusu öncesinde güvenilir
gerçek ürün/görsel verisi yok. Tasarım sistemi ve bileşenler gerçek veriye
bağlı olmadan tasarlanır, gerçek veri geldiğinde yeniden tasarım
gerektirmeden onu gösterebilmelidir.

**Demo içerik geçicidir ve yalıtılır.** Gerekirse kullanılan demo içerik
`apps/web/data/demo/` altında kalır, üretim veri yoluna (`packages/core`,
veritabanı) karışmaz, açık bir bayrakla (`HOMEPAGE_DEMO_CONTENT`) açılır ve
gerçek içerik gibi etiketlenmez. Üçüncü taraf marka/ürün görsellerini
doğrudan bağlamak (hotlink) kalıcı üretim çözümü değildir. Sahte mağaza
ortaklığı veya affiliate iddiası yazılmaz.

**Erişilebilirlik ve duyarlılık zorunludur.** Metin rolleri üç zeminde
≥ 4.5:1, kontrol sınırları ≥ 3:1, tek odak sistemi, 44px dokunma hedefi,
`prefers-reduced-motion` altında süreler 0. Düzen önce mobil yazılır;
320–390px telefon, tablet, laptop ve geniş masaüstünde doğrulanır; cihaza
özgü sorgu yazılmaz, yalnızca 640/1024/1440 referans noktaları kullanılır.

**Faz 0 kısıtları korunur.** Tema modeli (sunucu tarafı çerez →
`<html data-theme>`, localStorage yok, FOUC yok), depodan servis edilen font,
Server Component varsayılanı, iş mantığının `packages/core`'da kalması,
`/ara` GET formu, `[...link]` ve `/git/[offerId]` akışları, sponsorlu/seçilmiş
içerik etiketleri, altbilgideki affiliate/fiyat bildirimi, kuruş tamsayı
fiyat ve metin kuralları (ALL CAPS yok; "Satın al", "dupe", "ucuz" yok).

## Reddedilen alternatif

1. **0025'in istisna listesini büyütmeye devam etmek.** Reddedildi: her yeni
   yüzey için bir ek daha yazmak iki görsel dili kalıcılaştırır; kural
   istisnasından küçük hale gelmişti.
2. **Tüm bileşenleri tek adımda yeni modele taşımak.** Reddedildi: arama,
   ürün, hesap ve yönetim ekranlarının hepsini birden değiştirir, regresyonu
   görünmez kılar ve "görev tek klasörle sınırlı" kuralını çiğner.
3. **Hazır bir UI kütüphanesi veya Tailwind eklemek.** Reddedildi: mevcut
   CSS Modules + belirteç mimarisi yeterli; yeni bağımlılık ve ikinci bir
   stil sistemi getirir.
4. **Fontu değiştirmek.** Reddedildi (bu faz için): Plex'in değişken dosyası
   600 ağırlığı zaten taşıyor; Türkçe karakter testi geçilmiş (0009).
   Değişiklik için somut bir kanıt yok.

## Sonucu

- `docs/design.md`: marka karakteri, renk rolleri ve kontrast tablosu, tip
  rolleri, boşluk, kapsayıcı/gutter, kutu modeli (köşe, kenarlık, gölge,
  odak), duyarlı model ve kırılma noktaları, z-index, hareket, düzen
  ilkeleri bölümleri yazıldı.
- `packages/ui/src/tokens.css`: belirteçler eklendi; mevcut adlar korundu.
  `--ink-muted` açık temada `#676B72`'ye koyulaştırıldı (4.90:1 / `--surface`).
  Tema zorlandığında `color-scheme` sabitlenir.
- `packages/ui`: altı düzen ilkesi eklendi ve `index.ts`'ten dışa aktarıldı.
- `docs/copy.md`: `nav.skip_to_content` = "İçeriğe geç".
- Mevcut bileşenlerin görünümü değişmedi; yalnızca `--ink-muted`'ı kullanan
  metinler açık temada biraz koyulaştı ve zorlanmış temada yerel kontroller
  doğru temada çiziliyor.
- Faz 1B ve sonrası: üst çubuk + mobil gezinme, altbilgi, 404/hata
  sayfaları, `LoginModal` odak tuzağı ve `--z-modal`, `SearchComposer` odak
  halkası, bileşenlerin yeni kutu modeline taşınması.
