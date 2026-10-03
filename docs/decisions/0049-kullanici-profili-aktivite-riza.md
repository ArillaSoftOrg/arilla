# 0049 — Kullanıcı profili, aktivite ve rıza altyapısı

**Tarih:** 3 Ekim 2026
**Durum:** Kabul edildi, uygulandı (migration 0036, 0037; ayrıntı §12).

Yönetim konsolunda kullanıcı başına profil ve aktivite görünümü isteniyor.
Bugün elimizde şunlar var:

- `/yonetim/kullanicilar` sayfasında ad, e-posta, hesap kimliği ve telefonla
  kullanıcı araması (`searchUsers`, `packages/core/src/admin/users.ts`)
- tek bir ayrıntı sayfası (`getUserDetail`)

Şunlar yok:

- giriş/çıkış geçmişi ve "son aktif" zamanı
- hesaba bağlı çerez rızası geçmişi ve aydınlatma metni sürümü
- kullanıcı başına sayaçlar
- analitik olayları (`docs/events.md` yalnızca sözlük; hiçbir olay
  gönderilmiyor)

Bu karar o görünümün **hangi veriyle, hangi hukuki sebeple, hangi kapıdan**
kurulacağını sabitler. Hukuki uygunluğu garanti etmez; hukukçunun
onaylayacağı metinlere teknik dayanak sağlar (`docs/kvkk.md`).

## Önceki kararlarla ilişki

- **0041 §7 kısmen yerini bu karara bırakır — yalnızca kullanıcı bulma ve
  liste açısından.**
  - 0041 §7 yalnızca tam eşleşmeye izin veriyordu. Main'e giren kısmi
    arama (`searchUsers`, `users.search`) bu sınırı fiilen aşmıştı ama bir
    karar dosyasına bağlanmamıştı. Bu karar onu kabul eder ve güvenlik
    sınırlarını yazar (§1a).
  - Bu karar ayrıca kontrollü, sayfalı bir özet liste ekler (§1b).
  - Ayrıntı görüntüleme denetimi (`users.view`) ve maskeleme aynen kalır.
  - 0041'in "reddedilenler" listesindeki "arama günlüğü ve analitik
    panosu" reddi geçerliliğini korur. Kullanıcı başına aktivite sekmesi
    genel bir analitik panosu değildir.
- **0044 §4 taze giriş listesine** bir okuma eylemi eklenir: tam iletişim
  bilgisini gösterme (§2). Bu listedeki ilk okuma eylemidir. Gerekçesi:
  etkisi bir mutasyonunki kadar yüksek — kişisel verinin maskesiz açılması.
- **0038** değişmez: anonim ziyaretçinin çerez tercihi yalnızca
  `cookie_consent` çerezinde kalır. Bu karar, **girişli** kullanıcının
  tercihini ek olarak hesaba yazar (§6).
- **0048** (pazarlama e-postası kampanyaları) rızanın tek kaynağını
  `user_consent` olarak sabitledi ve rıza modelini değiştirmedi (migration
  0035). Bu karar o kaynağı ve "güncel durum = son satır" tanımını aynen
  kullanır. Mevcut hiçbir rıza satırını geçersiz saymaz (§6). Merge
  edilmemiş `feature/marketing-email-consent` dalına (0033/0046) **bağlı
  değildir**; o dal 0048'de reddedildi.

## Karar

### 1a. Kullanıcı araması (`searchUsers`) — mevcut, korunur

Main'deki kısmi arama kaldırılmaz. Aşağıdaki sınırlar bu kararın
parçasıdır; kod bunlardan birini gevşetecekse önce bu dosya güncellenir.

- **Yetki:** yalnızca `users.read` (yalnızca yönetici). Fonksiyon kendi
  içinde `assertCapability` çağırır; moderatör ve normal kullanıcı arama
  yapamaz.
- **Arama türleri:**
  - Metin araması: ad ve e-posta içinde, Türkçe katlamalı, büyük/küçük
    harf duyarsız.
  - Hesap kimliği (UUID) ve E.164 telefon: tam eşleşme.
- **Girdi sınırları:**
  - En az 2 karakter (katlanmış hal; `USER_SEARCH_MIN_LENGTH`).
  - En çok 100 karakter (`USER_SEARCH_MAX_LENGTH`).
  - LIKE özel karakterleri düz metin sayılır.
