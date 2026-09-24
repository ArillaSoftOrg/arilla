# 0025 — Ana sayfa kabuğu için sınırlı köşe yarıçapı ve geçici vurgu rengi

**Tarih:** 2026-09 · **Durum:** kabul edildi · kutu modeli istisnası karar
0026 ile yerini aldı (`--accent` kararı geçerli)

## Karar

`docs/design.md`'nin "köşe yarıçapı: 0, box-shadow hiçbir yerde kullanılmaz"
kuralı proje genelinde değiştirilmez. Bunun yerine iki yeni, dar kapsamlı
belirteç eklenir: `--radius-md` (12px) ve `--shadow-sm` (hafif, iki temaya
göre ayrı tanımlı). Bu belirteçler yalnızca ana sayfa "kabuk" bileşenlerinde
(`HomeHeader`, arama kutusu `SearchComposer`, devam chip'leri
`ContinueShoppingChips`, `Button`'ın yeni `accent` varyantı) kullanılır.
`Button`'ın `primary`/`secondary` varyantları, `Card`, `Badge`, `ProductCard`,
yönetim ekranları vb. mevcut her bileşen köşesiz ve gölgesiz kalmaya devam
eder — `--radius: 0` değişmez, hiçbir mevcut yüzeye geriye dönük müdahale
edilmez.

Aynı şekilde `tokens.css`'e `--accent` / `--accent-foreground` eklenir: açık
temada `--ink`'in aynı değeri ters rolde (koyu zemin, beyaz metin), koyu
temada tersi — yani "o temanın ink rengi, ters roldeki" nötr bir CTA rengi.
`--save` (yeşil) hiçbir yerde değişmez; tasarruf tutarı ve mevcut birincil
eylemler (`Button variant="primary"`) `--save` kullanmaya devam eder.
`--accent` yalnızca yeni ana sayfa arama kutusunun gönder eylemi gibi, henüz
`--save`'in anlamına (tasarruf/onay) karşılık gelmeyen yeni "birincil eylem"
yüzeylerinde kullanılır.

## Gerekçe

Dupe.com'dan esinlenen premium bir arama kutusu görsel olarak yumuşak köşe ve
hafif derinlik ister; ama bunu proje genelinde açmak `packages/ui`'deki 15+
bileşeni ve tüm sayfaları etkileyecek, regresyon riski ve kapsam dışı bir
görsel değişim doğurur. Marka rengi henüz netleşmediği için CTA'yı `--save`'e
(anlamı zaten "tasarruf/onay" olan bir renk) bağlamak semantik karışıklık
yaratır — arama kutusundaki "gönder" eylemi bir tasarruf eylemi değildir.

## Reddedilen alternatif

1. `--radius: 0`'ı proje genelinde değiştirmek: reddedildi, D2/D3/D5
   kapsamındaki tüm ekranları riske atar.
2. Gönder butonunu `variant="primary"` (yani `--save`) yapmak: reddedildi,
   `docs/design.md`: "`--save` sadece tasarruf tutarında ve birincil eylemde
   kullanılır" cümlesindeki "birincil eylem" bugüne dek hep `--save`'e
   eşlenmiş; ama bu renk aynı zamanda kullanıcıya "tasarruf" anlamı taşıyor.
   Yeni, anlamca nötr bir eylem yüzeyi için ayrı bir belirteç açmak daha
   temiz.

## Sonucu

`packages/ui/src/tokens.css`'e `--radius-md`, `--shadow-sm`, `--accent`,
`--accent-foreground` eklenir. `Button.tsx`'e üçüncü, opsiyonel bir
`variant="accent"` eklenir; `primary`/`secondary` davranışı bit bit aynı
kalır. `docs/design.md`'nin "Kart ve buton kutu modeli" bölümüne bu istisnayı
açıklayan bir alt paragraf eklenir. Marka rengi netleştiğinde `--accent`'in
değeri güncellenir, yapısı değişmez.

## Ek — Faz 2 genişletmesi (2026-09)

İstisna listesine editorial trend kartı `TrendCollectionCard` eklenir, ama
yalnızca `--radius-md` için — kart görsel olarak "ince border, fazla ağır
shadow yok" hedefiyle tasarlandığından `--shadow-sm` kullanmaz, sadece 1px
`--line` border ve `--surface-raised` zemin kullanır. Diğer her şey (Card,
Badge, ProductCard, yönetim ekranları) hâlâ dahil değildir ve değişmez.

## Ek — Faz 3 genişletmesi (2026-09)

İstisna listesine keşif ızgarası kartı `DiscoveryCard` eklenir, yalnızca
`--radius-md` için. `DiscoveryCard` `TrendCollectionCard`'dan bile daha
minimal — border veya shadow YOK, sadece görselin köşesinde hafif
yuvarlaklık. Gerekçe: keşif bölümü "image-first" olmalı ve sayfanın beyaz
zeminiyle kaynaşmalı (görev talimatı); herhangi bir çerçeve/gölge bu hedefle
çelişir.

## Ek — Faz 4 genişletmesi (2026-09)

İstisna listesine "Nasıl Çalışır" kartı `HowItWorksCard` ve onu saran panel
eklenir, yalnızca `--radius-md` için — `--shadow-sm` kullanılmaz, `--surface`
zemin ve ince `1px --line` border yeterli görsel ayrımı sağlar. Diğer her şey
(Card, Badge, ProductCard, yönetim ekranları) hâlâ dahil değildir.
