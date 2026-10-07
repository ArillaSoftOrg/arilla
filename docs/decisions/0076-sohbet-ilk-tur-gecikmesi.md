# 0076 — Sohbet ilk tur gecikmesi: erken başlatma ve kabuk

## Karar

1. Ana sayfadan açılan sekme `about:blank` yerine doğrudan `/sohbet/yeni` açar
   (gerçek sohbet kabuğu: gezinme çubuğu, kullanıcı balonu, bekleme noktaları,
   kapalı giriş kutusu). `window.open` kullanıcı hareketi sırasında senkron çağrılır.
2. Mesaj URL'ye, history'ye ya da referrer'a girmez: ana sayfa mesajı aynı kaynaklı
   `localStorage`a **tek kullanımlık, 60 sn ömürlü** kayıt olarak yazar; URL yalnızca
   rastgele nonce taşır. Sekme kaydı okur okumaz siler. Depolama yazılamazsa sekme
   açılmaz ve ana sayfada hata görünür.
3. `/sohbet/yeni` sohbeti tek eylemle oluşturur (`startChatBootstrapAction`), kimliği
   hemen döndürür, **ilk turu yanıt gittikten sonra `after()` ile** başlatır ve
   `router.replace` ile `/sohbet/[id]`ye geçer (bootstrap history girişi bırakmaz).
4. İlk tur artık gezinme + SSR + hydration + ikinci eylem sonrası değil, oluşturma
   eyleminin hemen ardından başlar. `/sohbet/[id]` istemcisi normal yolda Gemini
   çağırmaz: hafif durum sorgusuyla (`getTurnStatusAction`) bekler; `RECOVERY_GRACE_MS`
   içinde tur başlamadıysa `runTurnAction` kurtarma olarak çalışır.
5. Tek Gemini çağrısı garantisi değişmedi: `processPendingTurn` atomik kira
   (`processing_until`) alır; `after()` ve kurtarma aynı anda gelirse biri `busy` olur.
6. `processPendingTurn` kira UPDATE'inde satırı `RETURNING` ile alır (ayrı sohbet
   okuması yok), oy sorgusunu atlar ve mesajlar / günlük tavan / sözlük ısıtma tek turda
   paralel okunur. `loadConversation` mesajları ve oyları paralel okur.
7. `lexicon` süreç içi önbelleğe alınır (`loadLexiconCached`, 5 dk TTL, `Database`
   başına, eşzamanlı okuma paylaşımı, hata önbelleğe yazılmaz, `invalidateLexiconCache`).
   Yalnızca sohbet aramasında kullanılır; `/ara` ve admin yolları değişmedi.
8. Tur cevabı yazılınca eylem/durum sorgusu kısa önizleme (metin) döndürür; istemci
   cevabı ve ürün iskeletini hemen gösterir, kalıcı kaynak yine sunucudur
   (`router.refresh()` ürünleri getirir; `lastSeq` ilerleyince önizleme kendiliğinden gizlenir).
9. Ölçüm: `chat.*` süreleri (`total, create_conversation, session, claim_turn,
   load_context, provider_limit, lexicon, gemini, persist, search`) yalnızca
   `CHAT_TIMING_LOG=true` iken tek JSON satırı olarak loglanır (metin, sorgu, kimlik yok).
   İstemci `performance.mark/measure` (`chat:shell_visible`, `chat:conversation_id`,
   `chat:assistant_visible`, `chat:render_ready`, `chat:products_visible`) kullanır;
   sunucuya gönderilmez.

## Gerekçe

Gemini'den önce 6–8 sıralı DB/ağ adımı vardı ve kullanıcı boş sekme görüyordu.
Bu adımların çoğu gezinmeye ve hydration'a bağlıydı, modelin girdisine değil.

## Reddedilen alternatifler

- Mesajı `?message=` ile taşımak: URL/history/referrer'a girer.
- `postMessage` el sıkışması: açılan sekmenin `opener` ilişkisini gerektirir.
- Bağlanmamış (unawaited) Promise ile arka plan işi: sunucusuz ortamda iş kaybolur.
- Gemini çağrısını oluşturma eylemine beklemeli bağlamak: sohbet kimliği gecikir.
- Yeni önbellek altyapısı / Redis'te sözlük: küçük, seyrek değişen veri için gereksiz.

## Bu karara dahil OLMAYANLAR

Model, düşünme seviyesi, akış (streaming), servis katmanı, zaman aşımı/yeniden deneme,
Vercel bölgesi ve Fluid Compute: gerçek anahtarla ölçümden sonra ayrıca karara bağlanır.