- **Sonuç sınırları:**
  - Sayfa başı 20 sonuç (`USER_SEARCH_PAGE_SIZE`).
  - En fazla 50 sayfa (`USER_SEARCH_MAX_PAGE`).
  - Toplam sayım yapılmaz.
  - Bu sınırlar sessiz toplu döküm yapılmasını engeller.
- **Denetim zorunludur.** Her arama `users.search` olarak yazılır. Kayıtta
  yalnızca yöntem (`text` | `public_id` | `phone`), sayfa ve sonuç sayısı
  bulunur. **Aranan değer** (ad, e-posta parçası, telefon) **kayda
  yazılmaz.**
- **Sonuç satırında gösterilenler:**
  - Ad: aramanın konusu olduğu için gösterilir.
  - **Maskeli** e-posta ve **maskeli** telefon.
  - Rol, kayıt tarihi, erken erişim durumu.
- **Sonuç satırında gösterilmeyenler:** tam e-posta, tam telefon, IP,
  user agent, ülke, oturum, rıza ve aktivite verisi.
- **Arama hiçbir şeyi otomatik açmaz.** Tam iletişim bilgisi yalnızca §2'deki
  ayrı ve taze girişli `users.contact.reveal` adımıyla, tek hesap için
  açılır. Arama sonucu, ayrıntı sayfası ya da sonuç sayısı bu adımı
  atlatmaz.
- **Sayfalama bugün offset'tir:** `LIMIT 21 OFFSET (sayfa-1)*20`, sıralama
  `created_at DESC, id DESC`. Bu durum bu fazda (P0) değiştirilmez.
  Hedef keyset sayfalamaya geçiştir (`(created_at, id)` imleci, P5). O
  geçişle offset tavanı ve derin sayfa maliyeti ortadan kalkar.
- **Ölçek notu:** `%…%` taraması bugünkü küçük tabloda ucuzdur. Tablo
  büyüdüğünde katlanmış ifadeye trigram indeksi eklenir (0019 deseni). Bu
  da EXPLAIN kanıtıyla yapılır (0041 §10).

### 1b. Özet kullanıcı listesi — planlı (P5/P6)

- Yetki: `users.read` (yalnızca yönetici). Moderatör göremez.
- Kolonlar yalnızca şunlardır: kısaltılmış `public_id`, **maskeli**
  e-posta, kayıt yöntemi, rol, erken erişim durumu, kayıt tarihi, son
  aktif zamanı, giriş sayısı ve analitik rızası. Analitik rızasının
  değerleri: açık / kapalı / kayıt yok.
- Liste satırında şunlar **yoktur**: tam e-posta, telefon, IP, user
  agent, ülke, arama metni ve tıklama verisi.
- Filtreler yalnızca enum ve tarih aralığıdır: kayıt yöntemi, rol, erken
  erişim, analitik rızası, kayıt tarihi, son aktif tarihi. Metinle kişi
  bulmak için §1a'daki arama kullanılır; listeye ikinci bir serbest metin
  alanı eklenmez.
- Sayfalama keyset ile yapılır (`(created_at, id)` ya da
  `(last_active_at, user_id)`, sayfa başı 50). Offset ve toplam sayım
  yoktur. Sorgu `readOnly` sınırı içinde çalışır (`admin/bounds.ts`).
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
| **C. Davranışsal analitik** | `user_activity_event` (`search_submitted`, `product_viewed`, `merchant_exit`) ve bunlardan türeyen sayaçlar | **açık rıza** (analitik) | **gerekir** |

- A sınıfı veriler rıza durumundan etkilenmez; rıza geri alınınca da
  silinmez.
- C sınıfı veriler hiçbir koşulda A ya da B sınıfının hukuki sebebine
  yaslanarak toplanmaz.
