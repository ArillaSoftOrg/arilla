# 0074 — Konuşmalı ürün keşfi (`/sohbet`)

**Tarih:** 7 Ekim 2026
**Durum:** Kabul edildi, kod hazır; üretimde `CHAT_DISCOVERY_ENABLED=true`
verilene kadar kapalı. Hukuk onayı (aşağıda "Etkinleştirme koşulu") gelmeden
açılmaz.

Karar 0059 Gemini'yi yalnızca çevrimdışı toplu işe bağlamıştı ve istek yolunu
yasaklamıştı (CLAUDE.md kural 1). Ürün kararı: ana sayfadaki kutu kullanıcıyı bir
sohbete götürür; model niyeti adım adım toplar, yeterli bilgi olunca mevcut aramayı
çalıştırır. Bu, kural 1'e **dar bir ikinci istisna** gerektirir; CLAUDE.md kural 1
bu kararla birlikte güncellendi.

## Karar

1. **Model yalnızca niyet çıkarır.** İki eylem: `clarify` (tek soru + seçenekler)
   ve `search` (`SearchIntent` yaması). Model SQL yazmaz, veritabanına erişmez,
   ürün/fiyat/stok/mağaza üretmez. Çıktısı `unknown`dır; elle yazılmış katı
   doğrulayıcıdan (`chat/contract.ts`) geçmeden hiçbir yere yazılmaz.
2. **Ürünler yalnızca arama katmanından gelir.** `SearchIntent`, ince bir
   uyarlayıcıyla (`chat/search-adapter.ts`) mevcut `parseQueryText` +
   `searchWithFallback` + `createPostgresSearchProvider` zincirine verilir. İkinci bir
   arama motoru, sıralama ya da skor yok. Sonuçlar mesaja kopyalanmaz: sayfa
   gösterilirken saklı niyetle aranır (güncel fiyat, kural 2/9 etkilenmez).
3. **Durum sunucudadır, modelde değil.** `conversation.current_search_intent`
   normalize edilmiş niyettir. Model her turda yalnızca bir *yama* döndürür
   (`reset`, `remove`, alan değerleri); birleştirme `mergeSearchIntent` ile
   deterministiktir. "Daha ucuz", "siyah olsun", "Nike olsun", "2500 TL altı" önceki
   niyeti ezmez, günceller.
4. **Seçenek tıklaması da bir kullanıcı mesajıdır** (`kind = option | skip | text`)
   ve aynı turdan geçer; model çağrısı yapılır (bkz. reddedilen: yerel kural).
5. **Hata asla çıkmaz yol bırakmaz.** Model yanıtı bozuk/şemaya uymaz/zaman aşımı:
   deterministik yedek — kullanıcının metninden (seçimse seçenek değerinden) bir
   `search` niyeti kurulur ve mevcut aramaya gider. Sağlayıcı hatasında (anahtar
   yok, 5xx, kota) kullanıcı mesajı saklı kalır, asistan mesajı yazılmaz, arayüz
   "tekrar dene" gösterir.
6. **Sahiplik.** Her okuma/yazma `user_id` ile birlikte sorgulanır; başkasının
   sohbeti 404'tür. Sohbet kimliği tahmin edilemez UUID'dir.
7. **Yarış ve çift gönderim.** Konuşma satırında `processing_until` kirası:
   `UPDATE ... WHERE processing_until IS NULL OR processing_until < now()` tek
   atomik ifadedir; kazanamayan tur `busy` döner. Mesaj sırası `UNIQUE
   (conversation_id, seq)`, tekrar gönderim `UNIQUE (conversation_id,
   client_request_id)` ile motor düzeyinde zorlanır. Model çağrısı işlem içinde
   değildir (uzun işlem/kilit yok).
