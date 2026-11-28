# 0222 — Yönetimde e-posta ayarları (`/yonetim/eposta`)

**Tarih:** 28 Kasım 2026
**Durum:** Kabul edildi (kod bu kararla birlikte). Yeni bildirimler **kapalı** doğar; hiçbir ortamda kendiliğinden
e-posta başlamaz. Açmak yöneticinin panelden vereceği karardır.
**İlişkili:** 0045 (geri bildirim), 0061 (iletişim formu), 0048 (pazarlama e-postası), 0151 (işlemsel
şablonlar), 0039 (yetki ve denetim), 0049 (kişisel veriye erişim denetimi).

## Bağlam

İletişim ve geri bildirim formları kaydı yalnızca `/yonetim/mesajlar` gelen kutusuna yazar; kimseye e-posta
gitmez, gönderene de "aldık" denmez. Mevcut e-postaların (fiyat alarmı, pazarlama kampanyası) açılıp
kapanması ise yalnızca dağıtım ortamındaki bayraklarla yapılır. Yönetici bunları panelden göremez ve
değiştiremez.

## Karar

Tek satırlı `email_setting` tablosu ve `/yonetim/eposta` sayfası eklenir. Anahtarlar:

| Anahtar | Varsayılan | Etki |
|---|---|---|
| `team_notifications` | kapalı | Yeni iletişim mesajı / geri bildirim geldiğinde yönetici adresine kısa bildirim |
| `visitor_confirmations` | kapalı | Formu dolduran ve e-posta bırakan kişiye "aldık" e-postası |
| `price_alerts` | **açık** | Fiyat/stok alarm e-postaları; kapalıyken `triggerAlerts` hiçbir alarmı tüketmez (alarmlar aktif kalır, açılınca gider) |
| `marketing_emails` | **açık** | Pazarlama kampanyasının toplu gönderimi; kapalıyken kampanya `sending`te bekler, `switched_off` koduyla işaretlenir |

Kurallar:

- **Giriş ve kimlik bilgisi e-postaları (`send-login-email`, `send-credential-email`) anahtarsızdır.**
  Kapatılırsa kullanıcılar hesaba giremez. Panelde "her zaman açık" olarak gösterilir.
- Mevcut davranış korunur: satır yoksa `price_alerts` ve `marketing_emails` **açık** sayılır, yeni iki anahtar
  **kapalı**. Pazarlama için mevcut bayraklar (`MARKETING_EMAIL_ENABLED`, üretim kapısı, İYS izni, unsubscribe)
  aynen geçerlidir; tablo anahtarı yalnızca ek bir kapatma düğmesidir, kapıyı asla açmaz.
- **Ekibe bildirim kişisel veri taşımaz:** kategori, konu/başlık ve `/yonetim/mesajlar` bağlantısı. Gönderenin
  e-postası ve mesaj metni YOKTUR. Gerekçe: bu veri yalnızca `messages.read` ile ve denetim kaydıyla görünür
  (0049, 0061); e-posta gövdesine koymak o denetimi atlar ve içeriği ek bir sağlayıcıya yayar.
- **Ziyaretçiye onay serbest metin taşımaz:** yalnızca sabit metin ve kategori etiketi. Kullanıcının yazdığı
  metin başkasının adresine gönderilemez (e-posta bombalama/kötüye kullanım yüzeyi). Mevcut form kotası
  (10 dk / 5, 0045) bu yolu da sınırlar. Onay işlemseldir, reklam içermez.
- Alıcı adresi `ADMIN_NOTIFY_EMAIL` ortam değişkeninden gelir (kodda sabit adres yok). Tanımsızsa bildirim
  gönderilmez ve panel uyarır.
- E-posta hatası formu ve kaydı bozmaz: kayıt önce yazılır, gönderim sonra denenir, hata yutulur; logda yalnızca
  hata kodu yer alır (alıcı, konu, gövde yok).
- Ayar okunamazsa (tablo yok / veritabanı hatası) güvenli varsayılan: yeni bildirimler gönderilmez, mevcut
  e-postalar eskisi gibi çalışır.

Yetki: yeni yetenek `email.manage` (yalnızca yönetici). Hem sayfa hem her server action kendi başına ister;
core mutasyonu `assertCapability` ile tekrar denetler. Her değişiklik aynı işlemde `email_settings.update`
olarak denetime yazılır (önce/sonra yalnızca anahtar değerleri).

Önizleme: tüm şablonlar örnek veriyle sandbox'lı `iframe`de gösterilir; önizleme e-posta göndermez ve
veritabanına dokunmaz. Önizleme ve gerçek gönderim aynı saf şablon fonksiyonlarını kullanır.

## Kapsam dışı

- Erken erişim kaydı ve bülten (bu depoda form yok; giriş sırasında kayıt oluşur).
- Gönderen adresi/SMTP bilgisinin panelden değiştirilmesi (sırlar panelden yönetilmez, 0086).
- "Yanıtla" ile ziyaretçiye doğrudan yazma: e-posta adresi bildirimde olmadığından yanıt gelen kutusundan verilir.

## Geriye uyumluluk

`0120_email_setting.sql` yalnızca ekleme yapar. Geri alma: önce kod geri alınır; tablo zararsız kalır.
