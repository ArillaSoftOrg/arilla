# 0197 — Ana ürün sorgusunda aksesuar kademesi

Not: 0195/0196 başka dallarda (BGE-M3) alındı; bu karar 0197.

## Karar
Sorgu aksesuar/parça istemiyorsa metin aramasında aksesuar gibi görünen ürünler ayrı bir **sıra kademesine**
girer: önce ana ürünler, sonra aksesuarlar (kademe içinde mevcut skor / "en iyi fırsat" sırası). Aksesuar
elenmez. Her iki sekme (Bizim seçtiklerimiz, En iyi fırsatlar) için geçerlidir.

- **Aday havuzu:** `candidateCtes` her dal için sıralamasız `LIMIT 1000` kullanır; bol aksesuar ana ürünü havuzdan
  itebiliyordu (sel testi bunu yakalar). Ana ürün dalı aksesuar başlığını dışlar (tam sınır); aksesuarlar ayrı,
  küçük (`ACCESSORY_BRANCH_LIMIT`=100) bir dalda toplanır. `cand_meta.capped` yalnız ana ürün dalına bakar.
- **Sınıflandırma:** başlığın *asıl adı* (`+`, ` with `, "hediyeli", "kılıflı" ifadeleri atılmış) belirgin aksesuar
  ifadesi taşıyorsa (kılıf, telefon/silikon case, ekran koruyucu, kablo, şarj aleti, adaptör, telefon tutucu,
  yedek parça, aksesuar…). Başka ürün türlerinde ana ürün adı olan kelimeler (koruyucu, skin, kayış, strap,
  sticker, tutucu, yedek, case, holder) listede yoktur: "güneş koruyucu krem", "kemer kayış", "pencil case" ana üründür.
  "iPhone 15 + Kılıf Hediyeli" ana üründür.
- **Kategori yolu sinyali kullanılmaz.** Üretimde `aksesuar` aynı zamanda moda kökü (`aksesuar/canta`,
  `aksesuar/saat`, `moda/aksesuar/*`); yola bakmak çanta/saat/takıyı yanlış demote ederdi. Aday dalı ve nihai sıralama
  aynı başlık sinyalini kullanır.
- **Niyet kaynağı önceliği:** açık kullanıcı sözü (`queryWantsAccessory`) > doğrulanmış IntentV2 rolü
  (`accessory`/`part` kademeyi kapatır; yalnız `/sohbet?q=` yolunda, `QUERY_INTENT_V2=on`) > varsayılan (ana ürün).
  Rol `QueryObject.product_role` ile taşınır; önbelleğe yazılmaz.

## Gerekçe
Fiyat çarpanı ~100 kat aralıklıdır; çarpanla ceza yetmez, kademe gerekir. Eleme yanlış sınıflamada doğru ürünü
kaybettirir; kademe kaybettirmez.

## Bilinen sınırlar
- Aksesuar dalı seyrek aksesuarlı çok yaygın bir terimde tüm bitmap'i tarayabilir; üretimde 3 terimde ölçüldü
  (canta, elbise, lamba: 5–140 ms), çok yüksek frekanslı terim ölçülmedi.
- Sohbet yolu (`SearchIntent`) rol taşımaz; yalnız metin tabanlı kademe çalışır. Takip mesajında model "kılıf"ı
  `query` yerine başka alana yazarsa kademe aksesuar isteğini görmez (önceden var olan davranış).
- `compatTier` (uyumluluk kademesi) hâlâ bağlı değil.

## Reddedilen
- Katsayı (0,15) ile ceza: ucuz aksesuar yine öne geçiyor.
- Sert eleme: yanlış sınıflanan ürünü kaybettirir.
- Kategoriye/cihaza özel kelime listesi.