- Gezinme geçmişi (`product_view`, kullanıcıya gösterilen "son
  gezilenler") ayrı bir özelliktir. O da kendi rızasına
  (`browsing_history`) bağlıdır ve C'nin yerine geçmez.
- `session_started` ayrı bir olay değildir: oturum yalnızca girişte açılır.
  Bu yüzden `auth_event.sign_in` ile aynı şeydir.
- Kaydetme ve kaldırma (`item_saved`/`item_unsaved`) analitik olayı olarak
  **yazılmaz**: `saved_item` canonical durumdur ve sayısı oradan ucuzca
  okunur. Analitik bir ihtiyaç doğarsa önce bu karar güncellenir.
- `alternative_clicked` bugün yazılmaz: alternatif listesi ayrı bir çıkış
  üretmiyor (alternatifler ürün sayfasına gider ve orada `product_viewed`
  olur). CHECK listesine yalnızca gerçekten yazılan türler girer.

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

**Gerçek kaynak (güncel main).**

- Rızanın tek kaynağı `user_consent` tablosudur:
  - Şeması 0009'dan gelir: `id`, `user_id`, `kind`, `granted`,
    `granted_at`, `ip`.
  - `kind` CHECK değerleri: `browsing_history`, `marketing_email`,
    `personalization`, `public_discovery`.
  - Okuma ve yazma `packages/core/src/account/consent.ts` içindedir
    (`getConsents`, `setConsent`).
  - Pazarlama uygunluğu da aynı kuralla okunur
    (`packages/core/src/marketing/eligibility.ts`, 0048).
- **Güncel durum** her `kind` için en son satırdır: `granted_at DESC`,
  eşitlikte `id DESC`. Hiç satır yoksa durum `false`'tur (opt-in).
- Tablo bir **geçmiş tablosudur**: kod yalnızca INSERT yapar, UPDATE
  yapmaz. Bugün bu bir kod kuralıdır; uygulama rolünden UPDATE/DELETE
  yetkisi veritabanı düzeyinde **alınmamıştır**. Bunu motor düzeyine
  taşımak ayrı, additive bir migration kararıdır (aşağıda).
- Main'de `source`, `text_version` ya da `recorded_at` kolonu **yoktur**.
  Merge edilmemiş 0033 dalına dayanılmaz.

**Bu kararın eklediği (migration 0037, yalnızca genişletme).**

- `kind` CHECK genişletilir: `cookie_functional`, `cookie_analytics`,
  `cookie_marketing`, `privacy_notice`. Mevcut değerler aynen kalır.
- İki **nullable** kolon eklenir: `source` ve `text_version`.
  - `source` değerleri CHECK ile sınırlı bir listedir: `account_settings`
    (`/hesap`), `cookie_banner` (bant/tercih formu), `cookie_sync` (girişte
    çerez kararının aktarımı), `sign_in` (aydınlatma kaydı),
    `unsubscribe_link` (pazarlama iptal bağlantısı).
  - Yeni satırlar ikisini de doldurur. Mevcut satırlar NULL kalır; veri
    taşınmaz, satırlar yeniden yazılmaz.
  - Kolonlar main'e başka bir iş tarafından eklenmişse yeniden
    oluşturulmaz (`IF NOT EXISTS`); yalnızca eksik CHECK değerleri
    genişletilir.
- `user_consent` yetkileri bu kararda **değişmedi**. Uygulama kodu tabloya
  yalnızca INSERT yapar; tek istisna günlük temizliğin 1 yılı geçen `ip`
  değerlerini NULL'a çekmesidir. UPDATE/DELETE'i motor düzeyinde kaldırmak
  ayrı bir karardır; o zaman `ip` temizliği kolon düzeyinde bir GRANT ile
  korunur.
- `setConsent` (hesap izinleri) yalnızca dört hesap türünü yazar ve türü
  çalışma zamanında doğrular: server action girdisi tipsizdir; istemci
  `privacy_notice` ya da `cookie_*` yazamaz.

**Mevcut kayıtlar geçersiz sayılmaz.**

- Bugünkü her `user_consent` satırı, `text_version` bilgisi olmasa da
  **geçerli bir karardır** ve güncel durumu belirlemeye aynen devam eder.
  `/hesap` izinleri ve pazarlama uygunluğu (0048) değişmez.
- `text_version` bilgisi olmayan satırlar yönetim arayüzünde yalnızca
  **"sürümsüz kayıt"** etiketiyle gösterilir. Bu etiket yalnızca
  bilgilendirmedir: durumu "bilinmiyor"a çevirmez, izni kapatmaz.

**Durumlar** ayrı bir kolonda tutulmaz, satırlardan türetilir:

- **kabul:** son satır `granted = true`.
- **ret:** son satır `false` ve öncesinde `true` yok.
- **geri alma:** son satır `false` ve öncesinde `true` var.
- **kayıt yok:** o tür için hiç satır yok. İşleme açısından **izin
  yok**'tur (mevcut opt-in varsayılanı). Arayüzde "kayıt yok" yazar, asla
  "kabul" yazmaz.

**Diğer kurallar.**

- `privacy_notice` bir **rıza değildir**. Kullanıcıya hangi aydınlatma
  metni sürümünün gösterildiğinin kaydıdır. Arayüzde rızalardan ayrı
  grupta gösterilir ve hiçbir işlemenin ön koşulu yapılmaz.
- **Mevcut kullanıcılar için rıza uydurulmaz.** Backfill, geriye dönük
  hiçbir rıza satırı yazmaz. Özellikle `cookie_analytics` için geçmişe
  dönük "kabul" üretilmez.
- Girişli kullanıcı çerez bandında karar verdiğinde karar hem çereze hem
  `user_consent`'e yazılır (`source = 'cookie_banner'`, `text_version` =
  çerez rıza sürümü). Anonim ziyaretçinin kararı sunucuya yazılmaz (0038).
