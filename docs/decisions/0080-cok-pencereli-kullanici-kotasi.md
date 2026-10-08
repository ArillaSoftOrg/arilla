# 0080 — Çok pencereli kullanıcı kotası

**Tarih:** 8 Ekim 2026
**Durum:** Kabul edildi. 0047'nin 3. maddesini (yalnızca günlük 10 hak) değiştirir;
0047'nin geri kalanı (ayır → kesinleştir/iade, bonus defteri, tek aktif arama,
oran sınırı) aynen geçerlidir.

## Karar

Kullanıcı kotalarının tek kaynağı `packages/core/src/quota/policy.ts`. Dört pencere,
hepsi Europe/Istanbul takvimine bağlı (saat başı, gece 00:00, pazartesi 00:00, ayın
1'i 00:00); kayan pencere değil.

| Havuz | Ne harcar | Saat | Gün | Hafta | Ay | Depo |
|---|---|---|---|---|---|---|
| `search_rights` | Fotoğrafla arama; link araması açıldığında o da | 10 | 30 | 120 | 350 | PostgreSQL |
| `chat_message` | Yazılan her sohbet mesajı (metin, seçenek, atla) | 20 | 60 | 300 | 900 | Redis |
| `realtime_interpretation_user` | Gerçek anlık Gemini çağrısı, girişli | 30 | 100 | 400 | 1000 | Redis |
| `realtime_interpretation_anonymous` | Gerçek anlık Gemini çağrısı, anonim (IP özeti) | 30 | 60 | 200 | 500 | Redis |

1. **Arama hakkı PostgreSQL'de kalır** (0047'nin reddettiği "yalnızca Redis"
   gerekçeleri geçerli: iade, bonus, kalıcılık). Gün `ai_quota_day.used`; saat, hafta,
   ay `ai_search_charge`'tan (iade edilenler hariç) aynı işlemde, kilitlerden sonra
   sayılır. Aynı kullanıcının ayırmaları gün satırı kilidi ve tek-aktif-arama
   indeksiyle sıralı olduğundan sayım atomiktir. **Migration gerekmez.**
2. **Bonus** gün/hafta/ay dolunca harcanır; saatlik sınır bir patlama sınırıdır ve
   bonusla aşılmaz. Saatlik sınır bonusla harcananları da sayar.
3. **Sohbet ve anlık yorum Redis'te**, tek Lua betiğiyle: dört pencere ya hep birlikte
   artar ya hiç; reddedilen istek hiçbir pencereyi yakmaz. Anahtar
   `quota:<havuz>:<pencere>:<dönem>:<özne>`, dönem sonu + 1 saat yaşar. Her istekte
   veritabanına yazılmaz.
4. **Ne zaman harcanır:** fotoğraf — hak ayrılınca (sağlayıcı hatası iade edilir);
   sohbet — mesaj gerçekten yazılacağı an (tekrar, meşgul, dolu, geçersiz girdi
   harcamaz; yazma hatası geri verir); anlık yorum — yalnızca model çağrılacağı an
   (bayrak kapalı, süzgeç, saklanan yorum, günlük toplam tavan harcamaz).
5. **Limit dolunca:** anlık yorum sessizce deterministik aramaya düşer; fotoğraf
   dolan pencerenin metnini gösterir; sohbet "sınırına ulaştın" der ve doğrudan
   aramayı önerir (ilk mesaj zaten düz aramaya yönlenir).
6. **Redis erişilemezse:** anlık yorum modeli çağırmaz (değişmedi); sohbet bugünkü
   DB saatlik sayımına düşer (kesilmez); fotoğraf/link oran sınırı fail-closed kalır.
7. **Ayrı kalanlar:** sağlayıcı günlük tavanları (`REALTIME_INTERPRETATION_DAILY_CALL_CAP`,
   `CHAT_DAILY_CALL_CAP`), kötüye kullanım oran sınırı (`AI_SEARCH_RATE_LIMITS`:
   dakikada 3, saatte 10 deneme), sohbet başına 60 mesaj, giriş duvarı. Hiçbiri
   gevşetilmedi.
8. **Arayüz:** rozet tek satır kalır — en kısıtlayıcı pencere ("Bugün kalan 27/30",
   gerekirse "Bu hafta kalan …"); dört sayı birden gösterilmez.

## Reddedilen alternatifler

- **Yeni `ai_quota_period` tablosu:** daha açık ama migration ve geçiş adımı ister;
  mevcut satırlar ve indeks aynı sonucu verir.
- **Arama hakkını da Redis'e taşımak:** 0047'deki gerekçelerle reddedildi.
- **Pencereleri ayrı ayrı `INCR` etmek:** saatlik sınıra takılan istek yine de
  günlük/aylık sayacı artırırdı; Lua betiği bunu önler.
- **Dört pencereyi arayüzde birlikte göstermek:** karmaşık; backend hepsini uygular.
