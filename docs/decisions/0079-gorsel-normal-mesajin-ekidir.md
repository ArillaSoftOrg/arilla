# 0079 — Görsel, normal sohbet mesajının ekidir (tek gönderim hattı)

**Tarih:** 8 Ekim 2026
**Durum:** Kabul edildi; kod aşamalı geliyor. `CHAT_IMAGE_ENABLED` kapalı kalır,
hukuk onayı (0078 "Etkinleştirme koşulu") bu kararla değişmedi.

0078 görseli sohbete taşıdı ama ana sayfadaki görselli gönderimi metinden ayrı bir
yola koydu: aynı sekmede, kabuksuz, ayrı eylemle (`startConversationWithImageAction`),
ayrı loading/hata metniyle. Bayrak kapalı ya da kullanıcı anonimken ise "+" hâlâ
eski `/ara/gorsel` aramasına düşüyordu. Ürün kararı: **görsel için ayrı kullanıcı
akışı yoktur.** Görsel, normal mesajın ekidir; yalnızca mesajın içeriği değişir.
Bu karar 0078'in madde 1 (aynı sekme), madde 3 (her turda yeniden ekleme) ve
"Reddedilen alternatifler"deki özet maddesini değiştirir; diğer maddeleri korur.

## Karar

1. **Tek mesaj modeli, tek hat.** Mesaj `text`, `image` ya da `text+image`dir (en az
   biri dolu). Üçü de metnin bugünkü yolundan geçer: ana sayfada `openChatInNewTab`
   → yeni sekmede `/sohbet/yeni` kabuğu → `startChatBootstrapAction` →
   `router.replace('/sohbet/<id>')`; sohbet içinde `sendMessageAction` →
   `router.refresh()` → `runTurn`/`waitForTurn`. Aynı route, geçiş, kabuk, loading,
   hata/"Tekrar dene" ve idempotency (`requestKey`). `startConversationWithImageAction`
   kaldırılır. Metin-only davranışı değişmez.
2. **Gönderim semantiği tek.** Enter ve Gönder düğmesi aynı `submit()`; dosya seçmek
   göndermez; boş (metin ve görsel yok) gönderim işlem yapmaz; seçimde yazılı metin
   korunur. Ana sayfa girdisi tek satırlı kalır, sohbet içi alan çok satırlı (Shift+Enter) kalır.
3. **Yeni sekmeye görsel: IndexedDB + Blob.** Metin kaydı `localStorage`'da bugünkü
   gibi kalır (kapı kaydı); görsel `localStorage`'a (binary ya da base64) yazılmaz.
   Görsel, aynı nonce anahtarıyla IndexedDB'ye `Blob` olarak yazılır: tek kullanımlık,
   en fazla 60 sn yaşar, süresi dolan kayıtlar her açılışta süpürülür, sunucu teslim
   aldığında (action yanıt verdiğinde) silinir. Sunucu tek doğruluk kaynağıdır:
   doğrulama ve `preprocessImage` (≤512 px, EXIF'siz) orada yapılır; istemcide
   yeniden kodlama yoktur.
4. **IndexedDB yoksa güvenli fallback.** Görselli mesaj aynı sekmede, aynı sunucu
   eylemi (`startChatBootstrapAction`) ile gönderilir, başarıda `router.push`
   `/sohbet/<id>`; yani yine normal sohbet, asla `/ara/gorsel`. Hata durumunda
   kutu metni ve görseli korur ve hata gösterir; mesaj sessizce kaybolmaz.
   (Metin-only için mevcut davranış korunur.)
5. **Sohbet içi görsel aynı konuşmaya eklenir.** Yeni konuşma, yeni sekme ya da ayrı
   ekran açılmaz. `chat_attachment` konuşma başına birden çok satırı destekler
   (tekil kısıt yok; migration gerekmez). Mesaj `payload.attachmentId` ile bağlanır.
   Konuşma başına en fazla 5 görsel (`CHAT_ATTACHMENTS_PER_CONVERSATION`, kod sabiti).
6. **Bağlam: yapılandırılmış özet.** Model çıktısına zorunlu-nullable `image_summary`
   (kısa, ürün odaklı) eklenir ve asistan mesajının `payload`'ına yazılır (kural 3:
   AI çıktısı bir kez üretilir, saklanır). Takip turlarında bağlama görselin kendisi
   değil, o özet girer. Görsel **kontrollü** yeniden eklenir, yalnızca şu durumlarda
   ve yalnızca *en son* görselli kullanıcı mesajı için: (a) o görselin özeti yoksa
   (tur hata/yedek yola düştü), (b) kullanıcı mesajı görsele açıkça atıf yapıyorsa
   (belirlenimci Türkçe sözlük: fotoğraf, görsel, resim, "bunun/şunun", "buna benzer"
   vb.). Ek çağrı yoktur: yeniden analiz aynı turun tek çağrısına görsel eklemektir;
   tur başına yine tek çağrı, tavanlar aynı. Yeni görsel gelince "en son ilgili görsel"
   o olur. Bu, 0078/3'ün "her turda yeniden ekle" kararının yerine geçer.
