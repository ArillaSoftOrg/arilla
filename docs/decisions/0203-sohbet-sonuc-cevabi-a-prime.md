# 0203 — Sohbet: sonuçlar hakkında delilli model cevabı (A' pilotu)

**Tarih:** 15 Kasım 2026 · **Durum:** kabul edildi (pilot) · **Bayrak:** `CHAT_RESULT_ANSWER` +
`CHAT_RESULT_ANSWER_USERS` (varsayılan kapalı) · **Değiştirir:** CLAUDE.md kural 1, sohbet istisnası

## Sorun

Dupe benzeri deneyimin çekirdeği ürünlerin doğal dille değerlendirilmesi. Modelsiz değerlendirme
(0201) yalnız sayısal özet verir. Kullanıcının "hangisi daha uygun?", "farkları açıkla" gibi
sorularına cevap verilemiyor. İlk arama turunda model aramadan ÖNCE çalıştığı ve ürünleri henüz
görmediği için otomatik yorum bu yolla mümkün değil (o iş Faz 9/B).

## Karar

Kullanıcı gösterilen sonuçlar hakkında soru sorduğunda, MEVCUT tek çağrıya (ek çağrı yok):

1. **Girdi:** o turda katalogdan okunan en çok 8 ürünün doğrulanmış alanları (`result_facts`:
   `id` p1..p8, başlık, marka, mağaza, TL fiyat tam sayı, teklif sayısı). Sorgu/ürün kimliği
   modele gitmez. Katalogdan okuma, sayfanın gösterdiği aramanın aynısıdır (saklı niyet, varsayılan
   sıralama); sonuçlar mesajda saklı olmadığından "kullanıcının gördüğü" ile birebir garanti
   edilemez (bkz. Sınırlar).
2. **Tetik:** yalnız bayrak + izin listesi + mevcut niyet + sorunun sonuç sorusu gibi görünmesi
   (`looksLikeResultQuestion`: "hangisi", "fark", "karşılaştır", "öner", "daha iyi/uygun", "?" ile
   biten kısa soru...). Tetik yoksa girdiye ürün gerçeği EKLENMEZ ve ek sorgu çalışmaz.
3. **Çıktı:** yeni eylem `answer` (arama yapmaz). Şema: en çok 3 paragraf, her paragraf için
   `evidence: [{item, field, quote}]` (`field`: title | price | brand | store | offer_count).
   `answer` eylemi yalnız `result_facts` verilmişse şemada vardır; yoksa eski şema aynen.
4. **Sunucu doğrulaması (`validateAnswer`):** `item` verilen gerçeklerde olmalı; `quote` ilgili
   alanın alt dizesi (katlanmış) ya da fiyat/teklif sayısı için aynı sayı olmalı; paragraf
   metnindeki HER rakamlı sözcük o paragrafın bir alıntısında geçmeli; doğrulanamayan kalite,
   performans, "en iyi", uyumluluk, "ucuz" gibi iddialar ve büyük harf yasak; delilsiz paragraf
   atılır. Hiç paragraf kalmazsa model cevabı kullanıcıya gösterilmez: modelsiz özete
   (`buildResultCommentary`) düşülür.
5. **Saklama (kural 3):** cevap sohbet mesajı olarak (`notice`, `payload.answer`: doğrulanan
   paragraflar + alıntılar + kaynak) yazılır; `api_usage` mevcut tur hattından (tek çağrı).
   `current_search_intent` değişmez; arama bloğu ve sekmeler etkilenmez.
6. **Sınırlar ve tavanlar:** mevcut saatlik tur tavanı, günlük sağlayıcı bütçesi, süzgeç ve
   `isBlockedFromModel` aynen; ürün gerçekleri de aynı süzgece tabidir (engellenen metin içeren
   başlık modele gitmez).
7. **Arayüz:** `CHAT_UX_V2` açıkken değerlendirme metninin altında "Farkları açıkla" çipi
   (mesaj kutusunu hazır cümleyle doldurur; kullanıcı gönderir, otomatik gönderim yok).

## Pilot (bayrak + izin listesi)

`CHAT_RESULT_ANSWER=true` ve `CHAT_RESULT_ANSWER_USERS=<kullanıcı kimlikleri, virgülle>` (ya da `*`,
yalnız pilot sonrası kullanıcı onayıyla). Çıkış ölçütleri: doğrulayıcıdan geçen cevap oranı ≥%95;
elle denetlenen ≥100 cevapta delilsiz/yanlış iddia 0 kritik; tur süresi mevcut sohbet turundan
en çok +1 sn; token maliyeti/tur ölçülür.

## Reddedilen

- **Serbest metin cevap (delilsiz):** doğrulanamaz, katalog verisi dışında iddia riski.
- **İkinci ayrı model çağrısı (arama sonrası):** bu Faz 9/B'dir; maliyet/gecikme kapıları ayrı karar.
- **Spec/özellik cevabı:** katalogda yapılandırılmış özellik yok (Faz 8 ön koşulu).

## Sınırlar

- Ürün gerçekleri tur anında yeniden okunur: fiyat/sıra kullanıcının gördüğüyle birebir aynı
  olmayabilir (sonuçlar saklanmaz; mesajlar değiştirilemez). Cevap yalnız bu turdaki doğrulanmış
  gerçeklere dayanır, geçmiş görünümü iddia etmez.
- ~~Sekme tercihi sunucuya gitmediği için gerçekler varsayılan sıralamadır.~~ Karar 0211 ile
  düzeltildi: gerçekler mesajın gönderildiği andaki aktif sekmenin sıralamasıyla okunur.
- Gerçek model ile kalite ölçümü pilotta yapılır; bu karar kalite iddiası taşımaz.
