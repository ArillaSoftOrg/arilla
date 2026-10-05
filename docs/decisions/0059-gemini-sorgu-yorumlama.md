# 0059 — Gemini ile çevrimdışı sorgu yorumlama

**Tarih:** 5 Ekim 2026
**Durum:** Kabul edildi — istemci ve yorumlayıcı uyarlayıcısı hazır; saklama,
toplu iş ve `/ara` okuma yolu ayrı adımlar. Üretimde etkin DEĞİL.

Karar 0030, `IntentInterpreter`'ın bir modele bağlanmasını ayrı bir karara
bırakmıştı. Bu karar o bağlantının sınırlarını koyar. İlk sağlayıcı Google
Gemini, model `gemini-3.1-flash-lite` (kararlı sürüm).

## Karar

1. **Yalnızca çevrimdışı toplu iş.** Gemini kullanıcı isteği sırasında hiçbir
   koşulda çağrılmaz. CLAUDE.md kural 1 değişmez; görsel embedding tek
   istisna olarak kalır.
2. **Mevcut sınır yeniden kullanılır.** Model, `IntentInterpreter`
   (`packages/core/src/clarification/interpreter.ts`) arkasında çalışır.
   Taksonomi özeti, katı JSON şeması, talimatlar ve `validateInterpretation`
   aynen kullanılır; model yeni kimlik, ürün, fiyat, marka ya da stok
   üretemez. Model çıktısı `unknown`dır ve doğrulamadan geçmeden hiçbir yere
   yazılmaz. Metinde yazmayan bütçe sayısı reddedilir.
3. **Her kabul edilen sonuç saklanır** (kural 3). Arama isteği yalnızca daha
   önce saklanmış, doğrulanmış yorumu okur; aynı sorgu ikinci kez modele
   gitmez. Saklama tablosu ayrı bir migration ile gelir.
4. **Her gerçek model çağrısı `api_usage`'a yazılır** (kural 9). İstemci
   token kullanımını yanıttan ayrı döndürür; kaydı toplu iş yazar.
5. **Gemini hatası aramayı asla engellemez.** Sağlayıcı yoksa, zaman aşımına
   uğrarsa ya da geçersiz çıktı verirse yorum saklanmaz; arama bugünkü
   deterministik yolla aynen çalışır.
6. **Modele yalnızca toplu, uygun sorgu metni gider.** Kaynak, kullanıcıdan
   bağımsız toplu sorgu özetidir. `user_id`, `session_id`, oturum, IP,
   `user_activity_event` ya da başka bir kişisel kayıt modele gönderilmez.
   Uygunluk eşiği (en az kaç kez görülmüş olmalı, e-posta/telefon/kimlik
   numarası kalıbı taşıyan sorgunun dışlanması) toplu işle birlikte
   tanımlanır.
7. **Sağlayıcı sınırı.** Doğrudan HTTP, resmî Interactions API'nin kararlı
   sürümü (`POST https://generativelanguage.googleapis.com/v1/interactions`;
   v1beta değil), `store: false` (Google varsayılan olarak etkileşimi
   saklar). Anahtar
   yalnızca sunucu ortamından okunur (`GEMINI_API_KEY`), istek başlığında
   gider, tarayıcıya ve `NEXT_PUBLIC_` değişkenine asla girmez. Model kod
   sabitidir; değiştirmek incelenen bir kod değişikliğidir. Hata mesajları
   anahtar, istem, sorgu metni ya da yanıt gövdesi taşımaz.
   `generation_config.thinking_level: "minimal"` (küçük, kapalı uçlu bir
   sınıflandırma; düşünme çıktı fiyatıyla ücretlenir); `temperature`
   gönderilmez. Yalnızca `status: "completed"` kabul edilir;
   `max_output_tokens`'a takılan `incomplete` yanıt reddedilir, kesik çıktı
   asla saklanmaz.
8. **Üretimde etkinleştirme engellidir.** Kullanıcının yazdığı sorgu metni
   yurt dışındaki bir sağlayıcıya gider; bu yeni bir yurt dışı aktarımdır
   (docs/kvkk.md "Yurt dışına aktarım"). Sağlayıcı sözleşmesi, aydınlatma
   metni güncellemesi ve ücretli katman anahtarı (ücretsiz katmanda içerik
   ürün geliştirmede kullanılabilir) açıkça onaylanmadan üretimde anahtar
   tanımlanmaz. Etkinleştirme ayrı ve sonraki bir adımdır.

## Reddedilen alternatifler

- **İstek yolunda model çağrısı.** Kural 1'i bozar; maliyet kullanıcı
  sayısıyla ölçeklenir, gecikme ve sağlayıcı arızası aramaya yansır.
- **Resmî SDK (`@google/genai`).** Tek uç nokta ve tek istek biçimi için
  `google-auth-library`, `ws` ve `protobufjs` bağımlılığı getirir; Jina
  istemcisindeki doğrudan HTTP deseni yeterli ve test için `fetch`
  enjeksiyonu daha basit.
- **`generateContent` uç noktası.** Google tarafından "legacy" olarak
  işaretli (tamamen destekleniyor); yeni projeler için Interactions API
  öneriliyor.
- **Toplu işi Python'da yazmak.** Şema, taksonomi ve doğrulama TypeScript
  çekirdekte; Python'da ikinci bir kopya iki doğrulayıcının ayrışması
  demektir.
