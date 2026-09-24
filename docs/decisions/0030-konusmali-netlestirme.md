# 0030 — Konuşmalı netleştirme: erişim öncesi katman

**Tarih:** 2026-09 · **Durum:** kabul edildi (motor hazır, `/ara`'ya bağlanmadı)

## Karar

"kask arıyorum" veya "hediye arıyorum" gibi belirsiz bir sorguda Arilla,
rastgele ürün göstermek yerine **tek** bir soru sorabilir: "Nasıl bir kask
arıyorsun?". Bu davranış, arama motorunun önüne konan ayrı bir katmandır:
`packages/core/src/clarification/`.

1. **Erişim öncesi katmandır.** Netleştirme sonucu mevcut `QueryObject`
   olur (`compileQuery`). Erişim, sıralama ve ürün gerçeği `search()`'te
   kalır. Katman ürün, fiyat, stok veya marka üretmez.
2. **Durum yapılandırılmıştır ve birikir.** Her tur sıfırdan yorumlanmaz.
   `SearchState` domain'i, faset seçimlerini, bütçeyi, atlanan soruları ve
   soru sayaçlarını tutar. Durum URL'deki girdi listesinden deterministik
   olarak yeniden kurulur (`?q=…&n=a~helmet_type~full_face`). Bu yüzden
   `localStorage` veya sunucu oturumu gerekmez.
3. **Taksonomi seçenekleri sınırlar.** Seçenekler elle yazılmış kural
   sözlüğünden (`rules.ts`) gelir. Filtre fasetindeki her seçeneğin bir
   arama katkısı vardır: metin kapısı terimi veya mevcut bir
   `category.path`. `validateRegistry` aranamayan seçeneği, katalogda
   olmayan kategoriyi, yasaklı kelimeyi ve ALL CAPS etiketi reddeder.
   Katalogda olmayan bir kategori derleme sırasında düşürülür.
4. **Minimum soru.** Kurallar şöyle: domain'de `essential` soru varsa
   sorulur. `useful` soru yalnızca sinyal sayısı düşükse sorulur. Domain
   başına soru sayısının bir tavanı vardır. Aynı soru en fazla iki kez
   sorulur; iki kez cevapsız kalırsa arama yapılır. Kural sözlüğüne
   düşmeyen her sorgu ("masa lambası", "iphone 16 kılıfı") soru sorulmadan
   aranır.
5. **Her soru atlanabilir.** "Fark etmez", "Emin değilim" ve "Sonuçları
   göster" her adımda vardır. Atlanan soru bir daha sorulmaz. Kullanıcı
   atlarsa en geniş makul arama yapılır.
6. **Çelişki olmaz.** Her fasette tek değer tutulur. Öncelik sırası şudur:
   **son açık kullanıcı beyanı > türetilmiş değer > model çıkarımı.** Eşit
   öncelikte yeni gelen kazanır. "Önce kapalı, sonra açık olsun" durumunda
   yalnızca `open_face` kalır.
7. **Model yorumcudur, ürün kaynağı değildir.** `IntentInterpreter`
   sağlayıcıdan bağımsız bir arayüzdür ve bugün hiçbir uygulaması yoktur.
   Modelin çıktısı katı bir JSON şemasıyla sınırlanır; şemadaki enum'lar
   taksonomiden üretilir. Çıktı `validateInterpretation`'dan geçmeden
   duruma yazılmaz. Metinde yazmayan bütçe sayısı reddedilir. Model
   çıktısı her zaman en düşük öncelikle yazılır.

## docs/search.md ile ilişkisi

`docs/search.md` "Netleştirme" bölümü, kategori belirsizliği için kategori
ağacından türetilen tek dokunuşluk çubuğu tanımlar. O bölüm geçerliliğini
korur. Bu karar ona **faset** netleştirmesini ekler: kategori belli ama
çok geniş olduğunda sorulan soru ("hangi tür kask?").

İki kural değişmez:

- **Sonuçlar bekletilmez.** `clarify` kararı da state taşır ve
  `compileQuery` o anki en olası yorumla bir sorgu üretir. Arayüz sonuçları
  gösterip soruyu üstlerine koyar. Soru, sonuçların yerine geçmez.
- **Elle yazılmış şablon istisnası bilinçlidir.** Faset soruları kategori
  ağacından türetilemez, çünkü katalogda `helmet_type` gibi bir öznitelik
  yok. Kural sözlüğü küçük tutulur ve belirsiz sorguların sık geldiği
  aileleri kapsar. Dünyadaki her kategoriyi modellemek amaç değildir.

## Model bağlama koşulları

CLAUDE.md kural 1 istek yolunda model çağrısını yasaklar. `IntentInterpreter`
bu kural karşılanmadan bağlanamaz. Bağlanmadan önce şunlar sağlanmalı:

- Model yalnızca **ilk turdaki ham sorgu** için ve deterministik
  çıkarıcı domain bulamadığında çağrılır. Seçenek tıklamaları hiçbir
  zaman modele gitmez.
- Sonuç `query_resolution` tablosuna, normalize sorgu metnine göre yazılır
  (Kademe 3 düzeni). Aynı sorgu ikinci kez modele gitmez. Tercih edilen yol,
  popüler sorguların toplu işle önceden yorumlanmasıdır.
- Her çağrı `api_usage` tablosuna yazılır (kural 9).
- İstek yolunda modele gitmeyi bu koşullarla kabul eden ayrı bir karar
  yazılır; ya da CLAUDE.md kural 1 açıkça güncellenir.

## Reddedilen alternatifler

- **Her turda LLM'e tüm konuşmayı yeniden yorumlatmak.** Maliyet kullanıcı
  sayısıyla ölçeklenir (kural 3). Model önceki cevapla çelişebilir ve
  aranamayan değerler uydurabilir.
- **Sonuçları soru cevaplanana kadar göstermemek (sihirbaz).** Bu,
  `docs/search.md`'nin "sonuçlar asla bekletilmez" kuralıyla çelişir.
  Kullanıcıyı da bir ankete hapseder.
- **Durumu `sessionStorage`'da veya sunucu oturumunda tutmak.** CLAUDE.md
  depolama gerektiren akışı yasaklar. Sunucu oturumunda tutmak ise link
  paylaşımını ve geri tuşunu bozar.
- **Tek büyük if/else.** Yeni bir ürün ailesi eklemek kod değişikliği
  gerektirirdi. Kural sözlüğü veridir; motor değişmeden genişletilebilir.
