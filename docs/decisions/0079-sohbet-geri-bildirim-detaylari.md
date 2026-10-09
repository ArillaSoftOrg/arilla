# 0079 — Sohbet geri bildirimi: neden, yorum ve yönetici görünümü

**Tarih:** 8 Ekim 2026 · **Durum:** kabul edildi (karar 0075 m.5'in genişlemesi)

## Karar

1. **Mevcut tablo genişletilir.** `chat_result_feedback` (0055) korunur; 0058 yalnızca
   `reasons`, `comment`, `model_version` ekler. Yeni `chat_feedback` tablosu açılmaz
   (çift kaynak ve veri taşıma olurdu). Mesaj başına tek oy PK ile sürer, oy değişebilir.
2. **Olumsuz oy yalnızca Gönder ile yazılır.** 👎 modal açar; İptal/Esc kayıt üretmez.
   Neden ve yorum boş olsa da gönderilebilir. Olumlu oy tek tık, neden/yorum taşımaz (CHECK).
3. **Tek neden seçimi.** Sade açılır menü korunur; `reasons` dizisi çoklu seçime hazır
   (en çok 3), arayüz şimdilik 1 eleman yazar. Yorum en çok 500 karakter.
4. **Anonim yok.** `/sohbet` girişlidir (0074 m.10); `session_id` eklenmez. `user_id`
   kolonu da eklenmez: sahiplik `conversation.user_id` üzerinden doğrulanır, silme CASCADE.
5. **RLS yazılmaz** (karar 0057): Data API kapalı, `anon/authenticated` yetkisiz. Koruma:
   yalnızca sunucu eylemi, sahiplik join'i, CHECK kısıtları, Redis oran sınırı (fail-closed).
6. **Analitik olay gönderilmez** (kural 13). Kalite ölçümü oy satırından yapılır.
   Kalıcı sonuç sayısı, gecikme, hata, kart tıklaması ve satıcı yönlendirmesi **bu kararın
   dışındadır** (0074 sayıyı bilerek saklamaz; `click` davranış analitiği için kullanılmaz).
   Sonraki karar.
7. **Yönetici görünümü** `/yonetim/ai-geri-bildirim`, capability `feedback.chat.read`.
   Oy, neden, yorum, sohbet/mesaj referansı gösterilir; **sohbet metni gösterilmez.** Her
   liste ve detay görüntüleme `admin_audit_event`'e yazılır (içerik yazılmaz).
8. **Saklama.** Yorum 90 gün sonra NULL'lanır (cleanup-auth); oy ve neden kalır. Hesap
   silinince tüm satır gider. Dışa aktarıma eklenir. Süre hukukçu onayı bekler.
9. **Model eğitimi yok.** Geri bildirim modeli otomatik eğitmez; yalnızca kalite analizi
   ve kontrollü iyileştirme sinyalidir.
10. **Sohbet bağlamına yönetici erişimi bu kararda AÇILMAZ.** Ayrı faz: kullanıcı onaylı
    (varsayılan kapalı), paylaşılacak mesajlar kullanıcıya gösterilir, yalnızca seçilen
    kapsam, ayrı capability, her erişim denetimde, hukuki inceleme sonrası. Tamamlanana
    dek 0074'ün "sohbeti yalnızca sahibi okur" kuralı aynen geçerlidir.

## Reddedilen alternatifler

- Yeni `chat_feedback` tablosu: 0055 ile çift kaynak, taşıma riski.
- Çoklu neden seçimi arayüzü: sade yapıyı bozar, analizde tek birincil neden yeter.
- `feedback` (0032) tablosunu kullanmak: yönetici gelen kutusunu 👍/👎 ile doldurur (0075).
- Oy için analitik olayı: rıza bağımlı hatta sohbet katmak ayrı karar ister.
- Adminlere sohbet metnini otomatik açmak: gizlilik modeline aykırı.
