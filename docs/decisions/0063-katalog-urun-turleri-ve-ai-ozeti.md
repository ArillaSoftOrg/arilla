# 0063 — Katalog ürün türleri, Türkçe fiyat dili ve yapay zekâ arama özeti

**Tarih:** 7 Ekim 2026
**Durum:** Kabul edildi; anlık yol hâlâ `GEMINI_REALTIME_ENABLED` arkasında (0062).

## Bağlam

Anlık yorum (0062) yalnızca altı kural sözlüğü domain'ini seçebiliyordu.
Katalog denetimi:

- Kategori ağacı yalnızca migration'la değişir; toplama işi kategori açmaz
  (`resolve_category`). Üretim ağacı 0016'daki üst kategorilerdir
  (elektronik, ev-yasam, anne-bebek, kitap-muzik-hobi, spor-outdoor, oto-bahce,
  petshop, supermarket, saglik-kozmetik/kozmetik). **Laptop alt kategorisi yok.**
- Ürün tablosunda ağırlık, RAM, depolama, ekran, pil alanı yok; `attributes`
  yerelde yalnızca `renk` ve `kategori`. Arama süzgeçleri: kategori, renk,
  fiyat, beden, marka (dahil/hariç), stok, mağaza. Metin kapısı neredeyse katı
  (≥3 slotta 1 eksik).

## Karar

1. **Katalog ürün türleri** (`packages/core/src/clarification/product-types.ts`):
   tek dizi; her kayıt = mevcut kategori yolu + başlıktaki baş isim ve eş
   anlamlıları (+ başlıkta gerçekten geçen niteleyici). İlk set: laptop, tablet,
   monitör, oyun konsolu (elektronik), parfüm (saglik-kozmetik/kozmetik), bebek
   arabası (anne-bebek), kamp çadırı (spor-outdoor), kitap (kitap-muzik-hobi),
   elektrikli süpürge (ev-yasam). Yeni tür = tek kayıt.
2. **Yalnızca model seçer** (`modelOnly`): deterministik tetikleyici yok, soru
   yok. Kural sözlüğü ve bugünkü deterministik arama değişmez; altı domain aynı.
   Model yalnızca kayıttaki kimliği seçebilir (doğrulayıcı).
3. **Arama etkisi:** tür → `category_path` süzgeci + baş isim tek alternatif
   slotu (`laptop | notebook | dizustu`, `retrievalAlternatives`). Model-yalnız
   türlerde serbest kalan kelimeler metin kapısına girmez (yorumlandı ya da
   karşılığı yok). Niteleyici yalnızca başlıkta geçiyorsa (laptop "gaming").
4. **Türkçe fiyat:** deterministik ayrıştırıcıya "5-10 bin arası" (iki uca
   "bin") ve "yaklaşık/takriben/ortalama N" eklendi; önceki "5-10 bin" hatası
   (5 TL) düzeldi. Konvansiyonel arama aynı ayrıştırıcıyı kullanır. Çıplak
   "10 bin" deterministik bütçe sayılmaz (mevcut kural); modelin 10000'i ise
   metne dayandığı için kabul edilir (`priceAmountsInText`).
5. **Yapay zekâ özeti, ikinci çağrı YOK:** doğrulanmış yorum (tür etiketi,
   bütçe, uygulanan nitelikler) + gerçek sonuç SAYISI + katalogda karşılığı
   olmayan niyetler ("hafif", RAM, ekran, pil) → en fazla iki cümle. Ürün adı,
   fiyat, mağaza girdi değildir. Model yorumu yoksa özet yok.
6. **Kişi başına limit:** saatte 30 anlık model çağrısı (hesap ya da IP özeti,
   Redis sabit pencere). Önbellek isabeti sayılmaz; Redis yoksa model
   çağrılmaz, arama sürer. 2.000/gün genel tavan aynen kalır.

## Desteklenen / desteksiz niyet

| Niyet | Durum |
| --- | --- |
| Ürün türü | Kategori süzgeci + başlık baş ismi |
| Bütçe (rakam, "10 bin", aralık) | `price_min` / `price_max` |
| Renk, marka, beden | Deterministik sözlük süzgeçleri (değişmedi) |
| Oyun (laptop) | Başlıkta "gaming" (yalnızca başlıkta geçiyorsa bulur) |
| Hafiflik, RAM/depolama, ekran boyutu, pil ömrü | **Desteklenmiyor**: veri yok; süzgeç üretilmez, özet söyler |

## Bilinen sınırlar

- Baş isim başlık kelimesine bağlı; "Dizüstü Bilgisayar" gibi başlıklar
  alternatiflerle yakalanır, farklı adlandırmalar sözlüğe eklenmelidir.
- Taksonomi özeti değiştiği için mevcut saklanan yorumlar yeni kimlikle
  eşleşmez; ilk aramada (anlık) ya da cron'da yeniden yorumlanır.
- Önceden var olan bulgu: hediye domain'inin "moda" katkısı üretim ağacında
  yok (`moda` yalnızca yerel tohumda).
- Kategori süzgeci üst kategori düzeyinde (elektronik); başlık kapısı türü
  daraltır.
