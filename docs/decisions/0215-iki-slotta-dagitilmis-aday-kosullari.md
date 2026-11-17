# 0215 — Exact aday adımı: iki slotta dağıtılmış GIN koşulları

Tarih: 17 Kasım 2026. Bağlı: 0129 (aday kümesi), 0131 (marka/kategori), 0206 (adım bütçesi), 0214.

## Sorun
Üretimde exact adımı 5 sn'de iptal oluyordu: "kablosuz kulaklık", "dikey süpürge hafif", "kadın omuz çantası"
(fallback'e hiç geçilmiyordu). Üretimden salt okunur `EXPLAIN` (kablosuz kulaklık, 2 slot: kablosuz|wireless ve
kulaklık ailesi) planı: `(a VEYA b) VE (c VEYA d…)` biçimli sıkı dal, yalnız İLK slotun trigram kosullarını indeksten
alıyor; ikinci slot satır başına regex filtresi. Planlayıcı regex seçiciliğini ~1 satır tahmin ediyor (gerçekte
binlerce–yüz binlerce): "wireless" başlıklı satırların hepsi okunup yalnız küçük bir kısmı ikinci slotu geçiyor.
Yerel ölçekli kopyada (3,95 M yurt dışı satır) bu dal 12 600 satırı okuyup 450 tutuyor (~800 ms; üretimde ≥ 10 kat
satır sayısı).

## Karar
2 slotlu sorguda sıkı dal koşulu dağıtılır: her alternatif birleşimi ayrı bir dal ve BÜTÜN slotları tek GIN
taramasının indeks koşulu (`crossAnd`). Sonuç kümesi aynı (yerelde `EXCEPT` ile 0 fark); aday penceresi (LIMIT)
birleşimlere bölünür (dal başına en az 100). Birleşim sayısı 24'ü aşarsa en geniş slot tek VEYA'li koşula katlanır.
3+ slotta ve tek slotta eski biçim: dağıtma 3 slotta ÖLÇÜLDÜ ve yarar sağlamadı (planlayıcı dağıtılmış koşulları
kendi biçimine çevirip en seçici slotu filtreye bıraktı: "kadın omuz çantası" yerelde 3,0 → 4,9 sn), o yüzden yok.

## Ölçüm
Yerel ölçekli kopya (3,95 M yabancı satır), sıcak, aynı SQL:
- kablosuz kulaklık: 1,83 → 0,47 sn; erkek spor ayakkabı: 19,1 → 9,8 sn; bebek bezi, kadın omuz çantası: değişmedi.
Yerel gerçek arama (160 bin): ilk 24 aynı; erkek spor ayakkabı 1,8 → 1,15 sn, laptop çantası 0,51 → 0,38 sn.
Üretim, salt okunur sonda (5 sn sınırı, 2 tur):
- kablosuz kulaklık: zaman aşımı/zaman aşımı → 4,8 / 4,0 sn (artık tamamlanıyor, sınırın hemen altında);
  bluetooth hoparlör 1,4/0,7 → 0,6/0,3; silikon spatula 1,5/0,3 → 0,25/0,28; bebek bezi 0,7/0,2 → 0,2/0,2.
- İlk 24 aynı: hoparlör, saat, bebek bezi, spatula, klavye; "telefon kılıfı" (24'ün 17'si) ve "laptop çantası"
  (24'ün 1'i) farklı: LIMIT penceresi örnekleyici olduğu için; sonraki sıralama kümesi değişir (laptop çantasında
  önceki ilk 5'te tornavida seti vardı, yeni ilk 5'in hepsi çanta).

## Sınırlar (çözülmeyenler)
- Üretimde HÂLÂ zaman aşımı: dikey süpürge hafif (3 slot), kadın omuz çantası (3 slot), erkek spor ayakkabı ve çelik
  tencere seti (2 slot ama çok yaygın bas isim). Yaygın baş isimlerde (≥ yüz binlerce eşleşme) sorun artık planlayıcı
  tahmini değil, aday penceresinin dolması için okunan satır sayısı; 3 slot için ayrı bir yaklaşım gerekir.
- "totalCapped"/toplam sayı alt sınırı dal bölünmesi yüzünden daha küçük çıkabilir (ör. 1004 → 512); gösterilen ilk
  sayfa etkilenmez.
- Sıralama, eşikler, SQL anlamı ve embedding değişmedi.
