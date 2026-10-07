# 0075 — Sohbet arayüzü ve gezinme iyileştirmeleri

**Tarih:** 8 Ekim 2026 · **Durum:** kabul edildi (karar 0074'ün arayüz katmanı; arka uç mimarisi değişmedi)

## Karar

1. **Ana sayfadan yeni sekme.** Kutudaki gönderim (Enter, buton, örnek çip) ana sayfa
   sekmesini bırakır ve sohbeti yeni sekmede açar. `window.open` kullanıcı hareketi
   sürerken ilk senkron adımdır (popup engelleyici); sohbet `startChatInNewTabAction`
   ile oluşturulur (redirect yok), sekme `/sohbet/[id]`ye gider. Oluşturma başarısızsa
   sekme kapatılır (boş sekme kalmaz). Popup engellenirse aynı sekmede açılır (sessiz
   başarısızlık yerine). Çift gönderim kutuda engellenir; sohbet içi mesajlar sekme açmaz.
2. **Konuşma dili.** Model talimatı: 1–3 kısa, doğal Türkçe cümle; kullanıcının sözünü
   tekrar etme; dolgu açılış yok; sonucu göster, işe yarıyorsa bir sonraki daraltmayı
   öner; ürün/fiyat/mağaza söyleme. Örnekler talimata gömüldü.
3. **Sıralama sekmeleri** ("Bulduklarım" kaldırıldı). Seçtiklerimiz → `balanced`,
   En iyi fırsatlar → `best_deal`, En iyi eşleşmeler → `closest_match`. **`closest_match`
   ürün çıpası ister (`search()` çıpasız `UnsupportedSortForIntentError` atar); metin/sohbet
   aramasında çıpa yoktur.** `/ara` bu sekmeyi aynı nedenle devre dışı gösterir; sohbet de
   öyle: sekme görünür, "Bu arama için kullanılamıyor" ile devre dışı. İkinci bir sıralama
   motoru yazılmadı (reddedilen: başlık benzerliğine göre yeniden sıralama). Sekme
   `?sirala=` ile bağlantıdır: aynı sohbet/niyet, model çağrısı yok, arama yeniden çalışır.
4. **Önizleme ve genişlik.** 6 ürün önizlemesi, sohbet sütunu 68rem, mesaj balonları
   44rem; kartlar mobilde 2, ≥720px 3 kolon. Yalnızca en son aramanın sonuçları
   gösterilir (eski aramalar özet).
5. **"Bu yardımcı oldu mu?"** `feedback` (0032) serbest metinli, yönetici triyajlı bilettir;
   bu sinyal farklı olduğu için ayrı küçük tablo: `chat_result_feedback` (0055), arama
   mesajı başına tek evet/hayır oyu, metin taşımaz, sohbetle birlikte silinir. Analitik olayı
   **gönderilmez** (kural 13: `docs/events.md`'de tanımlı değil). Oylar dışa aktarıma
   henüz eklenmedi (kişisel metin içermez; açık iş).
6. **Tüm sonuçlar.** "Tüm N sonucu görüntüle" mevcut `/ara` deneyimine gider (aynı
   niyet metni + fiyat kalıbı + `sort`); sohbette ikinci bir tam sonuç sayfası yok.

## Reddedilen alternatifler

- `feedback` tablosunu yeniden kullanmak: yönetici gelen kutusunu 👍/👎 ile doldurur.
- Sohbet içinde sonsuz genişleyen sonuç listesi: `/ara` zaten sayfalama ve sıralamayı sağlıyor.
- Sekmeleri istemci durumunda tutmak: yenileme/paylaşımda kaybolur; bağlantı daha sağlam.