8. **Maliyet.** Her HTTP denemesi `api_usage`'a (`operation = 'chat_turn'`,
   `units` = toplam token, `user_id` dolu) yazılır (kural 9). Kullanıcı başına
   saatte `CHAT_TURNS_PER_HOUR` (20) tur; sohbet başına en çok 60 kullanıcı mesajı.
   Mesaj uzunluğu 500 karakter. Modele giden bağlam son 12 mesajla sınırlıdır.
9. **Saklama.** Sohbet ve mesajlar kişisel veridir (kullanıcı serbest metni).
   Hesap silinince `ON DELETE CASCADE` ile gider; `last_message_at`'ten 90 gün
   sonra `cleanup-auth` cron'u siler. Analitik olayı gönderilmez (kural 13).
   Hata günlüğüne mesaj metni girmez.
10. **Girişli kullanıcı.** Sohbet `requireProductUser` ister. Anonim kullanıcı ana
    sayfadan eskisi gibi `/ara`'ya gider (karar 0002 SEO rotalarını etkilemez; `/sohbet`
    `noindex`).

## Etkinleştirme koşulu

0059 hukuki çerçevesi **filtrelenmiş toplu sorgu** için verildi. Burada ham
kullanıcı mesajı, anlık, kimliğe bağlı olarak Google'a gider. Bu, yeni bir işleme
amacı ve aktarım kapsamıdır: hukuk danışmanı onayı, aydınlatma metni/gizlilik
güncellemesi (sohbet içeriği, 90 gün saklama) ve `docs/kvkk.md` kontrol listesi
tamamlanmadan bayrak açılmaz. Model prompt'una `user_id`, e-posta, IP ya da başka
kimlik girmez; yalnızca mesaj metinleri ve mevcut niyet gider. Özel nitelikli veri
süzgeci (`interpretation-eligibility`) kullanıcı mesajına uygulanır: eşleşirse model
çağrılmaz, mesaj yine saklanır ve yedek yol çalışır.

## Reddedilen alternatifler

- **Seçenek tıklamasını modele göndermemek (yerel kural).** Soru modelin ürettiği
  serbest bir sorudur; seçenek `value`'su taksonomide değildir. Yerel eşleme ikinci
  bir yorum katmanı olurdu. Maliyet tavanla sınırlı.
- **Modele araç/SQL erişimi vermek.** Güvenlik sınırını kaldırır, ürün uydurma
  riski.
- **Sonuçları mesaj JSON'una gömmek.** Fiyat/stok bayatlar, ürün kaldırılırsa
  bozuk kart kalır.
- **Konuşma durumunu yalnızca istemcide (URL/localStorage) tutmak.** Yenilemede
  geçmiş ve sahiplik kaybolur; CLAUDE.md `localStorage`'sız çalışmayı şart koşar.
- **Mevcut `/ara` netleştirme motorunu genişletmek (0030).** Elle yazılmış kural
  sözlüğü açık uçlu soru/seçenek üretemez; 0030 olduğu gibi `/ara`'da kalır.
- **Model çağrısını `after()`/kuyrukta yapmak.** Kullanıcı yanıtı bekler; Python
  tarafına dokunmayı gerektirir (mimari sınır).

## Ek kararlar (bağımsız audit sonrası, 7 Ekim 2026)

