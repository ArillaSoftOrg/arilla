# 0211 — Sohbet sonuç cevabı, kullanıcının aktif sekmesindeki ürünlere göre yazılır

**Tarih:** 15 Kasım 2026 · **Durum:** kabul edildi · **Bayrak:** `CHAT_RESULT_ANSWER` (varsayılan kapalı,
değişmedi) · **Migration:** yok · **Düzelttiği:** karar 0203 "Sınırlar" ilk madde

## Sorun

Karar 0203 cevabın dayandığı ürün gerçeklerini her zaman "balanced" (Önerilenler) sıralamasıyla
okuyordu. Kullanıcı "En Uygun Fiyat" ya da "En İyi Eşleşmeler" sekmesindeyken cevapta anılan ürünler
ekrandaki kartlarla aynı olmayabilirdi; cevap görünmeyen ürünlerden söz edebilirdi.

## Karar

1. **Sekme mesajla birlikte kaydedilir.** İstemci, mesajı gönderirken URL'deki `?sirala=` değerini
   sunucu eylemine iletir; `submitUserMessage` geçerliyse (`secilen|firsat|eslesme`) kullanıcı mesajının
   `payload.viewTab` alanına yazar. Bozuk/eksik değer sessizce atılır (eski istemci uyumludur). Yeni
   kolon ya da migration yok.
2. **Gerçekler o sekmenin sıralamasıyla okunur.** `runPendingTurn`, son kullanıcı mesajının sekmesini
   `resolveViewTab` ile çözer (sayfadaki `parseSortKey` ile AYNI kural: açık tercih, yoksa niyetin
   "daha uygun fiyatlı" isteği fiyat sekmesini açar; `eslesme` yalnız v2'de) ve `loadResultFacts`'a o
   sekmenin sıralamasını verir: v2'de Önerilenler `balanced`, En Uygun Fiyat `lowest_price`, En İyi
   Eşleşmeler `best_match`. v2 kapalıyken `eslesme` (metin aramasında çapa olmadığından) `balanced`'a
   düşer; bu sekme zaten arayüzde pasiftir.
3. **Tek eşleme kaynağı.** Sekme ayrıştırma ve sekme→sıralama eşlemesi `packages/core/src/chat/view-tab.ts`'tedir
   (kural 6); web `chat-sort.ts` bunlara devreder, iki ayrı eşleme yoktur.
4. **Cevap hangi sekmeye göre yazıldığını taşır.** Cevap `notice` mesajının payload'ına `answerTab`
   yazılır; sohbet geçmişinde cevabın altında "<sekme adı> sekmesindeki ilk 8 ürüne göre yazıldı" notu
   gösterilir. Kullanıcı sekmeyi sonradan değiştirse de eski cevap yanıltmaz: hangi sıralamaya dayandığını
   kendisi söyler. Geçmiş mesajlar ve ürün kartları değiştirilmez (mesajlar değiştirilemez).

## Sınırlar

- Cevap tur anında okunan gerçeklere dayanır; katalog fiyatı o arada değişmişse kartlar farklı olabilir
  (karar 0203). Not, sekmeyi söyler, anlık fiyat sözü vermez.
- Etiket yalnız cevabı üreten sekmeyi gösterir; ilk 8 ürün, ekrandaki ilk 4 kartı ve açılan listenin
  devamını kapsar.
- Eski bir cevapta `answerTab` yoksa etiket gösterilmez (geriye uyumlu).
- Faz 7 pilot ölçümü (155 vaka) sabit gerçek kümeleriyle koştu; sekme akışı canlı veriyle ayrıca ölçülmedi.

## Doğrulama

`view-tab.test.ts` (ayrıştırma ve eşleme); `result-answer-tab.integration.test.ts` (gerçek Postgres: her
sekme için cevap gerçekleri `searchByIntent` kartlarıyla aynı sırada, eski istemci ve bozuk sekme
varsayılana düşer, cevap ve kullanıcı mesajı sekmeyi taşır, geçmiş cevaplar kendi etiketini korur, bayrak
kapalıyken gerçek okunmaz); `image-chat.test.ts` (eylem geçerli sekmeyi iletir, bozuğu eklemez).
