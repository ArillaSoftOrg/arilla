# 0048 — Kullanıcı profili, aktivite ve rıza altyapısı

**Tarih:** 3 Ekim 2026
**Durum:** Kabul edildi — uygulama fazlı (P1–P7); bu dosya yazıldığında
kodda ve şemada henüz yoktur.

Yönetim konsolunda kullanıcı başına profil ve aktivite görünümü isteniyor.
Bugün elimizde yalnızca tam eşleşmeli kullanıcı bulma (0041 §7) ve tek bir
ayrıntı sayfası var. Giriş/çıkış geçmişi, "son aktif" zamanı, hesaba bağlı
çerez rızası geçmişi, aydınlatma metni sürümü ve kullanıcı başına sayaçlar
yok. Hiçbir analitik olayı gönderilmiyor (`docs/events.md` yalnızca
sözlük).

Bu karar o görünümün **hangi veriyle, hangi hukuki sebeple, hangi kapıdan**
kurulacağını sabitler. Hukuki uygunluğu garanti etmez; hukukçunun
onaylayacağı metinlere teknik dayanak sağlar (`docs/kvkk.md`).

## Önceki kararlarla ilişki

- **0041 §7 kısmen yerini bu karara bırakır — yalnızca liste açısından.**
  Tam eşleşmeli bulma (`users.lookup`, POST, aranan değer denetime
  yazılmaz), ayrıntı görüntüleme denetimi (`users.view`) ve maskeleme
  aynen kalır. Değişen tek şey, aşağıdaki §1'deki **kontrollü, sayfalı
  özet listenin** eklenmesidir. 0041'in "reddedilenler" listesindeki
  "arama günlüğü ve analitik panosu" reddi geçerliliğini korur. Kullanıcı
  başına aktivite sekmesi genel bir analitik panosu değildir.
- **0044 §4 taze giriş listesine** bir okuma eylemi eklenir: tam iletişim
  bilgisini gösterme (§2). Bu listedeki ilk okuma eylemidir. Gerekçesi:
  etkisi bir mutasyonunki kadar yüksek — kişisel verinin maskesiz açılması.
- **0038** değişmez: anonim ziyaretçinin çerez tercihi yalnızca
  `cookie_consent` çerezinde kalır. Bu karar, **girişli** kullanıcının
  tercihini ek olarak hesaba yazar (§6).
- **0033/0046** (pazarlama e-postası, açık dal) `user_consent`'e `source`,
  `text_version`, `recorded_at` kolonlarını ekler ve tabloyu veritabanında
  append-only yapar. Bu karar o modelin üzerine kurulur; 0033 main'e
  girmeden rıza fazına (P3) geçilmez.

## Karar

### 1. Admin kullanıcı listesi (0041 §7'nin yerine)

- Yetki: mevcut `users.read` (yalnızca yönetici). Moderatör göremez.
- Kolonlar yalnızca şunlardır: kısaltılmış `public_id`, **maskeli**
  e-posta, kayıt yöntemi, rol, erken erişim durumu, kayıt tarihi, son
  aktif zamanı, giriş sayısı ve analitik rızası. Analitik rızasının
  değerleri: açık / kapalı / kayıt yok.
- Liste satırında şunlar **yoktur**: tam e-posta, telefon, ad, avatar,
  IP, user agent, ülke, arama metni ve tıklama verisi.
- Filtreler yalnızca enum ve tarih aralığıdır: kayıt yöntemi, rol, erken
  erişim, analitik rızası, kayıt tarihi, son aktif tarihi. **Serbest
  metinle arama yoktur.** Kişi bulmanın tek yolu 0041'deki tam eşleşmedir.
- Sayfalama keyset ile yapılır (`(created_at, id)` ya da
  `(last_active_at, user_id)`, sayfa başı 50). Offset yoktur, toplam
  sayım yoktur. Sorgu `readOnly` sınırı içinde çalışır
  (`admin/bounds.ts`).
- Liste olay tablolarından COUNT yapmaz. Yalnızca `app_user`,
  `user_activity_summary` ve `early_access`'ten okur.
- Her sayfa görüntülemesi `users.list` olarak denetime yazılır. Kayda
  yalnızca kullanılan filtrelerin **adları** ve sayfa yönü girer; filtre
  değerleri girmez.

### 2. Tam iletişim bilgisi: tıkla-göster

- E-posta ve telefon her ekranda varsayılan olarak maskelidir
  (`maskEmail`, `maskPhoneForAdmin`).
