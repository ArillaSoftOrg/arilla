# 0059 — Gemini ile çevrimdışı sorgu yorumlama

**Tarih:** 5 Ekim 2026
**Durum:** Kabul edildi — istemci, uyarlayıcı, saklama (0044), toplu iş,
korumalı (zamanlanmamış) cron ucu ve `/ara` salt okuma yolu hazır. Üretimde
etkin DEĞİL (anahtar yok; tabloda satır yok).

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

## Uygulama ayrıntıları

- **Saklama:** `query_interpretation` (migration 0044), kimlik UNIQUE
  `(query_norm, taxonomy_hash, model_version)`. `taxonomy_hash` modele giden
  sözleşmenin (taksonomi kimlik+etiket, JSON şeması, talimatlar) SHA-256
  özetidir; biri değişince sorgu yeniden yorumlanabilir. Durum `accepted`
  (doğrulanmış yorum), `empty` (model geçerli biçimde bir şey bulamadı),
  `invalid` (her alan reddedildi ya da çıktı kullanılamaz: kesik/JSON değil).
  `invalid` de saklanır: aynı sürümde tekrar ödenmez. Geçici sağlayıcı hatası
  (zaman aşımı, ağ, 429, 5xx, 401/403, diğer 4xx) satır yazmaz.
- **Aday:** `search_query_day` son 30 gün, toplam en az 3 arama; ek kişisel
  veri/kimlik/sır süzgeci (`interpretation-eligibility.ts`); deterministik
  netleştirme domain bulamamış olmalı (0030). Sıra: arama sayısı azalan, sonra
  metin.
- **Muhasebe:** istemci her HTTP denemesini (yeniden denemeler dahil) bir
  `LlmCall` kaydı olarak bildirir; her biri için bir `api_usage` satırı
  (`operation = 'query_interpretation'`, `units` = toplam token, kimlik NULL),
  sorgu sonucuyla aynı işlemde. `cost_micros` şimdilik 0 (fiyat oranı yok).
- **Sınırlar:** koşu başına 20 sorgu, 35 sn'den sonra yeni sorgu yok, istemci
  10 sn × 2 deneme; 401/403/4xx/429'da koşu durur; aynı anda tek koşu
  (yakın zamanda başlamış `running` `job_run` varsa atlanır). Ortam değişkeni
  eklenmedi.
- **`job_run`:** `query_interpretation`. 0041'de `skipped` durumu olmadığından
  atlanan koşu `success` + `detail.skipped = true` ile yazılır. Ayrıntı
  yalnızca sayı ve sabit koddur.

- **`/ara` okuma yolu:** `planConversationWithStoredInterpretation`
  (`conversational-search/stored-plan.ts`). Deterministik çıkarıcı ilk turda
  domain bulursa okuma yapılmaz. Bulamazsa `readStoredInterpretation`
  (`search/stored-interpretation.ts`) kimliği (normalize sorgu, bugünkü
  özet, bugünkü model) ile yalnızca `accepted` satırı okur, satırı bugünkü
  taksonomiye ve sorgu metnine karşı `validateInterpretation` ile yeniden
  doğrular (tek alan bile reddedilirse satır yok sayılır) ve
  `replayConversation` onu ilk girdiden hemen sonra `applyInterpretation` ile
  en düşük öncelikte uygular; URL'deki sonraki cevaplar onu ezer. Eski özet
  ya da eski model satırına düşülmez. Okuma hatası aramayı durdurmaz. Okuma
  modülü sağlayıcı istemcisini yüklemez (model kimliği `llm/model.ts`).
- **Dağıtım sırası:** 0044 üretimde uygulanmadan bu kod dağıtılmaz
  (docs/ops.md).

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
