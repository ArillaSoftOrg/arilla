# 0119 — Otomatik birleştirme yalnız kesin kimlikle

**Tarih:** 15 Ekim 2026
**Durum:** Önerildi. 0034'ün metin/hibrit otomatik kabul kademesini kaldırır; 0111'in
"doğrulanmamış ürün otomatik birleştirilmez" ilkesini puanlı çözümleyiciye uygular.

## Bağlam

0111 kimlik düzeylerini tanımladı (GTIN → kanonik varyant, marka + MPN → ürün), ama
puanlı çözümleyici (`resolve/score.py`) hâlâ 0034 kurallarıyla çalışıyordu:

- Metin/hibrit skor eşiği geçip marka iki tarafta aynıysa otomatik bağlıyordu. Marka
  çoğu zaman başlıktan çıkarılıyor (`infer_brand`), yani bu fiilen "benzer ada bakarak"
  birleştirmedir.
- MPN eşleşmesi marka kontrolü olmadan kesin sayılıyordu. Farklı markaların aynı MPN'i
  başka üründür.
- Kısıtlı dolaşım GTIN'leri (mağaza içi 20–29, kupon, ISBN/ISSN) kimlik sayılıyordu.

## Karar

1. `auto_eligible` yalnız `gtin` ve `mpn` yöntemlerinde doğrudur. Metin ve hibrit
   adaylar, skor ne olursa olsun, inceleme kuyruğuna (`pending`) gider.
2. GTIN eşleşmesi yalnız `classify_gtin(...).status == "valid"` ise kesindir.
3. MPN eşleşmesi yalnız marka iki tarafta bilinip aynıysa kesindir.
4. Renk, beden, kapasite ve model kademesi vetoları değişmedi; kesin kimlikte de
   uygulanır.

## Etki (çevrimdışı regresyon seti)

- Kuyruk kesinliği, kuyruk duyarlılığı ve yanlış eşleşme oranı değişmedi (1,0 / 1,0 / 0).
- Otomatik kabul kesinliği 1,0 kaldı. Otomatik kabul duyarlılığı 0,92'den 0,05'e düştü:
  bu çiftler artık otomatik değil, inceleme kuyruğundan bağlanıyor.
- Temel çizgi bilinçli olarak yenilendi (`docs/eval.md`).
- Production'da `product` tablosu boş; mevcut bağlara etkisi yok. AliExpress teklifleri
  TRY dışı olduğu için zaten çözümleyiciye girmiyor (0112, 0114).

## Reddedilen alternatifler

| Alternatif | Neden reddedildi |
|---|---|
| Metin kademesini daha yüksek eşikle korumak | Eşik ne olursa olsun başlık kimlik değildir; "Pro", renk ve kapasite farkları başlıkta sık sık eksik |
| Yalnız besleme markası (başlıktan çıkarılmamış) ile metin kabulü | Mağaza marka alanı da güvenilmez (bayi adı, "Generic"); kimlik yine yok |
