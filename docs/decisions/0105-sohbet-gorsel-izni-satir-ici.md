# 0105 - Sohbet görsel izni: modal yerine satır içi şerit

**Durum:** Kabul edildi. `CHAT_IMAGE_ENABLED` kapalı kalır; hukuk onayı yerine geçmez.

## Karar

0101'in 3. maddesi (uzun bilgilendirme penceresi) değişir; geri kalanı aynıdır.

1. Fotoğraf seçilince modal açılmaz. Rıza varsa fotoğraf doğrudan önizlenir ve Gönder ile gider.
   Rıza yoksa seçilen fotoğraf yalnızca bellekte bekler ve kompozerin üstünde satır içi, kısa bir
   şerit görünür: fotoğrafın önizlemesi, 4 cümlelik özet, "Gizlilik tercihleri" ve
   "KVKK Aydınlatma Metni" bağlantıları, eşit ağırlıklı "İzin ver ve fotoğrafı ekle" / "Vazgeç".
   Onay kutusu yok, önceden seçili yok; Esc/Vazgeç = ret (kayıt yazılmaz).
2. Hesabım > Gizlilik tercihleri'nde "Sohbette fotoğraf kullanımı" bölümü bilgilendirmeyi, izin
   durumunu ve geri çekmeyi gösterir (izin varsa her zaman; yoksa yalnız özellik açıkken).
   İzin buradan verilmez, yalnızca fotoğraf eklerken verilir.
3. Metin kısaldığı için `CHAT_IMAGE_CONSENT_VERSION` = `chat-image-2026-10-12`; eski sürüme verilmiş
   rıza geçersiz sayılır, yeniden sorulur.

## Değişmeyenler

Sunucu kapısı (`hasChatImageConsent`, `consent_required`), Gemini çağrısı, görsel işleme, 90 gün
saklama, rıza geri çekme, `user_consent` kaydı, `/kvkk-aydinlatma` metni. Şerit, 0101'deki
bilgilendirme içeriğinin (aktarım, saklama, hassas veri uyarısı, geri çekme) hepsini taşır.

## Hukuki engel (çözülmedi)

Rıza kapısı kaldırılmadı: fotoğraf Gemini'ye (yurt dışı) gittiği için açık rıza hukuken gerekli
olabilir ve bu değerlendirme hukuka aittir. "Hiç rıza sormadan ChatGPT gibi" akış, 0101'de listelenen
açıklar (aktarım dayanağı KVK m.9, özel nitelikli veri, `/gizlilik` ve `/kvkk-aydinlatma`'nın eski
"saklanmaz" metni, reşit olmayanlar) hukuk tarafından kapatılmadan yapılmaz. Şerit modalden hafif,
ama rızanın yerini almaz.

## Reddedilen alternatifler

- Rıza kapısını tamamen kaldırıp yalnız bilgilendirme göstermek: hukuki karar gerekir (yukarısı).
- Fotoğrafı önce gönderip rızayı sonra almak: veri zaten aktarılmış olur (0101).
