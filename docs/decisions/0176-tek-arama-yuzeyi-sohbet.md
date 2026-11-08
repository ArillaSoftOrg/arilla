# 0176 — Tek arama yüzeyi: `/sohbet` (`/ara` emekliye ayrılır)

Durum: Kabul edildi (8 Kasım 2026). Aşamalı uygulanır; Faz 0 kullanıcıya etkisiz. İlgili: 0002
(arama duvarı), 0030 (konuşmalı netleştirme), 0062/0063 (anlık yorum), 0066 (kademeli arama),
0074/0078/0090/0091 (konuşmalı keşif, görsel ve link), 0102 (internet araması), 0171 (IntentV2),
0172 (normalizasyon).

## Bağlam

İki arama yüzeyi aynı katalog aramasını (`searchWithFallback`) kullanıyor ama iki ayrı niyet hattı
(`/ara`: 0062 + IntentV2; `/sohbet`: 0074 `chat_turn`), iki bütçe, iki boş-sonuç dili ve iki ayrı
erişim kuralı taşıyor. Kullanıcılar ve ekip hangi sayfada olduklarını karıştırıyor. Ürün yönü
konuşmalı keşif olduğu için tek yüzey `/sohbet` seçildi.

## Karar

1. **Tek yüzey `/sohbet`.** `/sohbet?q=` "arama turu"dur: anonim de kullanabilir (ürün kapısı
   açıksa), 0002 duvarı, IntentV2 (0062 kotaları), normalizasyon, kademeli arama, sıralama,
   sayfalama, internet araması (0102) ve kalite kaydı bugünkü `/ara` ile aynıdır. Ortak kod
   `apps/web/app/lib/search/` altındadır; iki adres geçiş süresince aynı kodu çalıştırır.
2. **Konuşma turu oturum ister** (`/sohbet/[id]`, 0074): takip mesajı, görsel (0078/0091) ve link
   (0090) bugünkü kurallarla. Anonim kullanıcı yalnızca deterministik daraltma (`n=` adımları)
   alır; model destekli takip, görsel ve link için giriş gerekir.
3. **Tur başına en fazla bir model çağrısı.** Arama turu 0062 (`query_interpretation_realtime`,
   günlük 2.000, kişi/IP kotası); konuşma turu 0074 (`chat_turn`, günlük 3.000, saatlik 20 mesaj).
   Bütçeler ayrı kalır. Konuşmaya geçişte ilk tur saklanan IntentV2 yorumunu kullanır, model
   yeniden çağrılmaz.
4. **Tek niyet doğrulaması.** Konuşma turunun `SearchIntent`'i `QueryObject`'e çevrilirken
   IntentV2'nin kip kuralı uygulanır: marka/kategori yalnızca katalogda doğrulanmışsa filtre,
   aksi halde ipucu (0171 §4.2).
5. **URL eşlemesi (Faz 4, 308):** `/ara?q=` → `/sohbet?q=` (`sort`, `sayfa`, `n` korunur);
   `/ara/link?url=` → `/sohbet/link?url=`; `/ara/gorsel` → `/` (bugünkü gibi).
6. **Geçiş bayrağı** `SEARCH_SURFACE=ara|sohbet` (varsayılan `ara`): giriş noktalarının (arama
   formu, ana sayfa, geri düşüşler) hedefini seçer. Faz 4'te kaldırılır.
7. **SEO:** iki yüzey de `noindex`; `robots.txt` ikisini de dışlar. Değişiklik yok.
8. **Analitik:** `search_submitted` arama turundan aynı alanlarla yazılır; GA4/Umami yol eşlemesi
   `/sohbet?q=` için `search` alanı olur (`docs/events.md`).

## Aşamalar

- **Faz 0** (etkisiz): `/sohbet/misafir` ürün kapısı ve bayrak kontrolü; ortak arama modüllerinin
  `app/lib/search/` altına taşınması; bu belge.
- **Faz 1:** `/sohbet?q=` arama turu (bayrak arkasında), `/sohbet/link`, proxy çerezi ve ürün
  kapısı yol listesi; `/ara` ile eşdeğerlik testi.
- **Faz 2:** konuşmada tam liste ve sayfalama, ortak niyet doğrulaması, olumsuzluk düzeltmesi
  ("X olmayan" zorunlu metinden çıkar), `search_submitted` konuşmadan.
- **Faz 3:** giriş noktaları `/sohbet`'e (`SEARCH_SURFACE=sohbet`).
- **Faz 4** (Faz 3 canlıdan en az 2 hafta sonra): `/ara` 308 yönlendirme, `app/ara` silinir,
  belgeler ve CLAUDE.md kural 1 güncellenir, bayrak kaldırılır.

## Reddedilen alternatifler

- **`/ara` tek yüzey, sohbet onun altında:** daha az iş, ama ürün yönü konuşma; görsel/link ve
  takip turları zaten `/sohbet`'te. Kullanıcı tercihi `/sohbet`.
- **Tek adımda geçiş:** giriş noktası sayısı (yaklaşık 127 dosya) ve iki ayrı test takımı yüzünden
  geri alınamaz risk; bayraklı aşamalar seçildi.
- **Anonim kullanıcıya model destekli konuşma:** maliyet ve kötüye kullanım riski; 0074 oturum
  kuralı korunur.

## Hukuk / KVKK

Arama ve sohbet tek akışta anlatılır: `/gizlilik` ve `/kvkk-aydinlatma` metinleri Faz 3'ten önce
güncellenir. Model çağrılarının kapsamı değişmez (0062 ve 0074 aynen); görsel saklama (0078, en
fazla 90 gün) değişmez.

## Geri alma

Faz 1–3: `SEARCH_SURFACE=ara` + web yeniden başlatma. Faz 4 sonrası: yönlendirme kuralları geri
alınır (sayfa kodu `app/lib/search` altında durduğu için `/ara` rotası tek dosyayla geri gelir).
