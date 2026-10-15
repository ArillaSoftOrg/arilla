# 0108 — Link araması herkese açılıyor

**Tarih:** 12 Ekim 2026
**Durum:** Kabul edildi. `LINK_SEARCH_PUBLIC` sabiti `true`; 0035 ve 0090'daki
"arayüz QA'sı tamamlanana kadar Yakında" kapısını kaldırır. Taşıma katmanı 0107'dir.

## Karar

1. `/ara/link` ve ana sayfadaki link yolu açılır. Hesap/ürün kapısı
   (`requireProductAccess`) ve arama hakkı (0047: link + fotoğraf aynı havuz) aynen kalır;
   hesapsız kullanıcı kuyruğa istek açamaz (`login_required`).
2. Sabit geri alma anahtarı olarak kalır: `false` yapılırsa rota "Yakında" döner ve yeni
   istek kuyruğa alınmaz (kod ve bileşen korunur).
3. Açılış önkoşulları (üretimde sağlanmış olmalı): Vercel Services düzeni, Python abonesi
   (`services/link/_py_subscribers/collect-link-subscriber`), `LINK_QUEUE_BACKEND=vercel`.
   Çalışmıyorsa istekler 2 dakika sonra ölü sayılır ve kullanıcı hata durumunu görür.
4. Değişmeyenler: SSRF koruması, URL doğrulama, "aynı ürün ≠ benzer ürün", 0.72 görsel
   tabanı, `api_usage`, sohbet link yolu (`CHAT_LINK_ENABLED`), internet araması bayrakları.

## Doğrulama durumu

Kod ve birim/entegrasyon testleri tamdır. Gerçek üretim kuyruğu → abone → veritabanı akışı
açılıştan sonra, giriş yapmış bir hesapla gerçek bir mağaza linkiyle doğrulanır; kayıt
`link_resolution_request` (status/error_code) ve Vercel abone günlüklerinden izlenir.