- Yeni rıza türlerinin satırlarına IP yazılmaz. Mevcut `setConsent` (dört
  hesap izni) IP yazmaya devam eder; bu IP 1 yıl sonra NULL'a çekilir (§10).

### 7. Analitik rıza kapısı

- C sınıfı her yazım tek bir core fonksiyonundan geçer
  (`packages/core/src/activity/record.ts`). Başka bir yerden
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
    Silme uygulama rolünün kendi DELETE yetkisiyle yapılır (0036: bu
    tabloda UPDATE yok, DELETE var); SECURITY DEFINER istisnası (0021)
    açılmaz.
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

Süre dolumu mevcut günlük `/api/cron/cleanup-auth` işine eklendi (yeni
cron yok): `packages/core/src/activity/retention.ts`, küçük partilerle,
sınırlı turla, idempotent. Yetki en aza indirilmiştir: `auth_event` ve
`user_activity_event`'te uygulama rolü UPDATE yapamaz (tek istisna
`query_norm` kolonu), DELETE yapabilir. SECURITY DEFINER kullanılmaz.

### 11. Veri modeli (migration 0036, 0037)

- Domain tabloları kaynak olarak kalır: `click`, `saved_item`,
  `ai_search_charge`, `product_view`. Bunlar için ayrı olay tabloları
  (`search_events`, `favorite_events`, `affiliate_click_events`…)
  **açılmaz**.
