# 0061 — SSS sayfası ve iletişim formu

**Tarih:** 6 Ekim 2026
**Durum:** Kabul edildi (gelen kutusu ve migration kullanıcı onayıyla)

`/sss` (sıkça sorulan sorular) eklenir; `/iletisim` yalnızca e-posta adresi
gösteren sayfadan bir iletişim formuna dönüşür. Yeni bir gönderim sistemi
kurulmaz.

## Karar

1. **Tek yazma yolu, tek tablo:** iletişim formu `/geri-bildirim`'in
   (karar 0045) yolunu kullanır: server action → `submitContact`
   (`packages/core/src/feedback/contact.ts`) → `feedback` tablosu,
   `kind = 'contact'`. Aynı metin temizleme, bilinmeyen alan reddi, aynı oran
   sınırı kotası (10 dk / 5, iki form toplam), aynı fail-closed davranış,
   aynı KVKK kapsamı (hesap silinince CASCADE, veri indirmede yer alır).
2. **Migration 0047 (geriye uyumlu):** `kind` ('feedback' varsayılan |
   'contact'), nullable `name`; kategori CHECK'i türe göre iki listeye ayrılır
   (iletişim: genel, hesap, yanlış fiyat, teknik sorun, iş birliği, gizlilik,
   diğer); iletişimde e-posta ve ad zorunlu (CHECK). Eski kod `kind` yazmadan
   çalışmaya devam eder. Yetki değişmez.
3. **Kimlik:** hesap bağlantısı (`user_id`) yalnızca sunucu oturumundan. Ad
   ve e-posta formdan gelir (girişli kullanıcıda hesaptan ön doldurulur,
   değiştirilebilir): hesapta e-posta olmayabilir ya da başka yanıt adresi
   istenebilir.
4. **Spam:** mevcut desenler: Redis oran sınırı (IP özeti / hesap), gövde
   tavanı, bilinmeyen alan reddi, server action'ın aynı-köken denetimi.
   CAPTCHA ve üçüncü taraf betik yok (CLAUDE.md: üçüncü taraf CDN yok).
5. **Gelen kutusu:** `/yonetim/mesajlar`, salt okunur, iletişim + geri
   bildirim. Yeni yetenek `messages.read` (yalnızca yönetici; ad ve e-posta
   içerir). Her görüntüleme `messages.list_view` olarak denetime yazılır;
   içerik, ad ve e-posta yazılmaz. Yanıt e-postayla verilir (`mailto`).
6. **SSS içeriği tek dosyada:** `apps/web/app/sss/faq-content.ts`. Sayfa,
   akordeon ve FAQPage yapılandırılmış verisi aynı kaynaktan okur; site içi
   bağlantı `[etiket](/yol)` ile yazılır. Yanıtlar yalnızca kodda doğrulanmış
   davranışı anlatır; ayarlanabilir sayılar yazılmaz.
7. **Akordeon:** `@arilla/ui` `Accordion`, WAI-ARIA deseni (başlık içinde
   düğme, `aria-expanded`/`aria-controls`, `region` paneli, ok tuşları).
   Kapalı paneller sunucu çıktısında yer alır; `#kimlik` çapası öğeyi açar.
8. **Gezinme:** footer yasal grubunda "Sıkça sorulan sorular" İletişim'in
   yanına eklenir (ürün kapalıyken de görünen grup). Üst menüye eklenmez.
9. **Aydınlatma:** `/gizlilik` 2.4'e iletişim formu paragrafı,
   `/kvkk-aydinlatma` talep/şikâyet maddesine iletişim formu eklendi.

## Reddedilen alternatifler

- **Form merkezi (0058) ile `iletisim` formu:** 0058 yönetilen soruları
  kendiliğinden gelen mesajlardan ayırır; ayrıca `/iletisim` yönetimde bir
  formun yayında olmasına bağımlı kalırdı.
- **Migrationsız eşleme** (iletişim kategorilerini geri bildirim
  kategorilerine eşlemek, adı başlığa yazmak): kayıplı ve sorgulanamaz.
- **Ayrı `contact_message` tablosu:** ikinci yazma yolu, ikinci KVKK
  kapsamı; kavram geri bildirimle aynı (kendiliğinden gelen mesaj).
- **Bal küpü alanı / CAPTCHA:** repoda deseni yok; CAPTCHA üçüncü taraf
  betik gerektirir.

## Açık konular

- Anonim gönderimlerin saklama süresi (0045'ten açık) iletişim mesajlarını
  da kapsar; hukukçu onayıyla belirlenecek.
- `/gizlilik` ve `/kvkk-aydinlatma` metin eklemesi yayından önce hukuki
  gözden geçirme ister; güncelleme etiketi yayın tarihine göre güncellenir.
