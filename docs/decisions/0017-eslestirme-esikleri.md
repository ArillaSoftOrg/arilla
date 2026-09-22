# 0017 — Eşleştirme eşikleri, veto kuralları ve eşleşmeyen teklif politikası

**Tarih:** 2026-09 · **Durum:** kabul edildi

`docs/architecture.md` §3 uzun süredir şunu iddia ediyordu:

> **Eşik değerleri `docs/decisions/` altında kayıtlıdır.**

Kayıtlı değillerdi. Değerler yalnızca `.env.example`'da duruyordu ve nereden
geldikleri belirsizdi. Bu dosya o boşluğu kapatır — ve eşikleri tahminle
değil ölçümle koyar.

## Karar

### Eşikler

```
MATCH_AUTO_ACCEPT_THRESHOLD = 0.84
MATCH_QUEUE_THRESHOLD       = 0.63
```

Bu değerler **regresyon setinden ölçüldü**, seçilmedi.
`python -m resolve --calibrate` ölçümü yeniden üretir:

| | min | medyan | max |
| --- | --- | --- | --- |
| 32 eşleşme | 0.680 | 1.000 | 1.000 |
| 38 eşleşmeme | 0.000 | 0.111 | **0.580** |

Aradaki boşluk **+0.100**.

Set 30+30 olarak başladı; kademe/sürüm tuzak sınıfı sonradan yedi vakayla
genişletildi (bkz. aşağıda) ve eşikler yeniden ölçüldü. Bu, eşiklerin
sabit sayı değil **ölçüm çıktısı** olduğunun pratikteki karşılığı.

İki eşik farklı soruları yanıtlar ve aynı aralıktan türetilemezler:

- **`QUEUE` = 0.63** — "insana göstermeye değer mi?" Boşluğun ortası: hiçbir
  gerçek eşleşme düşmez (min 0.680), hiçbir yanlış eşleşme girmez (max 0.580).
- **`AUTO_ACCEPT` = 0.84** — "insana hiç sormadan bağlayabilir miyiz?"
  Eşleşmelerin kendi aralığının ortası. En zayıf gerçek eşleşmeler (renk,
  hacim ya da sürüm yazımı yalnızca bir tarafta bilindiğinde) **bilerek insan
  onayına düşer**; yalnızca kesin olanlar otomatik bağlanır.

Önceki değerler (0.92 / 0.70) korunmadı çünkü hiçbir ölçüme dayanmıyorlardı.

### Katman sırası

`architecture.md` §3'teki sıra uygulandı; **ilk kesin sonuçta durulur**.

| # | Katman | `method` | Kesin mi |
| --- | --- | --- | --- |
| 1 | `gtin` / `mpn` tam eşleşme | `gtin` / `mpn` | Evet |
| 2 | Başlık token örtüşmesi + marka | `text` | Hayır |
| 3 | Görsel embedding kosinüsü | `image` | Hayır |
| 4 | 2 ve 3 birlikte | `hybrid` | Hayır |

### Vetolar — skoru düşürmez, sıfırlar

Beş uyuşmazlık eşleşmeyi **imkânsız** kılar:

1. **Renk** — `docs/schema.sql`: "product renk düzeyinde kanoniktir: siyah ve
   bej ayrı üründür."
2. **Hacim / ağırlık** — 50 ml ≠ 100 ml.
3. **Beden** — 40 numara ≠ 44 numara.
4. **Model kademesi ve sürüm** — "Koşu Ayakkabısı **Pro**" ≠ "Koşu Ayakkabısı";
   "Yün Kaban **V2**" ≠ "Yün Kaban". Kademe sabit bir kelime listesinden
   (`pro`, `plus`, `mini`, `lite`, `max`, …), sürüm ise örüntüden gelir
   (`V2`, `Gen 3`, `2. Nesil`) — sayı değişken olduğu için kelime listesiyle
   yakalanamaz.
5. **Marka** — marka kimliktir; "Ayda Poplin Gömlek Beyaz" ≠ "Vira Poplin
   Gömlek Beyaz", başlık birebir aynı olsa bile.

Kural: **yalnızca iki tarafta da bilinen bir özellik çatışırsa** veto edilir.
Bir tarafta eksik bilgi veto sebebi değildir — "bilmiyorum" ile "farklı" ayrı
şeylerdir. Tek istisna model kademesidir: bir tarafta "Pro" varken diğerinde
yoksa bu eksiklik değil **farktır**.

`gtin` aynı ama renk farklıysa eşleşme **kesin sayılmaz**: mağazalar
varyantları tek barkodla yayınlayabiliyor.

### Eşleşmeyen teklif → yeni ürün

Kuyruk eşiğinin altında kalan offer için **yeni `product` açılır** ve offer ona
bağlanır. Marka yoksa `brand` satırı da açılır.

