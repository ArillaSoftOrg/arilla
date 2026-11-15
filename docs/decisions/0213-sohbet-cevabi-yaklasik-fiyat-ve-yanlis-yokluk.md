# 0213 — Sohbet sonuç cevabı: yaklaşık fiyat kullanımı, yanlış yokluk koruması

**Tarih:** 15 Kasım 2026 · **Durum:** kabul edildi · **Bayrak:** `CHAT_RESULT_ANSWER` (kapalı, değişmedi)
· **Migration:** yok · **Bağlı:** karar 0203, 0205, 0211, 0212 (PR #363)

## Fiyat kararı (ürün sahibi, 15 Kasım 2026)

İlk sürümde AliExpress ürünlerinin yaklaşık ya da eski fiyatları kabul edilir; bir ay önce kaydedilmiş
fiyat bile tarihine uygun söylenirse kullanılabilir. Fiyat güncelliğini mükemmelleştirmek öncelik değildir.
Asıl hedef: doğru, kanıta dayalı, kullanıcı niyetine uygun cevap.

## Karar

1. **Cevap gerçekleri kartın fiyatını kullanır** (yeni altyapı yok; mevcut `current_price` zinciri:
   kart = sıralama anahtarı (0205) = cevap gerçeği). `toResultFacts` artık yurt dışı teklifin kurla
   çevrilmiş TL tutarını verir. Eskiden `null` veriyordu; sonuç: üretim kataloğunun neredeyse tamamında
   cevap fiyatsız kalacaktı.
   - `price_approx: true`: tutar kurla çevrilmiş yaklaşık TL'dir. Kesin TRY fiyatta alan hiç yoktur.
   - `price_date` (YYYY-MM-DD): yalnız kur bülteni tarihi biliniyorsa eklenir; bilinmiyorsa alan yoktur.
   - Kur yoksa `price_try = null`; ürün sonuçtan ÇIKMAZ, başlık ve mağazayla karşılaştırılır.
2. **Yaklaşık fiyat kesin gibi sunulamaz.** Doğrulayıcı, yaklaşık bir fiyatı alıntılayan paragrafın
   "yaklaşık / civarında / tahmini / kurla çevrilmiş" demesini zorunlu kılar (`approx_price_unlabelled`).
   Fiyat tarihi yalnız gerçeğin taşıdığı tarihtir; uydurma tarih sayı denetiminden geçemez.
3. **Kargo, vergi, gümrük, toplam maliyet, "ücretsiz"**: veri yoktur; olumlu cümlede yasak, "bilgi
   belirtilmemiş" cümlesinde serbest. Yedek (modelsiz) özet yaklaşık fiyat varsa bunu söyler.
4. **Yanlış yokluk koruması.** "Hiçbir ürünün başlığında X yok" diyen (kısmi kapsam sözcüğü
   `diğer/bazı/yalnız/dışında` içermeyen) cümle reddedilir (`false_absence`) eğer (a) X küçük bir
   Türkçe/İngilizce malzeme sözlüğündeki bir terimse (pamuk/cotton, silikon/silicone/TPR, çelik/steel…) ve
   bir başlıkta geçiyorsa ya da (b) cümledeki başlı başına duran 2+ haneli sayı ("iPhone 16") bir başlıkta
   geçiyorsa. Ürün adının parçası olan sayılar (LP40, 520BT) sayılmaz.
5. **Prompt:** yaklaşık fiyat/tarih/kargo-vergi kuralları; karşılaştırmada yalnız fiyat sıralamak yerine
   başlıkta açıkça yazan ayırt edici bilgileri (model, kapasite, boyut, malzeme, tür, mağaza) ürünleri adıyla
   yan yana koyarak aktarmak; yetersizse bunu söylemek.

## Ölçüm (model çağrısı yok; kayıtlı 134 cevap yeniden doğrulandı)

Önceki turdaki kural eklemeleri bu etiketli kümeye göre yazılmıştı; bu karardaki yeni kurallar kümeden
türetilmedi (fiyat/tarih/kargo kuralları ürün sahibinin kararından, yokluk koruması 4 yanlış-yokluk
cevabının ortak yapısından gelir) ama yine de AYNI küme üzerinde ölçüldü, bu yüzden bağımsız sayılmaz.

- İnsan denetiminde kritik 20 cevap: 12'si tamamen reddediliyor, 6'sının sorunlu paragrafı atılıyor,
  2'si aynen geçiyor (`desk_lamp-04`, `fidget-04`; ikisi de yokluk iddiası, kelime kuralıyla yakalanamıyor).
- Doğru 96 cevabın 95'i aynen kalıyor (kayıp: `backpack-01`, önceki turdan beri bilinen).
- Yeni yanlış-yokluk koruması doğru cevap kaybettirmedi; ilk denemedeki 3 kayıp (ürün adındaki sayılar)
  yalnız başlı başına duran sayılar sayılarak giderildi.

## Yapılandırılmış öznitelik değerlendirmesi (Faz 8)

Katalogda `product.attributes` ve marka/renk/malzeme ~%0'dır; başlıktan deterministik çıkarım en iyi
ihtimalle %10-15 ürünü kapsar. Bu yüzden öznitelik, doğrulayıcının bir ön koşulu YAPILMADI. Mevcut
malzeme sözlüğü bunun küçük, geçici bir tohumudur. Öznitelik gelirse: (a) `result_facts`'e eklenir,
(b) yokluk cümleleri ("pamuklu yok") veriyle sınanır, (c) kalan iki yanlış-yokluk açığı kapanır. Terminal 1'in
ingestion/marka/embedding işine dokunulmadı.

## Sınırlar

- Prompt değişikliklerinin etkisi **ölçülmedi** (ücretli çağrı yapılmadı). Niyet dışı 18 cevabın
  (çoğu "hangisi daha uygun" sorusunda fiyat sıralamaya çekilme) düştüğü iddia edilemez.
- Yaklaşık fiyat doğru etiketlenir ama kurun yaşı bu aşamada sınırlandırılmaz (sahip kararı); tarih
  `price_date` yoksa söylenmez.
- İngilizce başlıklarda malzeme dışı bilgiler (watt, "dimming") için yanlış yokluk hâlâ geçebilir.
- Canlı veri ile kayıtlı fiyat dağılımı bu karar için ayrıca ölçülmedi; sentetik vakalar yurt dışı fiyatı
  `price_try = null` ile temsil ediyordu, yeni biçim bir sonraki ölçümde ilk kez gerçekleşecek.