- Tam değeri görmek için yeni yetenek `users.contact.reveal` gerekir
  (yalnızca yönetici). Bu yetenek son 1 saat içinde yapılmış bir giriş
  ister (`requireFreshCapability`, `FRESH_AUTH_MAX_AGE_MS`). Taze değilse
  değer döndürülmez ve yeniden giriş bağlantısı gösterilir.
- Her gösterim `users.reveal_contact` olarak denetime yazılır. Kayıtta
  hedef hesap ve alan adı (`email` | `phone`) bulunur, **değerin kendisi
  bulunmaz**.
- Değer yalnızca o yanıtta döner. Önbelleğe, adres satırına ya da
  istemci deposuna yazılmaz; sayfa yenilenince yeniden maskelenir.

### 3. Ayrıntı sekmeleri ve yetkiler

Sekmeler şunlardır: Profil, Aktivite, İzinler, Oturumlar, Aramalar,
Affiliate, Denetim.

- Profil ve İzinler sekmeleri `users.read` ister.
- Aktivite, Oturumlar, Aramalar ve Affiliate sekmeleri yeni
  `users.activity.read` yeteneğini ister (yalnızca yönetici).
- Denetim sekmesi ek olarak `audit.read` ister.
- `users.view` sayfa başına bir kez yazılır. Hassas sekmeler (Aktivite,
  Oturumlar, Aramalar, Affiliate) ek olarak `users.view_tab` kaydı
  üretir; kayıtta sekme adı bulunur.
- Hiçbir sekmede oturum token'ı, sağlayıcı `subject`'i, IP ya da ham
  user agent gösterilmez.
- Kimliğe bürünme, rol düzenleme ve hesap silme arayüzde yine yoktur
  (0039).

### 4. Üç veri sınıfı — karıştırılmaz

| Sınıf | Ne | Hukuki sebep | Rıza |
| --- | --- | --- | --- |
| **A. Hizmet / güvenlik** | hesap, kimlik, oturum, giriş/çıkış (`auth_event`), son aktif, kaba cihaz/tarayıcı/ülke, erken erişim, kaydedilenler, alarmlar, arama hakkı (`ai_search_charge`) | sözleşmenin ifası / meşru menfaat (güvenlik) | gerekmez |
| **B. Attribution** | `click`, `conversion` | meşru menfaat + sözleşme + mali mevzuat | gerekmez |
| **C. Davranışsal analitik** | `user_activity_event` (`search_submitted`, `product_viewed`, `item_saved`, `item_unsaved`, `merchant_exit`, `alternative_clicked`) ve bunlardan türeyen sayaçlar | **açık rıza** (analitik) | **gerekir** |

- A sınıfı veriler rıza durumundan etkilenmez; rıza geri alınınca da
  silinmez.
- C sınıfı veriler hiçbir koşulda A ya da B sınıfının hukuki sebebine
  yaslanarak toplanmaz.
- Gezinme geçmişi (`product_view`, kullanıcıya gösterilen "son
  gezilenler") ayrı bir özelliktir. O da kendi rızasına
  (`browsing_history`) bağlıdır ve C'nin yerine geçmez.
- `session_started` ayrı bir olay değildir: oturum yalnızca girişte açılır.
  Bu yüzden `auth_event.sign_in` ile aynı şeydir.

### 5. Attribution verisi davranışsal profilleme için kullanılmaz

- `click` yalnızca attribution, komisyon mutabakatı, kötüye kullanım
  tespiti ve kullanıcı desteği içindir. Bu kayıt ürünün kendisidir
  (CLAUDE.md kural 8); analitik kopyası değildir.
- `click` satırları `user_activity_event`'e kopyalanmaz. Analitik
  sayaçlarına (`user_activity_summary`) eklenmez ve kullanıcı listesinde
  gösterilmez. Kullanıcı başına ilgi, segment, kişiselleştirme, sıralama
  ya da pazarlama sinyali üretmek için okunmaz.
- Admin "Affiliate" sekmesi `click` kayıtlarını ve sayısını **attribution
  kaydı** etiketiyle gösterir. Bu destek ve mutabakat içindir, profil
  değildir.
- Analitik `merchant_exit` olayı ayrı bir olaydır ve C sınıfının rıza
  kapısından geçer. Rıza yoksa `click` yine yazılır (B), `merchant_exit`
  yazılmaz.
- `click.user_id` yalnızca girişli kullanıcıda ve yalnızca attribution
  amacıyla doldurulur. Hesap silinince NULL'a çekilir (mevcut
  `deleteAccount`).

### 6. Rıza modeli

- Kaynak `user_consent` tablosudur. Tablo append-only'dir (0033 sonrası
  veritabanı düzeyinde) ve her satır bir karardır. Güncel durum, her
  `kind` için en son `granted_at`'li satırdır.