**Kategori açılmaz**, yalnızca mevcut bir `category.path` ile eşleşirse
bağlanır. Kategori ağacı kurumsal bir karardır: `is_discoverable` keşfet
akışını yönetiyor ve elektronik gibi kategoriler bilerek dışarıda. Feed'in ham
metninden kategori üretmek o kararları delerdi.

## Gerekçe

**Neden token örtüşmesi, karakter benzerliği değil.** İlk sürüm `difflib` ile
karakter oranına bakıyordu. Regresyon seti onu ilk koşuda düşürdü: "Koşu
Ayakkabısı Pro Siyah" ile "Koşu Ayakkabısı Siyah" **1.000** skor alıyordu ve
iki grup örtüşüyordu (boşluk −0.206). Ürün başlıkları kısa; bir kelimenin
tamamen değişmesi anlamda büyük, karakterde küçük bir farktır. Token
kümesinde aynı fark doğru büyüklükte görünür.

Bu, regresyon setinin neden zorunlu olduğunun somut kanıtı: set olmasaydı
0.92 eşiğiyle "Pro" modelleri sessizce normal modellere bağlanırdı.

**Neden marka çatışması veto, ceza değil.** Ceza olarak denendi (−0.25) ve
yetmedi: başlıklar birebir aynı olduğunda 1.00 − 0.25 = 0.75, en zayıf gerçek
eşleşmenin (0.747) üstünde kalıyordu. Marka kimliktir; derece meselesi değil.

**Neden zayıf eşleşmeler otomatik kabul edilmiyor.** Renk yalnızca bir tarafta
biliniyorsa (0.747) eşleşme muhtemelen doğrudur ama kanıtlanmış değildir.
`architecture.md`: "Yanlış 'aynı ürün' iddiası kullanıcı güvenini bir kerede
yok eder; temkinli olmak pahalı değildir." Bu yüzden o aralık
`/yonetim/eslestirme` kuyruğuna düşer.

## Reddedilen alternatifler

- **`.env`'deki 0.92 / 0.70'i olduğu gibi kullanmak.** Hiçbir ölçüme
  dayanmıyorlardı; regresyon seti "bozuldu mu" sorusunu yanıtlar, "doğru mu"
  sorusunu değil.
- **Renk uyuşmazlığını ceza yapmak.** Başlıklar çok benzer olduğu için
  düşürülmüş skor bile eşiği geçiyordu.
- **Eşleşmeyen offer'ı boşta bırakmak.** Şema izin veriyor ama gerçek feed
  geldiğinde binlerce offer hiçbir ürüne bağlanmadan aramada görünmez olurdu.
- **Feed metninden kategori üretmek.** `is_discoverable` ve kategori dışı
  bırakma kararlarını delerdi.

## Sonucu

- `python -m resolve [--merchant-id N] [--dry-run] [--no-create] [--calibrate]`
- İnsan kararı (`accepted` / `rejected`) makine tarafından **ezilmez**;
  `match_candidate` upsert'i o iki durumu korur.
- Eşik değiştirilirse `python -m resolve --calibrate` yeniden çalıştırılır ve
  bu dosya güncellenir. Regresyon testi eşikleri ortamdan okur; eşik
  bozulursa 110 parametrik iddia düşer.


## Ek: tuzak sınıfının genişletilmesi

İlk sette bu sınıftan **tek bir vaka** vardı ("Koşu Ayakkabısı Pro"). Tek
örnek, bir sınıfı korumaz: kelime listesi `pro` içeriyordu ama `V2`,
`Gen 3` ve `2. Nesil` hiç tespit edilmiyordu — yani aynı hata farklı bir ek
biçimiyle sessizce geri gelebilirdi.

Sınıf yedi negatif vakayla genişletildi (`plus`, `mini`, `max`, `lite`,
`V2`, `2. Nesil`, ve iki tarafta farklı kademe) ve sürüm tespiti örüntüye
bağlandı.

Yanına **iki pozitif kontrol** eklendi: aynı kademe ya da aynı sürüm iki
tarafta da varsa eşleşme DEVAM ETMELİ. Veto fazla geniş olsaydı bu ikisi
düşerdi — "ayni surum iki tarafta" bugün setin en zayıf eşleşmesi (0.680) ve
eşiği belirleyen vaka o.

## Ek: kategori kapsamı genişletildi (bkz. 0023)

2026-09, bkz. `docs/decisions/0023`: MVP kategori kapsamı bilinçli olarak
genişletildi (Elektronik dahil). Yukarıdaki "elektronik gibi kategoriler
bilerek dışarıda" örneği artık geçerli değil. Bu bölümün asıl ilkesi
değişmedi: eşleşme eşiğinin altında kalan offer için kategori hâlâ otomatik
açılmaz, yalnızca mevcut bir `category.path` ile eşleşirse bağlanır.
