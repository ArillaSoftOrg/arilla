# 0046 — Arama hakkı: günlük hak, bonus hak ve davet

**Tarih:** 30 Eylül 2026
**Durum:** Kabul edildi

Fotoğrafla arama (görsel embedding) ve link araması (dış sayfa getirme +
çoğu zaman embedding) gerçek para maliyeti taşır (0015). Şimdiye kadar
ikisinin de tek sınırı Redis'te sabit pencereli bir günlük sayaçtı
(`VISUAL_SEARCH_DAILY_LIMIT_PER_USER`, `LINK_SEARCH_DAILY_LIMIT_PER_USER`):
kalıcı değil, iade yok, bonus yok, oturuma göre de sayılabiliyor. Bu karar
onları PostgreSQL'de tutulan kalıcı bir hak modeliyle değiştirir.

## Karar

1. **Neyi harcar:** yalnızca fotoğrafla arama ve link araması. Metin ve
   konuşmalı arama (`/ara`) ücretsizdir; istek yolunda model çağrısı yoktur
   (CLAUDE.md kural 1). Maliyet sunucuda sabittir
   (`entitlement/config.ts`, V1'de ikisi de 1); istemciden gelen hiçbir
   maliyet, sayı veya ödül değerine güvenilmez.
2. **Giriş gerekir:** fotoğraf ve link araması hesap ister. Anonim ziyaretçi
   giriş modalını görür (0002 `/ara` için modale izin verir).
3. **Günlük hak:** kullanıcı başına günde 10, gün sınırı Europe/Istanbul
   00:00. Kullanılmayan hak birikmez. Satır `(user_id, day)` anahtarıyla ilk
   kullanımda açılır; gece sıfırlama işi yoktur. Gün SQL içinde
   `(now() AT TIME ZONE 'Europe/Istanbul')::date` ile hesaplanır.
4. **Bonus hak:** günlük haktan ayrı, sıfırlanmayan bakiye. Önce günlük hak,
   bitince bonus harcanır. Bakiye en fazla 100; ödül bu tavana kırpılır, iade
   kırpılmaz (yalnızca alınanı geri verir). Her değişiklik append-only
   `bonus_ledger`'a benzersiz bir `idempotency_key` ile yazılır.
5. **Ayır → kesinleştir / iade:** pahalı çağrıdan önce tek işlemde hak ayrılır
   (`ai_search_charge.state = 'reserved'`). Başarı `settled`, sonuç
   üretmeyen sağlayıcı/iç hata `refunded`. Geçişler koşullu UPDATE
   (`WHERE state = 'reserved'`) ile tam bir kezdir.
   - Fotoğraf: sağlayıcı çağrısı başarılıysa sıfır sonuç da hak harcar;
     embedding önbellek isabeti de bir haktır.
   - Link: yalnızca YENİ bir çözümleme işi hak harcar; önbellekteki ya da
     hâlâ işlenen aynı link ücretsizdir (0035). `resolved` → kesinleşir,
     `failed` → iade, kuyruğa yazılamadı → hemen iade.
6. **Eşzamanlılık:** kullanıcı başına en fazla bir `reserved` arama —
   kısmi UNIQUE indeks (`WHERE state = 'reserved'`), Redis kilidi değil.
   Aynı istek anahtarı (`request_key`) ikinci kez gelirse yeni hak alınmaz.
   CHECK kısıtları bakiyenin eksiye, günlük kullanımın limitin üstüne
   çıkmasını motor düzeyinde engeller.
7. **Oran sınırı:** kullanıcı başına dakikada 3, saatte 10 pahalı arama
   isteği (Redis, `redis/counter.ts`). Redis erişilemezse pahalı arama
   yapılmaz (fail-closed).
8. **Link süpürmesi durum bilgilidir:** yaş tek başına iade sebebi değildir.
   Süpürme bağlı `link_resolution_request`'e bakar: `resolved` →
   kesinleştir, `failed` → iade, `queued`/`processing` ve
   `IN_FLIGHT_TTL_MS`'ten eski (mevcut "ölü iş" politikası; üzerine yeni istek
   açılabilen iş) → iade. Ölü sayılıp iade edilen iş sonradan çözülürse
   kullanıcı sonucu ücretsiz almış olur; hak iki kez hareket etmez. Tembel
   çalışır: durum sorgusunda, kullanıcının bir sonraki aramasında ve günlük
   `cleanup-auth` cron'unda (Vercel cron'ları günlük).
9. **Davet:** `/davet/<kod>` httpOnly çerez yazar; YENİ hesap açan girişte
   davet kaydı `pending` olarak bağlanır. Davet edilen kullanıcının ilk
   kesinleşen (hak harcayan) aramasında, aynı işlemde `qualified` olur:
   davet eden +10, davet edilen +5. Kendi kendini davet ve ikinci kez
   nitelenme kısıtlarla engellenir (`UNIQUE (invitee_user_id)`, koşullu
   UPDATE, benzersiz ödül anahtarları).
10. **İlk geri bildirim ödülü:** +3, kullanıcı başına bir kez
    (`feedback_first:<user_id>`). Geri bildirim sistemi (0045) ana dala
    girdiğinde bağlanır; bu karar o bağlantının kuralını tanımlar.
11. **Gizlilik:** hesap silinince hak, harcama, bonus defteri ve davet
    kayıtları silinir (davet eden silinirse davet satırındaki bağlantısı
    NULL'a çekilir). Silme sonrası sağlayıcı kimliğinin özeti **tutulmaz**.
    Kabul edilen risk: hesabını silip aynı Google/Apple hesabıyla yeniden
    açan biri yeniden davet edilebilir ve ilk geri bildirim ödülünü yeniden
    alabilir. Etkisi tavanla sınırlıdır (100); süresiz takma adlı dolandırıcılık
    saklaması ayrı bir politika ve hukuki dayanak olmadan eklenmez.
12. **E-posta yok:** V1'de hak bittiğinde e-posta gönderilmez; pazarlama/izin
    çalışması ayrı yürütülür.
13. **Terim:** arayüzde "arama hakkı" ve "bonus hak"; "coin", "kredi",
    "satın al" kullanılmaz.

## Reddedilen alternatifler

- **Yalnızca Redis sayaçları:** kalıcı değil, iade ve bonus tutamaz,
  failover'da sıfırlanabilir.
- **Gece sıfırlama işi:** `(user_id, day)` satırı bunu gereksiz kılar; tek
  bir işin gecikmesi herkesin hakkını bozardı.
- **Redis ile tek aktif arama kilidi:** TTL dolumu ya da failover'da
  delinebilir; kısmi UNIQUE indeks atomik ve kalıcı.
- **Yaşa göre iade:** hâlâ çalışan ya da çözülmüş bir link işini iade ederdi.
- **Silme sonrası kimlik HMAC'i:** yeniden kayıt suistimalini engellerdi ama
  süresiz takma adlı veri saklaması demek; V1 için kabul edilmedi.
- **Metin aramasını ücretlendirmek:** model çağrısı yok ve GET render'ı
  sayfalama/önceden getirme ile tekrarlanır; idempotent ücretlendirilemez.
