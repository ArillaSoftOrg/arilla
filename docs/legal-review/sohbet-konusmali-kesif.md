# Konuşmalı keşif (`/sohbet`) — hukuk değerlendirmesi için not (taslak)

Karar 0074. **Hukuk onayı verilmeden `CHAT_DISCOVERY_ENABLED` açılmaz.**

- **Ne işleniyor:** girişli kullanıcının serbest metin mesajları ve bunlardan çıkarılan
  arama niyeti. Kullanıcıya bağlı saklanır (`conversation`, `chat_message`).
- **Aktarım:** her tur, son 12 mesaj + niyet Google Gemini'ye (yurt dışı) gider.
  Kimlik, e-posta, IP gönderilmez. Özel nitelikli/kişisel veri/sır/bağlantı süzgeci
  mesajı modele göndermez (yedek arama çalışır). 0059 çerçevesi filtrelenmiş toplu
  sorgu içindi; ham anlık mesaj yeni bir kapsamdır (m.5/2-f değerlendirmesi ve m.9
  aktarım sözleşmesi kapsamı yeniden teyit edilmeli).
- **Saklama/silme:** 90 gün (son mesajdan), hesap silinince anında; `/hesap/veri-indir`
  sohbetleri içerir.
- **Aydınlatma metni:** gizlilik ve KVKK metinlerine sohbet içeriği, amaç, saklama ve
  aktarım eklenmeli (bu iterasyonda herkese açık yasal sayfalar DEĞİŞTİRİLMEDİ).
- **Açık sorular:** kullanıcıya sohbet başında kısa uyarı ("mesajların yapay zeka
  sağlayıcısına gönderilir, kişisel bilgi yazma") gösterilsin mi?