- **0062 ile ilişki.** `/ara` anlık yorumu (karar 0062) ve sohbet ayrı bütçelerdir:
  ayrı bayrak (`CHAT_DISCOVERY_ENABLED`), ayrı `api_usage.operation` (`chat_turn`),
  ayrı kullanıcı limiti (DB'den, kullanıcının saatlik mesaj sayısı) ve ayrı günlük
  sağlayıcı tavanı (`CHAT_DAILY_CALL_CAP` = 3000 deneme). Tavan dolunca model
  çağrılmaz, kullanıcı deterministik yedek aramayla devam eder. Sayaçlar Redis'e
  bağlı değildir; Redis kesintisi sohbeti etkilemez.
- **Kalıcılık eşdeğerliği.** Ayrı `status`/`intent_before` kolonu yok: her arama
  mesajı kendi anındaki birleşik niyeti (`payload.intent`) ve kaynağını
  (`model`/`fallback`, `fallbackReason`) taşır; önceki niyet bir önceki arama
  mesajıdır, yani tam tekrar oynatma mümkündür. Sonuç sayısı saklanmaz (sonuçlar
  gösterimde canlı aranır, bayatlamaz).
- **Sahiplik.** Tüm okuma/yazma `chat/service.ts` içinden, `user_id` filtresiyle
  geçer; yanlış/başkasının/geçersiz UUID aynı `null`/`not_found` → 404. RLS yoktur
  (0042: uygulama yalnızca sunucudan bağlanır); koruma sorgudadır, testlidir.
- **Veri yaşam döngüsü.** Hesap silme CASCADE (testli), dışa aktarım
  `conversations` alanını içerir (testli), 90 gün saklama cron'u, günlüğe mesaj
  metni girmez. Hukuk notu: `docs/legal-review/sohbet-konusmali-kesif.md`.
- **Yama anlamları.** set (alan değeri), add (`excludeBrands` birleşimi), remove
  (`remove` listesi), clear (tüm kısıtlar, sorgu kalır), reset (yeni konu).
  Kategori değişirse yalnızca kategoriye bağlı kısıtlar (beden, nitelikler)
  silinir; marka, renk, fiyat kullanıcının tercihi olarak kalır. Aynı marka hem
  dahil hem hariç olamaz. Öncelik: kullanıcının açık girdisi (fiyat kalıbı,
  "daha ucuz", "fiyat sınırını kaldır") > deterministik kural > model; metinde
  olmayan fiyat modelin uydurması sayılıp atılır.
- **Model çıktı sınırı.** URL/alan adı içeren çıktı bütünüyle reddedilir; bağlantı
  içeren kullanıcı mesajı modele gitmez. Şema `additionalProperties: false`,
  doğrulayıcı bilinmeyen alanları atar.
- **Arama zaman aşımı.** `searchByIntent` kendi işleminde `statement_timeout`
  (4 sn) ile çalışır; aşılırsa `IntentSearchTimeoutError`, sohbet bozulmaz, niyet
  saklıdır, arayüz "Tekrar dene" bağlantısı gösterir.
- **Şeffaflık.** Arama renk/beden/kategori/sözcük gevşettiyse ya da hariç tutulan
  marka katalogda çözülemediyse sonuçların üstünde açıkça yazılır.
- **Fiyat tutarlılığı.** Filtre `product.min_price`'a, kart seçilen tekliften
  gelir ve ayrışabilir (genel `/ara` davranışı, bu karar kapsamı dışı). Sohbette
  kullanıcının tavanını aşan kart gösterilmez; eleme olduysa sayı ve "tümünü gör"
  gizlenir. Kök neden (`best_offer` ile `min_price` hizalaması) açık risktir.
- **Gemini istemcisi.** 12 sn zaman aşımı x en çok 2 deneme. İstemci kopmasında
  Gemini çağrısını iptal etmek server action sınırında mümkün değildir (Next
  AbortSignal vermez); çağrı zaman aşımıyla sınırlıdır. Anahtar yalnızca sunucuda.
- **Hak/quota (0047).** Sohbet turları arama hakkı (`ai_quota_day`/`ai_search_charge`)
  harcamaz ve kullanıcı başına tek-uçuş kuralına bağlanmaz: aynı sohbette normal
  akış bozulurdu. Koruma: saatlik kullanıcı limiti + kira + günlük tavan.
- **Analitik.** Bu iterasyonda HİÇ olay gönderilmez (kural 13: `docs/events.md`
  tanımsız olay yasak). `chat_message_sent` vb. istenirse önce events.md'ye eklenir;
  mesaj metni yüke girmez.
