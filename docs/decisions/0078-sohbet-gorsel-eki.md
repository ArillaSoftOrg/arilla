# 0078 — Sohbet görsel eki

**Tarih:** 8 Ekim 2026
**Durum:** Kabul edildi, kod hazır; `CHAT_IMAGE_ENABLED=true` verilene kadar kapalı.
Hukuk onayı (aşağıda) gelmeden açılmaz.

Ana sayfada fotoğraf seçmek eskiden anında `/ara/gorsel` embedding aramasına gidiyordu
(karar 0034/0047) ve sohbetle ilgisi yoktu. Ürün kararı: fotoğraf, kutudaki metinle
birlikte TEK kullanıcı mesajı olarak sohbete girer; Gemini görseli gerçekten görür ve
konuşma buradan sürer. Bu, CLAUDE.md kural 1 ve 10'a dar bir istisnadır; ikisi bu
kararla birlikte güncellendi.

## Karar

1. **Gönderim anı.** Fotoğraf seçmek hiçbir şey göndermez; kutuda önizleme olur
   (kaldır/değiştir). Enter ya da Gönder: metin + görsel tek sunucu eylemiyle
   (`startChatWithImageAction`, FormData) gider. Sohbet, ek ve ilk mesaj TEK
   işlemde yazılır; sonra `/sohbet/[id]` açılır. Seçili dosya ana sayfa kutusunun
   bileşen durumundadır; rota değişimi gönderimle birlikte olur, yani kaybolacak
   bir ara durum yoktur. Görselli akış aynı sekmede ilerler (yeni sekme akışı
   localStorage ile bayt taşımaz; 4 MB'lık dosya kotayı aşar).
2. **Ek, sohbetin parçasıdır.** `chat_attachment` (0057): `preprocessImage` çıktısı
   (≤512 px, EXIF/GPS'siz, ≤512 KB) BYTEA olarak. Obje deposu (R2) kovası herkese
   açık olduğundan kullanılmadı. Mesaj `payload.attachmentId` ile bağlanır. Sohbet
   silinince (90 gün cron'u, hesap silme) CASCADE ile gider. Yalnızca sahibine,
   `/sohbet/gorsel/[id]` rotasından, `private, no-store` ile sunulur.
3. **Gemini çok kipli girdi.** `LlmClient.generateJson` `images` alır; Interactions
   API `input` dizisi: `[{type:"text"}, {type:"image", data, mime_type}]`. Görsel,
   bağlam penceresindeki (son 12 mesaj) ilk görselli kullanıcı mesajı için her turda
   yeniden eklenir; model "sonraki mesaj" turunda da görseli görür. Maliyet: tek
   küçük karo. Her HTTP denemesi yine `api_usage`'a yazılır (kural 9).
4. **Model yine yalnızca niyet çıkarır.** Görselden ürün, fiyat, marka kataloğu
   üretmez; emin olmadığını söyler ve `clarify` sorar. Kişi, yüz, kimlik, belge
   görürse tanımlamaz, yalnızca ürünü konuşur; ürün yoksa `clarify`.
5. **Dead-end yok.** Model hatası/filtre/tavan: görselli ve metinsiz mesaj için
   deterministik `clarify` ("Hangi ürünü arıyorsun?", kategori seçenekleri);
   metinli mesajda metinle arama. Sonuç bulunamayınca sonuç bloğu soruyu sohbetle
   sürdürmeye çağırır (renk, marka, bütçe); kutu açık kalır.
6. **Embedding araması sohbette çalışmaz.** Arama hakkı harcayan `runChargedVisualSearch`
   (0047) sohbet turunda çağrılmaz: sohbet turları hak harcamaz (0074). Görseli
   Gemini niyete çevirir; ürünler yine yalnızca mevcut metin arama katmanından gelir.
   Görsel-benzerlik sohbet içinde istenirse ayrı karar.
7. **Çift gönderim.** İstemcide tek-uçuş kilidi + `requestKey`; sunucuda
   `UNIQUE (conversation_id, client_request_id)` ve saatlik kullanıcı tavanı.
   Görselli oluşturma da `createConversation`'ın aynı tavanından geçer.
8. **Süzgeç.** Görsel 0059 metin süzgecinden geçemez. Metin süzgeçten geçmezse
   (`isBlockedFromModel`) görsel de modele GİTMEZ; yedek yol çalışır.

## Etkinleştirme koşulu

0074'ün hukuk onayı yalnızca metin içindi. Burada kullanıcının fotoğrafı, kimliğe
bağlı olarak, Google'a gider; sohbet ömrü (90 gün) `docs/kvkk.md`'deki 30 günlük
görsel saklamadan uzundur ve KVKK notundaki "yüz bölgesi hiçbir modele ayrıca
beslenmez" ilkesi tam görüntü için model tarafında yalnızca talimatla sağlanır
(yüz tespiti yok). Hukuk onayı, aydınlatma/gizlilik metni güncellemesi ve açık rıza
metni tamamlanmadan `CHAT_IMAGE_ENABLED` açılmaz.

## Reddedilen alternatifler

- **Görseli localStorage ile yeni sekmeye taşımak.** Kota (≈5 MB) ve base64 şişmesi.
- **R2'ye yüklemek.** Kova herkese açık; kişisel fotoğraf için uygun değil.
- **Her turda görsel yerine yalnızca model özeti saklamak.** Kullanıcıya "gerçek
  çok kipli bağlam" vaat edilmedi; özet kayıpsız değil. Maliyet küçük olduğundan
  görsel yeniden eklenir.
- **Sohbet turunda `runChargedVisualSearch`.** Hak muhasebesi sohbetle uyuşmaz (madde 6).
