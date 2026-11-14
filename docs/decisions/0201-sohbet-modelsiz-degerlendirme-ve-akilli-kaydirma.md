# 0201 — Sohbet: modelsiz sonuç değerlendirmesi ve akıllı kaydırma

**Tarih:** 15 Kasım 2026 · **Durum:** kabul edildi · **Bayrak:** değerlendirme `CHAT_UX_V2` arkasında;
kaydırma/klavye düzeltmeleri bayraksız (varsayılan akışı iyileştirir)

Dupe benzeri sohbet planının Faz 3 (modelsiz değerlendirme) ve Faz 6 (kaydırma, klavye) parçaları.

## 1. Modelsiz sonuç değerlendirmesi (Faz 3)

`CHAT_UX_V2=true` iken ilk 4 ürün kartının hemen altında, gösterilen katalog kartlarının
doğrulanmış alanlarından hesaplanan kısa bir metin (`buildResultCommentary`, saf fonksiyon):

- fiyat aralığı ve ortanca (TL), mağaza sayısı ve en çok ürünü olan mağaza, baskın marka
  (≥3 ürün ve yarıdan çoğu), fiyatsız ürün sayısı, yurt dışı (yaklaşık) fiyat notu;
- ürün başlığı ANMAZ (gizli kartlara atıf olmasın); en çok 4 cümle; en az 3 kart yoksa yazılmaz;
- özellik, performans ya da kalite iddiası YOKTUR (katalogda teknik özellik verisi yok:
  `product.attributes` boş, `generated_content` 0 satır); arayüz yasak sözcükleri ve büyük harf yok;
- aynı olgu için birkaç eşdeğer kalıp; seçim sorgudan türetilen sabit tohumla (rastgelelik yok,
  aynı sorgu aynı cümle) böylece her sorguda aynı kalıp tekrarlanmaz ve testlenebilir.

Sekme değişiminde metin o sekmenin kartlarından yeniden hesaplanır (model çağrısı yok).
Model destekli değerlendirme (A'/B) bu kararın kapsamı DIŞINDADIR (Faz 7/9, ayrı karar ve
CLAUDE.md kural 1 güncellemesi gerektirir).

## 2. Akıllı kaydırma ve klavye (Faz 6, bayraksız)

- Yeni yanıt gelince ekran yalnızca (a) kullanıcı mesajı kendisi gönderdiyse, (b) sayfa yeni
  açıldıysa ya da (c) kullanıcı alta ≤120 px yakınsa kaydırılır. Eski mesajları okuyan kullanıcı
  zorla kaydırılmaz; "Yeni yanıt ↓" düğmesi çıkar, alta inince ya da tıklanınca kalkar
  (`shouldAutoScroll`, `distanceFromBottom`).
- `visualViewport` ile klavye boşluğu (`--kb-inset`) hesaplanır ve yapışkan mesaj kutusu o kadar
  yukarı alınır (iOS Safari'de klavye düzen görünümünü değil görsel görünümü küçültür);
  `visualViewport` yoksa ya da klavye yokken 0 (`keyboardInsetPx`).

## Yapılmayanlar (Faz 6 kapsamından)

- **İptal (AbortController):** sunucu eylemleri (`runTurnAction`) istemciden iptal edilemez;
  yeni mesaj gönderimi zaten çalışan tur bitene kadar kilitlidir (kira). Değişmedi.
- **Boş sonuçta ek arama önerileri:** mevcut gevşetme notları ve açıklama metni korundu.
- **Kontrast ölçümü ve gerçek iOS/Android cihaz testi** bu ortamda yapılamadı.
