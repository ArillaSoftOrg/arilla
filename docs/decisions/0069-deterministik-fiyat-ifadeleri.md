# 0069 — Deterministik fiyat ifadeleri ve `filters.currency`

**Tarih:** 2026-10-07 · **Durum:** kabul edildi (kod ve testler hazır; `/ara` akışında gerçek PostgreSQL'de doğrulandı). Üretime birleştirilmedi.

## Bağlam

"20 bin altı telefon", "20k altı", "15 bin ile 25 bin arası laptop", "en fazla 30k",
"5000 TL'den ucuz", "10 bin üstü" gibi sorgular model çağrısı gerektirmez (kural 1,
`docs/search.md` Kademe 2). Mevcut ayrıştırıcı yalnız rakamlı kalıpları
("3000 tl altı", "2000-3000 arası") biliyordu; "bin"/"k"/"milyon" kısaltmaları
bilinmediğinden bu sorgularda sayı fiyat filtresi olmuyor, metin kapısına sızıyordu.

## Karar

1. `search/price-patterns.ts` Türkçe kısaltmaları okur: çarpan (`bin`, `k`, `milyon`),
   para birimi (`tl`, `₺`, `try`, `lira`), işleç (`altı/altında/kadar`, `üstü/üzeri`,
   `ucuz/pahalı/az/fazla`, `arası`, `en fazla/en az`). Çıktı mevcut sözleşmeye gider:
   `QueryFilters.price_min/price_max` (kuruş, tamsayı) ve **`QueryFilters.currency = "TRY"`**
   (isteğe bağlı; yoksa TRY varsayılır — eski `query_resolution` satırları).
   `clarification/compile.ts` aynı alanı yazar.
2. **Model numarası/özellik fiyat değildir.** Bir sayı ancak bir fiyat işaretiyle
   (`tl`/`bin`/`k`/`milyon`) ya da bir fiyat işleciyle birlikte okunur. Kurallar ve
   NEDENLERİ `price-patterns.test.ts` ("why the bare-number rules are what they are")
   içinde satır satır sabitlenmiştir:
   * harfe/rakama bitişik sayı okunmaz (`s24`, `a15`, `rtx4060`, `iphone17`);
   * **işaretsiz sayı** (tl/bin/k yok) yalnızca **para biçimindeyse** okunur: binlik
     noktalı (`2.999`) ya da 50'nin katı (`250`, `3000`), ve tabanın üstündeyse
     (işleçten sonra ≥ 100, önce ≥ 1.000). İkili depolama boyutları (`128`, `256`,
     `512`, `1024`) 50'nin katı değildir; `128 altı` fiyat olmaz. "Sırf büyük sayı
     diye" fiyat kabul edilmez: `laptop 35000` filtre üretmez, `laptop 35000 altı` üretir;
   * işaretsiz sayıdan sonra ölçü birimi gelirse okunmaz (`en az 256 gb`, `5000 mah`);
   * `max`/`min`/`maks` işleç **değildir** (`iphone 17 pro max 60 bin altı`'da `max` modeldir;
     gerçek veri akışı testi bu hatayı yakaladı);
   * işleci olmayan sayı hiçbir zaman fiyat değildir (`iphone 17 pro 256`, `20 bin`).
3. Emin olunamayan sayı filtre olmaz ve `unparsed`'a kalır: yanlış filtre, filtresizlikten kötüdür.
   Bilinçli sonuç: işaretsiz ve yuvarlak olmayan `2999 altı` fiyat sayılmaz (`2999 tl altı` sayılır).
4. **Önbellek:** `query_resolution` bir `query_norm`'u kalıcı önbelleğe alır
   (`resolveQuery`); parser değişince daha önce kaydedilmiş sorgular eski ayrıştırmayı
   döndürmeye devam eder (entegrasyon testi bunu gösterir). Yerleşik yöntem tabloyu
   temizlemektir (`admin/lexicon.ts` her sözlük değişikliğinde yapar). Yayında
   `docs/ops.md` "Sorgu ayrıştırma önbelleği" adımı uygulanır; kod bunu otomatik yapmaz.

## Reddedilen alternatifler

* **Büyük sayıyı fiyat saymak** ("35000" tek başına): model/depolama numaralarıyla karışır.
* **Modele sormak:** kural 1; bu kalıplar deterministik çözülür.
* **Önbelleğe ayrıştırıcı sürümü eklemek:** yeni bir mekanizma; mevcut "tabloyu temizle"
  sözleşmesi yeterli ve admin sözlük akışıyla aynı.
* **`currency`'yi zorunlu yapmak:** eski önbellek satırlarını geçersiz kılar; yoksa TRY varsayılır.

## Doğrulama

`price-patterns.test.ts` (kural tablosu), `parse-query.test.ts`, ve
`search/price-search.integration.test.ts`: `resolveQuery → searchWithFallback →
PostgreSQL` (yalıtılmış yerel DB), fixture kataloğunda bütün örnek sorgular için
sonuç kümesi, model numarası korunumu ve önbellek gidiş-dönüşü.
