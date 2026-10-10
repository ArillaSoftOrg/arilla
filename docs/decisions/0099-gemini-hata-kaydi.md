# 0099 — Gemini hata kaydı

**Tarih:** 10 Ekim 2026 · **Durum:** kabul edildi · **Bağımlılık:** #85 → #87 → #88 → #90 (0096 tabloları).

## Karar
Gemini çağrı sonuçları `ai_error_event`'e yazılır. Migration yok.

- **Kapsam:** sohbet turu (`chat_turn`, yüzey `chat`), toplu ve anlık sorgu yorumu
  (`persistOutcome` ortak yolu, yüzey `search`). Yeni model çağrısı yok.
- **Tek olay:** sonuç başına bir kayıt; yeniden denemeler `api_usage`'ta ayrı satır
  kalır, hata olayı son sonucu ve son denemenin HTTP durumunu taşır. `api_usage_id`
  son denemenin satırına bağlanır.
- **Sınıflar:** timeout, rate_limited, auth, bad_request, server_error, network,
  schema_invalid (geçersiz JSON, biçimsiz yanıt, alan doğrulama reddi),
  empty_output (kesik çıktı), safety_blocked (sağlayıcı durum değeri SAFETY/BLOCK
  içeriyorsa), unknown.
- **Güvenli:** işlem tamamlandıktan SONRA, 1,5 sn sınırlı, asla fırlatmaz; yazma
  başarısız/yavaşsa kullanıcı akışı etkilenmez. Hata olmayan yolda ek sorgu yok.
- **Gizlilik:** prompt, sohbet, kullanıcı/oturum kimliği yok; özet yalnızca sabit
  `llm: kod (HTTP n) [durum]` biçimidir.
- Sonuç tiplerine yalnızca isteğe bağlı `errorDetail` / `modelError` alanları
  eklendi (doluysa); davranış değişmedi.

## Bilinen sınırlar
- Sohbette model yanıtı hiç gelmeden önce atlanan turlar (süzgeç, günlük tavan) hata
  değildir ve kaydedilmez.
- Gecikme (`latency_ms`) çağrı sonucunda ölçülmediği için boştur.
- Jina, retention ve regresyon uyarıları bu karara dahil değildir.