- Yeni tablolar:
  - `auth_event` (A sınıfı; UPDATE yok, saklama süresi için DELETE var;
    hesap başına tek `sign_up` kısmi benzersiz indeksle)
  - `user_activity_event` (C sınıfı; **tipli kolonlar** ve tür başına
    biçim CHECK'i, serbest JSONB yok; UPDATE yalnızca `query_norm`)
  - `user_activity_summary` (kullanıcı başına tek satır; olayla aynı
    işlemde artırılır)
- `session` tablosuna üç nullable kolon eklenir: `device_class`,
  `browser_family`, `country_code`.
- `last_active_at` oturum doğrulamasında **15 dakikalık eşikle**
  güncellenir; her istek yazmaz.
- Migration numaraları main'deki son migration'dan (`0035_marketing_campaign`)
  sonra başlar: 0036 ve sonrası. Açık dallar için ayrılmış 0032/0033
  boşluklarına yazılmaz.

### 12. Uygulama notları

- **Giriş:** dört giriş yolu (e-posta bağlantısı, Google, Apple, telefon)
  `createSessionForUser`'da birleşir. Aşağıdakiler oturum satırıyla AYNI
  işlemde yazılır:
  - `auth_event` (`sign_up` yalnızca hesap o işlemde açıldıysa, ardından
    `sign_in`)
  - özet güncellemesi
  - kaba bağlam

  Eşzamanlı ilk girişte ikinci `sign_up` satırını kısmi benzersiz indeks
  engeller.
- **Çıkış:** kullanıcının kendi çıkışı `sign_out`. Yönetim oturum
  politikasının sonlandırması (`apps/web/app/lib/dal.ts`) ve "tüm
  cihazlardan çıkış" `session_revoked`. Olay oturum silmeyle aynı işlemde
  yazılır.
- **Son aktif:** `verifySessionToken` bu oturumun önceki kullanımı 15
  dakikadan eskiyse koşullu bir upsert atar. Aksi halde hiç sorgu atmaz.
  Değer geriye gitmez.
- **Rıza senkronu:** girişten sonra (`apps/web/app/giris/consent-sync.ts`)
  iki şey yapılır:
  - Tarayıcının geçerli çerez kararı, hesapta daha yeni bir karar yoksa
    `cookie_sync` olarak hesaba yazılır.
  - Giriş ekranında bağlantısı gösterilen gizlilik metninin sürümü
    (`PRIVACY_NOTICE_VERSION`) bir kez kaydedilir.

  Apple callback'i siteler arası POST olduğu için `SameSite=Lax` çerez
  o istekte gelmez; senkron hiçbir şey yazmaz, izin varsayılmaz. Senkron
  hatası girişi bozmaz.
- **Analitik olayları:**
  - `search_submitted`: girişli kullanıcıda, yeni bir aramanın ilk
    sayfasında; aynı normalize sorgu 10 dakika içinde tekrar sayılmaz.
  - `product_viewed`: aynı ürün 30 dakika içinde tekrar sayılmaz.
  - `merchant_exit`: `/git` çıkışında, `click` yazıldıktan sonra.

  Analitik hatası sayfayı ve yönlendirmeyi bozmaz.
- **Tıklama:** `/git` rotası girişli kullanıcıda `click.user_id`'yi
  attribution amacıyla doldurur. `surface` serbest metin değildir: yalnızca
  `CLICK_SURFACES` listesindeki değerler yazılır, diğerleri NULL olur.

## Gerekçe

- Kişi bulma ihtiyacı kısmi aramayla zaten karşılanıyordu, ama sınırları
  yazılı değildi. Yazılmayan sınır, ilk değişiklikte gevşer.
- Erken erişim dönemi boyunca "kim giriş yaptı, kim aktif" sorusu
  `psql`'e düşüyordu. Kontrollü bir liste, bu soruyu denetimli ve maskeli
  bir yoldan cevaplar.
- Rıza modelinin tek kaynağını korumak (0048 ile aynı ilke), iki iş
  kolunun aynı tabloyu farklı yorumlamasını önler. Mevcut kayıtları
  geçersiz saymak, kullanıcıların verdiği izinleri sessizce kapatırdı.
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
- **Liste ya da arama sonucunda tam e-posta:** toplu kişisel veri dökümüne
  kapı açar. Tam değer yalnızca tek hesap için, taze girişle açılır (§2).
- **Mevcut kısmi aramayı kaldırmak:** destek işini tekrar `psql`'e iter.
  Sınırlarını yazmak (§1a) daha güvenlidir.
- **Sınırsız arama (minimum uzunluk, sayfa tavanı ya da denetim olmadan):**
  sessiz taramaya kapı açar.
- **0033 dalının rıza modelini almak** (`text_version` olmayan satırları
  geçersiz saymak): mevcut izinleri sessizce kapatırdı ve 0048 bunu
  reddetti.
- **Tıklama verisinden kullanıcı ilgi profili çıkarmak:** attribution
  amacının dışına çıkar (§5).

## Açık bağımlılıklar

1. Production veritabanı main'deki son migration'a (0035) getirilmeden
   0036 ve 0037 uygulanmaz (`docs/ops.md`).
2. Supabase Data API'nin açık olup olmadığı production panelinden
   kontrol edilmeli (`docs/ops.md`).
3. Arama için keyset sayfalamaya geçiş (§1a) P5'te yapılır; P0'da kod
   değişmez.
4. `/gizlilik` ve `/kvkk-aydinlatma` metinleri analitik olayları, kaba
   cihaz/ülke bilgisini ve saklama sürelerini anlatacak şekilde
   güncellenmeli. Bu güncelleme hukukçu onayı gerektirir. **Sayfa
   adresleri değişmez.**