7. **Bayrak ve eski akış.** `CHAT_IMAGE_ENABLED` (ve sohbet bayrağı) kapalıysa ya da
   kullanıcı oturumsuzsa "+" **gizlenir**; eski `/ara/gorsel` akışına hiçbir koşulda
   fallback yoktur. Sunucu eylemleri savunma derinliği olarak `unavailable` döner.
   `/ara/gorsel` sayfası kalıcı yönlendirmeye (`/`) çevrilir; `PhotoSearchButton`
   `/ara` ve `/ara/link`'ten kaldırılır. **Backend silinmez:** `searchByImageVector`
   (link araması kullanır), `preprocessImage`, `runChargedVisualSearch`,
   `embedUploadedImage`, `image_upload` ve yönetim okumaları kalır.
8. **Kota ve limitler değişmez.** Görselli mesaj = 1 sohbet turu (saatlik kullanıcı
   tavanı, sohbet başına 60 mesaj, günlük sağlayıcı tavanı, her deneme `api_usage`);
   arama hakkı (0047) harcanmaz. Görsel seçmek/önizlemek/kaldırmak sunucuya hiçbir
   şey göndermez. Aynı `requestKey` yeniden denemesi yeni model çağrısı üretmez.
9. **İş mantığı `packages/core`'da** (kural 6): görsel doğrulama + ön işleme +
   hata kodları `chat/submission.ts`'e taşınır; `apps/web` ince kalır.

## Gerekçe

Tek hat; bir davranış düzeltmesi iki yere yazılmaz, metin sohbetinin
performans/hata davranışı (0076) görselli mesajda da geçerlidir. Özet bağlamı,
her turda görsel token'ı ve gecikmesi ödemeyi bırakır; multimodal yetenek ilk
turda ve atıf durumunda tam kalır.

## Reddedilen alternatifler

- **Görsel için ayrı akış/rota/ekran/loading.** Ürün kararına aykırı.
- **Görseli `localStorage`'a (base64) yazmak.** Kota ≈5 MB; 4 MB dosya aşar (0078 ile aynı).
- **İstemcide canvas ile küçültüp taşımak.** Sunucu `preprocessImage` ile ikinci bir
  görüntü işleme kaynağı yaratır.
- **Seçince sunucuya yüklemek.** Gönderilmemiş fotoğraf sunucuya gider (KVKK) ve
  terk edilmiş yüklemeler için temizlik gerekir.
- **Atıf için ikinci model çağrısı ("görsel lazım mı?").** Tur başına tek çağrı
  kuralını (kural 1) ve maliyeti bozar.
- **Her turda görsel yeniden eklemek.** 0078/3; token ve gecikme.