- Yeni `kind` değerleri şunlardır: `cookie_functional`, `cookie_analytics`,
  `cookie_marketing`, `privacy_notice`. Yeni `source` değerleri:
  `cookie_banner`, `sign_in`.
- `privacy_notice` bir **rıza değildir**. Kullanıcıya hangi aydınlatma
  metni sürümünün gösterildiğinin kaydıdır. Arayüzde rızalardan ayrı
  grupta gösterilir ve hiçbir işlemenin ön koşulu yapılmaz.
- Durumlar ayrı bir kolonda tutulmaz, satırlardan türetilir:
  - **kabul**: son satır `granted = true`.
  - **ret**: son satır `false` ve öncesinde `true` yok.
  - **geri alma**: son satır `false` ve öncesinde `true` var.
- **Bilinmiyor:** hiç satır yoksa ya da yalnızca `text_version IS NULL`
  olan eski satırlar varsa durum bilinmiyordur. Arayüzde "kayıt yok /
  sürümsüz" yazar, asla "kabul" yazmaz. İşleme açısından bilinmiyor =
  **izin yok**.
- **Mevcut kullanıcılar için rıza uydurulmaz.** Backfill, geriye dönük
  hiçbir rıza satırı yazmaz.
- Girişli kullanıcı çerez bandında karar verdiğinde karar hem çereze hem
  `user_consent`'e yazılır (`source = 'cookie_banner'`, `text_version` =
  çerez rıza sürümü). Anonim ziyaretçinin kararı sunucuya yazılmaz (0038).
- Yeni satırlara IP yazılmaz.

### 7. Analitik rıza kapısı

- C sınıfı her yazım tek bir core fonksiyonundan geçer
  (`packages/core/src/activity/record.ts`, P4). Başka bir yerden
  `user_activity_event`'e yazılmaz.
- Olay yalnızca şu koşulların **hepsi** sağlanınca yazılır:
  1. kullanıcı girişlidir;
  2. o istekteki `cookie_consent` çerezinde `analytics = true` ve sürüm
     günceldir (`readConsent()`);
  3. hesapta, o çerez kararından daha yeni bir `cookie_analytics = false`
     satırı yoktur.
- Koşul sağlanmazsa fonksiyon hiçbir şey yazmaz: olay yok, sayaç artışı
  yok, anonim yedek kayıt yok.
- Anonim ziyaretçi için kişiye bağlı analitik toplanmaz.

### 8. Ret, geri alma, silme

- **Ret:** C sınıfı hiç başlamaz.
- **Geri alma:**
  - Rıza satırı yazılır.
  - Aynı işlemde kullanıcının tüm `user_activity_event` satırları silinir.
    Silme, uygulama rolünün DELETE yetkisi olmadığı için 0021 istisnasıyla
    SECURITY DEFINER bir fonksiyonla yapılır.
  - Analitik sayaçları NULL'a çekilir.
  - A ve B sınıfı veriler değişmez.
- **Yeniden rıza:** sayaçlar sıfırdan başlar (`analytics_counters_since`).
  Eski veri geri gelmez.
- **Hesap silme:**
  - Yeni tabloların hepsi `ON DELETE CASCADE` taşır: `auth_event`,
    `user_activity_event`, `user_activity_summary`.
  - `click.user_id` NULL'a çekilir (mevcut davranış).
  - Denetim kaydında `target_id` yalnızca sayısal kimliktir ve korunur.
- **Veri indirme:** `exportUserData` rıza geçmişini, giriş geçmişini,
  özet sayaçları ve analitik olaylarını içerir.

### 9. Cihaz, tarayıcı, ülke

- User agent sunucuda yalnızca **sınıfa** indirgenir:
  - `device_class`: mobile / tablet / desktop / other
  - `browser_family`: küçük bir sabit liste
  - Ham user agent yeni tablolara yazılmaz.
- `country_code` yalnızca **kaba istek / güvenlik bağlamıdır**:
  - Barındırma platformunun eklediği ülke başlığından
    (`x-vercel-ip-country`) iki harfli ISO kodu olarak okunur. Geçersiz
    ya da eksikse NULL olur.
  - Saklanan bir IP'den türetilmez. IP→konum veritabanı kullanılmaz.
    Şehir, bölge ve koordinat toplanmaz.
  - Yalnızca `session` ve `auth_event` satırlarında (A sınıfı) ve özetin
    "son ülke" alanında tutulur. Amacı tanınmayan girişi fark etmektir.
  - Analitik olaylarına yazılmaz. Kişiselleştirme, sıralama ya da
    pazarlama için kullanılmaz.

