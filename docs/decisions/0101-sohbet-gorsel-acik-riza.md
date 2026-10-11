# 0101 — Sohbet görsel eki için açık rıza kapısı

**Tarih:** 11 Ekim 2026
**Durum:** Kabul edildi; kod bu kararla geliyor. `CHAT_IMAGE_ENABLED` **kapalı kalır**.
Hukuk onayı verilmiş değildir; bu karar onay yerine geçmez.

0078/0091 görseli sohbetin normal eki yaptı ve "açık rıza + aydınlatma metni olmadan
production'da açılmaz" şartını koydu (`docs/ops.md`, `docs/kvkk.md`). Bu karar şartın
**teknik** yarısını (rıza mekanizması) uygular. Hukuki yarısı (metin, aktarım dayanağı) açıktır.

## Karar

1. **Rıza türü:** `user_consent.kind = 'chat_image'`, `source = 'chat_image_prompt'`
   (geri çekme: `account_settings`). Migration 0063 yalnızca iki CHECK'i genişletir.
2. **Sunucu kapısı tek gerçek kapıdır.** `sendMessageAction` ve `startChatBootstrapAction`,
   görsel varsa `prepareChatImage`'den ÖNCE `hasChatImageConsent` bakar; rıza yoksa
   `consent_required` döner, görsel işlenmez, mesaj/sohbet oluşmaz. Metin-only mesaj etkilenmez.
3. **İstemci yalnızca bilgilendirir ve karar anını sağlar.** Dosya seçilince, rıza yoksa
   dosya yalnızca bellekte bekler (sunucuya, IndexedDB'ye, `localStorage`'a hiçbir şey yazılmaz)
   ve bilgilendirme penceresi açılır. Onay kutusu yoktur, hiçbir şey önceden seçili değildir,
   kabul ve ret eşit görsel ağırlıkta iki düğmedir; Esc/kapat = ret (kayıt yazılmaz).
   Ret sohbeti engellemez; metinle devam edilir.
4. **Metin sürümü:** `CHAT_IMAGE_CONSENT_VERSION`. Pencere metni değişince sürüm değişir ve
   eski sürüme verilmiş rıza geçersiz sayılır (yeniden sorulur).
5. **Geri çekme:** `/hesap/gizlilik` (bayraktan bağımsız, yalnız geçerli rıza varsa görünür).
   Geri çekme yeni görsel eklemeyi durdurur; mevcut sohbet görselleri sohbetle birlikte gider
   (90 gün / hesap silme). Anında silme **yapılmaz** (kullanıcı sohbet silme özelliği yok).
6. **IP yazılmaz** (`ip = NULL`); gerekçe: amaç için gerekmez.

## Pencerede yazan şey = kodun yaptığı şey

Cihazdan çıkış yalnızca Gönder ile; sunucuda ≤512 px ve EXIF'siz; Google Gemini'ye gönderilir
(yurt dışı aktarım olabilir); sohbetle birlikte saklanır, yalnız sahibine görünür, en geç 90 gün
ya da hesap silinince silinir; başkası/kimlik içeren fotoğraf yüklenmemesi uyarısı; geri çekme yolu.
**Bilinçle yazılmayanlar** (doğrulanmadı): model eğitiminde kullanılmadığı, Google tarafı saklama
süresi, aktarım hukuki dayanağı, sözleşme. Bunlar hukuk onayı sonrası eklenir ve sürüm artar.

## Hukuk kararı gerektiren açıklar (bu PR çözmez)

- **Kamuya açık metinle çelişki:** `/gizlilik` ("Fotoğrafla arama … diske veya dosya deposuna
  kaydedilmez") ve `/kvkk-aydinlatma` ("Görsel saklanmaz") eski fotoğraf aramasını anlatır. Sohbet
  eki 90 gün veritabanında saklanır; sohbet içeriği ve Gemini'ye gönderim de anlatılmıyor
  (0095 C3). **Bayrak açılmadan önce** bu iki sayfa ve `PRIVACY_NOTICE_VERSION`/`LEGAL_EFFECTIVE_LABEL`
  hukuk onaylı metinle güncellenmeli. Bu PR kamu metnine dokunmaz (onaysız beyan yayımlanmaz).
- **Yurt dışı aktarım (KVK m.9):** Gemini için aktarım dayanağı, Kurum bildirimi/taahhüt, VERBİS;
  `kvkk.md`'deki "sözleşme imzalandı" ifadesinin kanıtı depoda yok (0095 C2). Rıza tek başına
  yeterli dayanak mıdır, yoksa standart sözleşme mi gerekir: hukuk karar verir.
- **Özel nitelikli veri riski:** Fotoğraf yüz/biyometrik/sağlık verisi içerebilir. Uyarı metni var,
  teknik bir içerik süzgeci yok. Gerekli mi: hukuk + ürün.
- **Rıza geri çekmede mevcut görselin silinmesi** yükümlülüğü ve süresi.
- **Reşit olmayanlar** (rıza ehliyeti).
- **Taslak (onaya sunulur, yayımlanmadı):** "Sohbete eklediğiniz fotoğraf, açık rızanızla, ürün
  niyetinizi anlamak için Google (Gemini API) hizmetine iletilir; sunucumuzda küçültülür ve konum
  bilgisi silinerek sohbetle birlikte en fazla 90 gün saklanır, yalnızca size görünür. Rızanızı
  Hesabım > Gizlilik tercihleri sayfasından geri çekebilirsiniz."

## Etkinleştirme sırası (güncel)

0057 ve 0063 production'da uygulanır (`db:migrate`, `db:verify`) → kod dağıtılır (bayrak kapalı) →
hukuk onayı + kamu metinlerinin güncellenmesi → preview/staging'de uçtan uca tarayıcı+Gemini testi →
`CHAT_IMAGE_ENABLED=true` (`CHAT_DISCOVERY_ENABLED` de açık) → izleme (`api_usage`, kotalar).

## Reddedilen alternatifler

- **Rıza yerine yalnız aydınlatma (bilgilendirme bandı):** Ürün sahibi ve 0078 "açık rıza" şartı.
- **Onay kutusu / önceden işaretli / zorunlu giriş rızası:** Serbest irade; hesap açarken toplu rıza yok.
- **Rızayı yalnız istemcide (çerez/`localStorage`) tutmak:** Kanıt değeri yok, sunucu kapısı olmaz.
- **Her fotoğrafta yeniden sormak:** Gereksiz sürtünme; sürümlü tek rıza yeterli, geri çekilebilir.
- **Rıza yokken görseli işleyip rızayı sonradan almak:** Veri zaten aktarılmış olur.
