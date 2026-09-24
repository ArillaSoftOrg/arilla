# 0029 — Metin arama kapısı, eşanlam sözlüğü, para birimi kanıtı ve eşleştirme güvenliği

**Tarih:** 2026-09
**Durum:** kabul edildi

Gerçek bootstrap kataloğu (0027) üzerinde görülen sorunlar ve kararlar.

## 1. Metin araması: aday kapısı

**Sorun.** `search()` metni yalnızca sıralamada kullanıyordu
(`similarity(p.title, sorgu)`); WHERE'de alaka koşulu yoktu. Aktif teklifi
olan her ürün 24'lük listeye giriyor, "yoga matı" 24 alakasız sonuç
döndürüyordu. Tüm-başlık benzerliği kısa başlıkları ödüllendiriyordu
("halı" → "Çift Halkalı Kemer").

**Karar.** Token düzeyinde kapı (`packages/core/src/search/text-match.ts`):

- Sorgu ve ürün metni aynı katlanır: Türkçe küçük harf + ASCII. "hali" = "halı".
- Ürün metni: başlık + marka + renk + ANA kategori adı. Alt kategori yok,
  çünkü bootstrap ipuçları kaba.
- Her slot için `strict_word_similarity` ≥ 0.5 (kelime sınırlı; alt dize tuzağı yok).
- Baş isim (son slot) her zaman eşleşmeli. 1–2 slotlu sorguda tüm slotlar,
  3+ slotluda en fazla bir niteleyici eksik olabilir.
- Aynı görseli taşıyan sonuçlar tek sonuca iner. Ürün modeli değişmez, yalnızca
  liste çeşitlenir (Normod: 16 kumaş rengi tek fotoğraf).

**Performans.** Kapı her ürün için hesaplanırsa 4 bin üründe 200–650 ms.
`0019` katlanmış başlık üzerinde trigram GIN indeksi ekledi. Baş isim `<<%`
(varsayılan eşik 0.5) ile indeksten aday çeker (başlık ∪ marka ∪ ana kategori,
UNION). `OFFSET 0` sınırı pahalı hesabı yalnızca adaylarda çalıştırır. Ölçüm:
metinli sorgu 20–45 ms, metinsiz ~40 ms.

**Esik tek sihirli sayı değil.** `packages/core/src/search/eval/` altında 38
sorguluk değerlendirme seti var. Yargı algoritmadan bağımsız: başlık+renk
desenleri. Eşik ve kurallar bu setle ölçüldü, entegrasyon testi gerilemeyi
yakalar.

## 2. Eşanlam: `lexicon.kind = 'synonym'`

Başlıklar karışık dilde ("Wireless Mouse", "Sneaker", "Cardholder"). Kapı
doğru olarak eşleşme bulmuyordu. docs/search.md eşanlamların sözlükte, veritabanında
durmasını istiyor. Mevcut türler uygun değildi: `category` satırı filtreye
döner, kategori ipuçları kaba. `0020` yeni bir tür ekledi. `synonym` filtre
üretmez; aynı `normalized` değerini paylaşan yüzeyler metin kapısında
alternatif olur. Başlangıç seti gerçek katalog boşluklarından seçildi.
`/yonetim/sozluk` üzerinden genişletilir.

**Sınır.** Yeni satırlar `query_resolution` önbelleğindeki eski ayrıştırmalara
uygulanmaz. Sözlük yönetimi önbelleği zaten temizliyor.

## 3. Para birimi: kanıt yoksa kayıt yok

`normalize` para birimi alanı yoksa sessizce `"TRY"` yazıyordu. Artık:
kaynağın kendi alanı, yoksa `feed_config.currency`. İkincisi yalnızca
`currency_verified = true` ise geçerlidir. İkisi de yoksa kayıt reddedilir.

Kanıt `services/ingest/bootstrap/currency_provenance.json` dosyasında. Her
mağaza için public `/meta.json` (taban para birimi), `Shopify.currency.active`
(oran 1.0) ve JSON-LD `priceCurrency` birbirini doğruladı; fiyatlar kuruş
düzeyinde çapraz kontrol edildi. `/cart.js` robots.txt ile yasak, kullanılmadı.
Shopify Markets kullanan iki mağaza "medium". Şema değişmedi: `feed_config`
içinde `currency`, `currency_verified`, `currency_evidence`.

## 4. Eşleştirme güvenliği

Hedefli bir çakışma corpus'u (`tests/fixtures/matching/overlap_pairs.json`,
32 doğrulanmış aynı-ürün çifti, 16 zor negatif) iki hata gösterdi:

- **Tek taraflı renk.** Stanley offer'ı açık renk taşıyor ("Spring Green"),
  karşı ürünün rengi yalnızca başlığında ("… Ash") ve sözlükte yok. Veto
  çalışmadı, farklı renkler 0.91 skorla **otomatik birleşti**. Kural: renk
  yalnızca bir tarafta biliniyor ve diğer tarafın başlığında yoksa
  `ScoreResult.review` dolu. Eşik ne olursa olsun otomatik kabul yok, insan
  kuyruğu.
- **Renk ifadesi karşılaştırması.** "Spring Green" açık alanı ile başlıktaki
  "Spring Green" (sözlükte "yesil") farklı sayılıp vetolanıyordu. Renkler
  kelime kümesi olarak karşılaştırılıyor. "Hammertone Green" ile
  "Spring Green" ayrı kalır.
- **Mağaza adı marka değildir.** Sasha Kozmetik'te `vendor` her üründe mağaza
  adı. Marka vetosu tüm doğru adayları kesiyordu. Bootstrap manifestinde
  `map_brand: false`.

## Reddedilen alternatifler

- **Ayrı arama motoru / vektör araması.** CLAUDE.md: pgvector ve pg_trgm
  yeterli; kapı mevcut sorguya eklendi.
- **Tek eşik, token kuralı olmadan.** "telefon kılıfı" minder kılıfını
  bulur; baş isim kuralı olmadan yok-sorgusu 0 sonuç veremez.
- **Kodda sabit eşanlam tablosu.** docs/search.md sözlüğü veritabanına
  koyuyor. Sürüm çıkmadan genişletilebilmeli.
- **Para birimini fiyat büyüklüğünden çıkarmak.** Kanıt değil.
- **Aynı görselli varyantları tek ürüne birleştirmek.** 0005'i bozar;
  çeşitlilik sonuç düzeyinde sağlandı.