### 10. Saklama süreleri

| Veri | Süre |
| --- | --- |
| `user_activity_event` | 180 gün. `query_norm` 90 günde NULL'a çekilir. |
| `user_activity_summary` | hesap silinene kadar (analitik sayaçları geri almada NULL olur) |
| `auth_event` | 1 yıl |
| `session.ip`, `session.user_agent` | oturum ömrü kadar (mevcut temizlik) |
| `user_consent` | hesap silinene kadar (rıza ispatı) |
| `user_consent.ip` (eski satırlar) | 1 yıl sonra NULL |
| `admin_audit_event` | süresiz (denetim izi; kişisel veri taşımaz) |

Append-only tablolarda süre dolumu da 0021 istisnasıyla, SECURITY DEFINER
fonksiyonlarla ve günlük cron'la yapılır (mevcut `cleanup-auth` deseni).

### 11. Veri modeli (P1–P4'te uygulanır)

- Domain tabloları kaynak olarak kalır: `click`, `saved_item`,
  `ai_search_charge`, `product_view`. Bunlar için ayrı olay tabloları
  (`search_events`, `favorite_events`, `affiliate_click_events`…)
  **açılmaz**.
- Yeni tablolar:
  - `auth_event` (A sınıfı, append-only)
  - `user_activity_event` (C sınıfı, append-only, **tipli kolonlar**,
    serbest JSONB yok)
  - `user_activity_summary` (kullanıcı başına tek satır; olayla aynı
    işlemde artırılır)
- `session` tablosuna üç nullable kolon eklenir: `device_class`,
  `browser_family`, `country_code`.
- `last_active_at` oturum doğrulamasında **15 dakikalık eşikle**
  güncellenir; her istek yazmaz.

## Gerekçe

- Kişi bulma için tam eşleşme yeterliydi. Ama erken erişim dönemi
  boyunca "kim giriş yaptı, kim aktif" sorusu `psql`'e düşüyordu. Kontrollü
  bir liste, bu soruyu denetimli ve maskeli bir yoldan cevaplar.
- Üç sınıflı ayrım, "rıza alınmadı ama meşru menfaat dedik" kaymasını
  şemaya ve tek bir core kapısına bağlayarak engeller.
- Domain tablolarını kaynak bırakmak çift kaydı ve iki kaynağın ayrışmasını
  önler. Özet tablo, listede milyonlarca satır saymayı önler.
- Tipli kolonlar, allowlist'i kod incelemesine değil veritabanı şemasına
  verir. Serbest JSON'a zamanla kişisel veri sızar.

## Reddedilen alternatifler

- **Her alan için ayrı olay tablosu:** mevcut `click`/`saved_item` ile
  çift kaynak oluşturur. Her yeni olay bir migration ister.
- **Tek generic olay tablosu + serbest `metadata` JSONB:** allowlist
  yalnızca koda kalır; token, e-posta ya da header sızıntısını motor
  engelleyemez.
- **Analitiği meşru menfaatle rızasız toplamak:** 0038 ve
  `docs/events.md`'deki "zorunlu olmayan ölçüm rızasız çalışmaz"
  ilkesiyle çelişir.
- **Üçüncü taraf analitik SDK'sı:** CLAUDE.md üçüncü taraf betiği yasaklar
  ve veri yurt dışına çıkar.
- **RLS:** kullanıcı başına bir veritabanı kimliği yok. Tek uygulama rolü
  sunucudan bağlanıyor; yetki `requireCapability` ve `assertCapability`
  ile uygulanır. Supabase Data API riski ayrı bir ops adımıyla kapatılır
  (`docs/ops.md`).
- **Tam IP'yi ülke/şehir çıkarmak için saklamak:** amaçla orantısız.
  Platform başlığı yeterli.
- **Listede tam e-posta ya da serbest metin arama:** toplu kişisel veri
  dökümüne ve sessiz taramaya kapı açar.
- **Tıklama verisinden kullanıcı ilgi profili çıkarmak:** attribution
  amacının dışına çıkar (§5).

## Açık bağımlılıklar

1. 0033 main'e girmeden P3 (rıza) başlamaz.
2. Supabase Data API'nin açık olup olmadığı production panelinden
   kontrol edilmeli (`docs/ops.md`).
3. `/gizlilik` ve `/kvkk-aydinlatma` metinleri analitik olayları, kaba
   cihaz/ülke bilgisini ve saklama sürelerini anlatacak şekilde
   güncellenmeli. Bu güncelleme hukukçu onayı gerektirir. **Sayfa
   adresleri değişmez.**
