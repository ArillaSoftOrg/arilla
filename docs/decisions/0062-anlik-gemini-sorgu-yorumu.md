# 0062 — `/ara` içinde anlık Gemini sorgu yorumu

**Tarih:** 7 Ekim 2026
**Durum:** Kabul edildi, **bayrak arkasında, üretimde kapalı**
(`GEMINI_REALTIME_ENABLED`). Açılmadan önce hukuki yeniden değerlendirme ve
aydınlatma metni güncellemesi gerekir (aşağıda "Açmadan önce").

ManiCepte bir yapay zekâ alışveriş araması. Doğal dilde yazılan bir sorgu,
aynı istekte Gemini ile yorumlanıp ürün aramasını etkileyebilmeli. Karar 0059
yalnızca çevrimdışı toplu işe izin veriyordu; bu karar onu bayrakla genişletir.

## Karar

1. **Tek entegrasyon:** aynı `GeminiClient`, istem, doğrulayıcı
   (`validateInterpretation`), `api_usage` ve `query_interpretation` yazma yolu
   (`persistOutcome`). İkinci bir yapay zekâ entegrasyonu yok.
2. **Akış** (`resolveRealtimeInterpretation`, `planConversationWithRealtimeInterpretation`):
   normalize → metin süzgeci (`queryContentIneligibility`: kişisel veri, sır,
   özel nitelikli veri, uzunluk) → aynı kimlikte saklanan yorum varsa yeniden
   kullan (boş/geçersiz sonuç için model tekrar çağrılmaz) → günlük anlık tavan
   → Gemini (tek deneme, 2,5 sn) → doğrula → sakla → planla → ara.
3. **Toplu işten farklar (yalnızca anlık yol):** 3 arama / 3 farklı gün eşiği
   yok; deterministik ayrıştırıcı domain bulsa da yorum alınır ve yalnızca
   eksikleri doldurur. Toplu iş eşiklerini ve tavanını korur.
4. **Öncelik:** açık kullanıcı beyanı > deterministik ayrıştırıcı > Gemini
   (`applyInterpretation` model önceliği; `firstTurnEnrichment`). Gemini
   deterministik domaini, bütçeyi ya da açık cevabı ezemez; farklı domain
   önerirse o domainin nitelikleri atılır.
5. **Aramaya etkisi** (`compileQuery`): domain → `retrievalTerms` metin kapısı
   ve (taksonomide tanımlı ve katalogda biliniyorsa) `category_path` süzgeci;
   katkısı olan nitelik seçenekleri → metin niteleyicileri; bütçe →
   `price_min`/`price_max`. Katkısı tanımlanmamış nitelikler (ör. kaskta
   `use_case`) yalnızca netleştirme sorusunu atlatır, SQL'i değiştirmez.
   Model ürün, fiyat, mağaza ya da stok üretmez; çıktısı yalnızca sabit
   taksonomiden kimlik ve metinde geçen fiyattır.
6. **Hata:** zaman aşımı, 429, 5xx, ağ, geçersiz çıktı, tavan, veritabanı
   hatası → yorum yok, plan deterministik yolla birebir aynı. Kullanıcı hata
   görmez; log yalnızca sabit kod taşır.
7. **Bütçe:** 2,5 sn, tek deneme. Flash-Lite + `minimal` düşünme + ~1k token
   istem tipik 0,6–1,5 sn; toplu işin 10 sn × 2 bütçesi etkileşimli arama için
   uygun değil. Fluid Compute açık; `maxDuration` değişmedi.
8. **Maliyet:** ayrı günlük tavan `REALTIME_INTERPRETATION_DAILY_CALL_CAP`
   (2.000 deneme, Europe/Istanbul günü), `api_usage.operation =
   'query_interpretation_realtime'`. Toplu işin 100'lük tavanı ayrı sayılır.
9. **Yönetim tanısı** (`/yonetim/arama/tani`) Gemini çağırmaz; salt okunur yol.
10. **Migration yok.**

## Açmadan önce

- Hukuk danışmanı onayı: onaylanan LIA "arama sırasında Gemini çağrılmaz" ve
  tekrar eşiğini veri minimizasyonu olarak kullanıyordu. Taslak:
  `docs/legal-review/gemini-anlik-yorum-taslak.md`.
- `/gizlilik` §2.2 ve `/kvkk-aydinlatma` metinleri güncellenip yayına alınır
  ("arama yaptığınız anda değil" ifadesi değişir).
- Ardından `GEMINI_REALTIME_ENABLED=true` (Vercel Production) ve yeniden dağıtım.

## Bilinen sınırlar

- ~~Taksonomi altı domainle sınırlı~~ ve ~~"10 bin" reddedilir~~: karar 0063
  ile katalog ürün türleri ve Türkçe fiyat dili eklendi.
- 8'den fazla rakam içeren sorgu (ör. "15000 ile 25000") kimlik benzeri
  sayılıp modele gönderilmez.
- Domain yoksa plan konvansiyonel kalır; yalnızca bütçe içeren yorum o yolda
  kullanılmaz.

## Reddedilen alternatifler

- **Toplu işin tekrar eşiğini anlık yolda korumak:** ilk kez yazılan sorgu
  hiç anlık yorum alamazdı.
- **Yeniden deneme:** ikinci deneme kullanıcıyı bekletir; hata zaten
  deterministik aramaya düşer.
- **Ortak tavan:** anlık trafik toplu işi aç bırakırdı.
