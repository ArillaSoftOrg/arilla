# KVKK ve hukuki uyum

Bu dosya yapıyı tanımlar. **Metinlerin nihai hali bir hukukçu tarafından
onaylanmalıdır**; burada yazılanlar hukuki görüş değil, ürün ekibinin uyması
gereken teknik ve tasarım kurallarıdır.

## Veri sorumlusu

Şirket kurulduğunda veri sorumlusu sıfatı şirkete ait olur. Çalışan sayısı ve
ciro eşiklerine göre **VERBİS kaydı** gerekebilir; şirket kuruluşunda kontrol
edilmeli.

## İşlenen veri kategorileri

| Veri | Nerede | Hukuki sebep | Saklama |
| --- | --- | --- | --- |
| E-posta adresi | `app_user` | Sözleşmenin ifası | Hesap silinene kadar |
| Oturum ve giriş kayıtları | `session`, `auth_token` | Meşru menfaat (güvenlik) | Token 15 dk, oturum 90 gün |
| Erken erişim kaydı | `early_access` | Sözleşmenin ifası (listeye katılma) | Hesap silinene kadar |
| Arama hakları ve bonus defteri | `ai_quota_day`, `bonus_account`, `bonus_ledger`, `ai_search_charge` | Sözleşmenin ifası (hak hesabı) | Hesap silinene kadar (0047) |
| Davet kaydı | `referral` | Sözleşmenin ifası (davet ödülü) | Hesap silinene kadar; silme sonrası kimlik özeti tutulmaz (0047) |
| Gezinme geçmişi | `product_view` | **Açık rıza** | Son 50 kayıt, hesap silinince silinir |
| Kaydedilenler, alarmlar | `saved_item`, `alert` | Sözleşmenin ifası | Hesap silinene kadar |
| Beden profili | `user_size_profile` | Açık rıza | Hesap silinene kadar |
| Tıklama ve dönüşüm | `click`, `conversion` | Meşru menfaat + sözleşme | 5 yıl (mali mevzuat) |
| Yüklenen görseller | obje deposu | Açık rıza | **En fazla 30 gün** |
| Pazarlama e-postası izni | `user_consent` | Açık rıza + İYS | İzin geri alınana kadar |
| IP adresi | `auth_token`, `phone_login_code`, `session`, `user_consent` (eski satırlar) | Meşru menfaat (güvenlik) | Giriş kayıtları en fazla 1 gün, oturum ömrü kadar; `user_consent.ip` 1 yıl sonra NULL (0049). Yeni çerez ve aydınlatma kayıtlarına IP yazılmaz (0049); hesap izinleri (`setConsent`) IP yazmaya devam eder. |
| Giriş/çıkış geçmişi (0049, 0036/0037) | `auth_event` | Meşru menfaat (güvenlik) | 1 yıl |
| Kaba cihaz/tarayıcı/ülke (0049, 0036/0037) | `session`, `auth_event`, `user_activity_summary` | Meşru menfaat (güvenlik) | Bağlı satırla birlikte; ham user agent ve IP'den konum yok |
| Hesap özeti, son aktif zamanı (0049, 0036/0037) | `user_activity_summary` | Sözleşmenin ifası / meşru menfaat | Hesap silinene kadar; analitik sayaçları rıza geri alınınca NULL |
| Çerez rızası ve aydınlatma sürümü (girişli) (0049, 0036/0037) | `user_consent` | Açık rıza (çerez); aydınlatma rıza değildir | Hesap silinene kadar (ispat) |
| Davranışsal analitik (0049, 0036/0037) | `user_activity_event` | **Açık rıza** (analitik) | 180 gün; `query_norm` 90 gün; rıza geri alınınca silinir |
| Arama kalitesi günlük özeti (0052, 0054) | `search_query_day` | Meşru menfaat (hizmet kalitesi); **kullanıcı, oturum veya cihaz tanımlayıcısı içermeyen toplulaştırılmış arama verisi** (kullanıcı, oturum, IP yok; anonim olduğu garanti edilmez); e-posta, telefon, adres, URL, 7+ haneli rakam içeren sorgu yazılmaz | 90 gün |

0049 satırlarının tabloları migration 0036/0037 ile şemadadır. Production'a
bu migration'lar uygulanmadan önce aydınlatma metninin bu satırları
anlatması gerekir (yapılacaklar listesi); metin koddan geride kalmamalıdır.

Gezinme geçmişi ve kişiselleştirme **rızaya bağlıdır ve reddedilebilir
olmalıdır.** Reddedildiğinde ürün çalışmaya devam eder, sadece kişiselleştirme
kapalı olur.

## Kullanıcı aktivitesi ve analitik rızası

Ayrıntı: `docs/decisions/0049`. Bu bölümdeki kurallar teknik uygulamayı
tanımlar; aydınlatma metninin bunları anlatan hali hukukçu onayı ister.

**Üç sınıf karıştırılmaz.**

1. **Hizmet / güvenlik:** hesap, oturum, giriş/çıkış geçmişi, son aktif,
   kaba cihaz/ülke, kaydedilenler, arama hakkı. Rıza gerektirmez ve rıza
   kararından etkilenmez.
2. **Attribution:** `click`, `conversion`. Mali mevzuat ve sözleşme
   gereğidir. **Davranışsal profillemeye kaynak olmaz.** Kullanıcı başına
   ilgi, segment, kişiselleştirme ya da pazarlama sinyali için okunmaz.
3. **Davranışsal analitik:** arama, ürün görüntüleme, kaydetme/kaldırma,
   mağaza çıkışı, alternatif tıklaması. Yalnızca analitik rızasıyla ve
   yalnızca girişli kullanıcı için yazılır.

**Rıza durumları.** Tek kaynak `user_consent` tablosudur (0009; pazarlama
için de aynı kaynak, 0048). Bu tablo bir geçmiş tablosudur: kod yalnızca
satır ekler ve her satır bir karardır. Güncel durum her tür için en son
satırdır. Kabul, ret ve geri alma bu satırlardan türetilir.

- **Kayıt yok:** o tür için hiç satır yoksa izin **yoktur** (opt-in).
  Yönetim ekranında "kayıt yok" diye gösterilir.
- **Mevcut kayıtlar geçerlidir.** Metin sürümü bilgisi taşımayan eski
  satırlar geçersiz sayılmaz, durumu değiştirmez. Yönetim ekranında
  yalnızca "sürümsüz kayıt" etiketiyle gösterilir.
- **Mevcut kullanıcılar için geriye dönük rıza kaydı üretilmez.**
- **Yeni hesap varsayılanı (0060, 0045):** hesap açılırken kişiselleştirme,
  gezinme geçmişi ve anonim keşif `granted = true`, `source = 'signup_default'`
  olarak yazılır; haftalık özet ise yalnızca onboarding anketinin son adımında
  kullanıcı açıkça açarsa (varsayılan kapalı, ilk karar değişmez) (`source = 'onboarding'`). Geri çekme: `/hesap/gizlilik`. Bu varsayılan açık rıza
  açısından hukuk onayı bekler (0060 "Risk").
- Çerez kategorileri, aydınlatma sürümü ve kayıt kaynağı için gereken yeni
  alanlar ileride geriye uyumlu (additive) bir migration ile eklenir
  (0049 §6). Mevcut satırlar yeniden yazılmaz.
- **Aydınlatma metninin gösterildiği sürüm** (`privacy_notice`) ayrı bir
  kayıttır ve rıza sayılmaz. Hiçbir işleme bu kayda dayanmaz.
- Anonim ziyaretçinin çerez tercihi yalnızca kendi tarayıcısındaki
  çerezde kalır (0038). Girişli kullanıcının kararı ayrıca hesaba yazılır.

**Ret ve geri alma.**

- Reddedilirse analitik hiç başlamaz.
- Geri alınırsa aynı işlemde kullanıcının analitik olayları silinir ve
  analitik sayaçları boşaltılır.
- Hizmet ve attribution verisi değişmez. Ürün aynı şekilde çalışır.
- Yeniden rıza verilirse sayım sıfırdan başlar.

**Konum.** Yalnızca barındırma platformunun bildirdiği iki harfli ülke kodu
tutulur. Bu kod güvenlik bağlamıdır (tanınmayan giriş). Saklanan IP'den
konum çıkarılmaz; şehir ve koordinat toplanmaz. Ülke kodu analitikte,
kişiselleştirmede ve pazarlamada kullanılmaz.

**Hesap silme.**

- `auth_event`, `user_activity_event` ve `user_activity_summary` hesapla
  birlikte silinir (CASCADE).
- `click` kalır ama `user_id` NULL'a çekilir.
- Yönetim denetim kaydında yalnızca sayısal hesap kimliği kalır; kişisel
  veri içermez.

**Yönetim erişimi.**

- Kullanıcı araması ve listesi yalnızca yöneticiye açıktır. Sonuçlarda
  e-posta ve telefon maskelidir.
- Arama sınırlıdır: en az 2 karakter, sayfa başı 20 sonuç, en fazla 50
  sayfa. Her arama denetime yazılır; aranan değer kayda yazılmaz (0049 §1a).
- Arama sonucu hiçbir bilgiyi otomatik olarak maskesiz açmaz.
- Tam e-posta/telefon yalnızca son 1 saat içinde giriş yapmış bir
  yönetici tarafından, tek tek açılabilir. Her açılış denetime yazılır;
  açılan değer kayda yazılmaz.
- Liste, ayrıntı ve hassas sekme görüntülemeleri de denetime yazılır.
- IP, ham user agent, token ve sağlayıcı kimliği hiçbir yönetim ekranında
  gösterilmez.

## Yüklenen görseller — en riskli alan

Kullanıcı görsel arama için herhangi bir fotoğraf yükleyebilir. Pratikte
yüklenecekler arasında yüz fotoğrafları, ekran görüntüleri ve uygunsuz içerik
olacaktır.

Kurallar:

1. **Arama sonrası görsel saklanmaz.** Yalnızca embedding vektörü ve görsel
   hash'i tutulur. Ham dosya en fazla 30 gün geçici depoda kalır, sonra silinir. Fiyatsız link kaynağının görsel izi (`image_upload` + embedding) da 30 gün sonra günlük temizlikte silinir; yalnızca süresi dolmamış bir sohbetin anmaya devam ettiği kaynak sohbetin ömrü (en fazla 90 gün) kadar kalır (karar 0090).
2. **Yüz tespiti varsa uyarı gösterilir.** İnsan içeren fotoğraf yüklendiğinde
   kullanıcı bilgilendirilir; biyometrik veri işleme iddiasından kaçınmak için
   yüz bölgesi hiçbir modele ayrıca beslenmez.
3. **Ürün olmayan görsel reddedilir.** Sonuç dönmez, dosya saklanmaz.
4. **Moderasyon.** Uygunsuz içerik tespitinde sorgu reddedilir ve kayıt tutulur.
5. Yükleme ekranında tek satır bilgi: fotoğrafın ne için kullanıldığı ve ne
   kadar saklandığı.

Bu kurallar ilk görsel arama satırı yazılmadan önce uygulanmalıdır.

**Sohbet eki (karar 0078, 0091).** Sohbete eklenen görsel (ilk mesajda ya da sohbet içinde, konuşma başına en fazla 5) yalnızca sahibine görünür, sohbetle aynı ömürde (en fazla 90 gün) tutulur ve Gemini'ye gönderilir; yalnızca `CHAT_IMAGE_ENABLED` ile, hukuk onayı ve açık rıza metni sonrası açılır. Model, görselin kısa bir ürün özetini üretir ve sohbet mesajıyla birlikte saklar; takip turlarında görselin kendisi yerine bu özet gider, görsel yalnızca özet yoksa ya da kullanıcı görsele atıf yapıyorsa yeniden gönderilir. Ana sayfadan yeni sekmeye geçişte görsel tarayıcıda yalnızca tek kullanımlık, en fazla 60 sn yaşayan geçici bir IndexedDB kaydında bulunur (sunucu teslim alınca ya da süre dolunca silinir); `localStorage`'a görsel yazılmaz. Açık rıza ve aydınlatma metni tamamlanmadan özellik production'da açılmaz.

## İlgili kişi hakları

KVKK m.11 kapsamındaki haklar `/hesap` altından fiilen kullanılabilmelidir:

- **Görüntüleme** — hakkımdaki verileri indir (JSON)
- **Düzeltme** — profil bilgilerini değiştir
- **Silme** — gezinme geçmişini sil, hesabı tamamen sil
- **İtiraz** — kişiselleştirmeyi kapat, analitik rızasını geri al (0049:
  geri alma kullanıcının analitik olaylarını da siler)
- **Görüntüleme kapsamı** — indirilen veride rıza geçmişi, giriş geçmişi,
  hesap özeti ve analitik olayları da bulunur (0049)

Silme gerçekten silmelidir. Arayüzde var görünüp arkada saklamak ihlaldir.
Hesap silindiğinde `click` ve `conversion` kayıtları mali mevzuat gereği
kalabilir ama **kimliksizleştirilir** (`user_id` NULL'a çekilir).
Yönetim denetim kaydı (`admin_audit_event`) da kalır; silinen hesabın aktör
bağlantısı NULL'a çekilir, satırda e-posta/IP yoktur. Yönetim yetkili bir hesap
silinmeden önce rolü bırakılır (karar 0050).

Talepler en geç 30 gün içinde sonuçlandırılmalı; otomatik akış bunu anında
yapabilir.

## Yurt dışına aktarım — dikkat

Altyapının tamamı yurt dışında: Vercel, Neon, obje deposu, model sağlayıcısı,
e-posta sağlayıcısı. Bu, KVKK kapsamında **yurt dışına veri aktarımıdır** ve
ayrı bir hukuki temel gerektirir.

Yapılması gerekenler: her sağlayıcı için standart sözleşme hükümlerinin
imzalanması, aydınlatma metninde aktarımın açıkça belirtilmesi, ve mümkün olan
yerde Avrupa bölgesinin seçilmesi.

Bu kalem sık atlanıyor ve denetimde ilk sorulanlardan biri.

**Model sağlayıcısı bu kalemin en hassas parçası**, çünkü kullanıcının
yüklediği fotoğraf embedding üretimi için sağlayıcıya gidiyor. Seçim bu
gerekçeyle yapıldı: embedding sağlayıcısı **Jina AI GmbH (Berlin)**, yani AB
merkezli bir tüzel kişi — "mümkün olan yerde Avrupa bölgesinin seçilmesi"
kuralının doğrudan uygulanması. Gerekçe ve reddedilen alternatifler:
`docs/decisions/0015-embedding-saglayici.md`.

Bu, aktarımı ortadan kaldırmaz; standart sözleşme hükümleri ve aydınlatma
metnindeki açık beyan yine gerekli. Yalnızca aktarımın gittiği yeri
denetlenebilir bir hukuki çerçeveye taşır.

### Sorgu yorumlama (Google Gemini) — hukuken onaylı; üretimde anahtar eklenince etkin

Karar 0059. Hukuki onay alınmıştır; teknik etkinleştirme `GEMINI_API_KEY`'in
üretime (Vercel) bilinçli olarak eklenmesiyle olur. Anahtar eklenene kadar
Google'a hiçbir arama metni gönderilmez. Toplu iş günde bir kez (Vercel cron,
00:30 UTC) çalışır; koşu başına ve gün başına tavanlar `docs/ops.md`'de. Sıra: `docs/ops.md`
"Etkinleştirme sırası".

**Hukuki karar kaydı** (sözleşme metni ve gizli koşullar burada tutulmaz):
- Hukuk danışmanı üretimde etkinleştirmeyi **onayladı**.
- Hukuki sebep: **KVKK m.5/2-f (meşru menfaat)**; değerlendirme:
  `docs/legal-review/gemini-mesru-menfaat-degerlendirmesi.md`.
- KVKK m.9 kapsamında gerekli aktarım sözleşmesi Google ile **imzalandı**.
- Sözleşme tarafı Google tüzel kişisi, imza tarihi ve onaylayan kişi hukuki /
  sözleşme kaydında tutulur; bu depoda yer almaz. Kamuya açık metinler
  sağlayıcıyı "Google (Gemini API)" olarak anar.
- Kurum'a bildirim: tamamlandığına dair bu depoda kayıt **yoktur**; durum
  hukuki kayıtta izlenir (bkz. kontrol listesi).

**Anlık yol (karar 0062).** `GEMINI_REALTIME_ENABLED` açıkken aynı metin
süzgecinden geçen arama ifadesi arama sırasında da Gemini'ye gönderilebilir
(tekrar eşiği yok; aynı ifade daha önce yorumlandıysa yeniden gönderilmez).
Gönderilen veri, saklama ve `store: false` aşağıdaki toplu yolla aynıdır.
`/gizlilik` §2.2 ve §5 ile `/kvkk-aydinlatma` §5 bu zamanlamayı anlatır.

**Veri akışı.** Çevrimdışı toplu iş,
`search_query_day`'deki toplu günlük özetten (kullanıcı, oturum veya cihaz
tanımlayıcısı içermez) son 30 günde **en az 3 kez ve en az 3 farklı günde**
aranmış normalize edilmiş arama ifadelerini Gemini API'ye (Paid Services)
gönderir. Kullanıcı, oturum, IP ya da `user_activity_event` kaydı
gönderilmez. **Gönderilen metin anonim değildir; anonimlik garanti
edilmez:** kullanıcının yazdığı serbest metin kendi başına bir kişiyi
belirleyebilecek bilgi içerebilir. Deterministik süzgeç şunları içeren sorguyu eler: e-posta,
telefon, adres, URL, uzun rakam/kimlik numarası benzeri, anahtar/şifre
benzeri ve özel nitelikli veri bağlamı (sağlık, gebelik, engellilik /
inkontinans, din/mezhep kimliği, siyasi bağlılık, cinsel hayat/yönelim,
genetik/biyometrik, ceza mahkûmiyeti, sendika). Süzgeç küçük bir kök
listesidir (`packages/core/src/search/interpretation-eligibility.ts`):
yanlış pozitif bilerek kabul edilir, **yanlış negatif mümkündür** (dolaylı
anlatım, yazım hatası; ırk/etnik köken listede yoktur). Süzgeçler riski
azaltır, **tüm kişisel veya özel nitelikli verinin ayıklandığını garanti
edemez**: dolaylı anlatım, yazım hataları ve listede olmayan hassas terimler
süzgeçten geçebilir. **3 farklı gün bir tekrar sinyalidir, 3 farklı kişi
olduğunun kanıtı değildir**: aynı kişi üç farklı günde ararsa eşik yine aşılır.

**Saklama.** Dönen yorum yalnızca taksonomi kimlikleri olarak
`query_interpretation`'a yazılır, ham yanıt saklanmaz; satırlar `created_at`'ten
itibaren **90 gün** tutulur ve günlük temizlik cron'u (`cleanup-auth`) siler.

**`store: false` ne yapar, ne yapmaz.** Interactions API'nin etkileşim durumu
saklamasını kapatır (Google'ın belgesine göre varsayılan açıktır; ücretli
katmanda 55 gün). **İşlemeyi ya da Google'a aktarımı ortadan kaldırmaz.**
Gemini API Paid Services koşullarına göre Google istem ve yanıtları ürünlerini
geliştirmek için kullanmaz, ancak Yasaklı Kullanım Politikası ihlallerini
tespit etmek amacıyla **sınırlı bir süre kayıt tutar** (süre belirtilmemiştir);
veriler Google'ın tesislerinin bulunduğu ülkelerde geçici olarak işlenebilir.
Paid Services, Google'ın "Data Processing Addendum for Products Where Google
is a Data Processor" kapsamındadır. Bu DPA'nın aktarım araçları AB/BK/İsviçre
SCC'leri ve benzerleridir; **KVKK standart sözleşmesi değildir ve tek başına
KVKK m.9'u karşıladığı varsayılmaz.** Aktarım, ayrıca imzalanan KVKK m.9
aktarım sözleşmesine dayanır.

#### Etkinleştirme kontrol listesi

- [x] Hukuk danışmanı üretimde etkinleştirmeyi onayladı (onay kaydı hukuki kayıtta)
- [x] KVKK kapsamında işleme şartı: m.5/2-f meşru menfaat
      (LIA: `docs/legal-review/gemini-mesru-menfaat-degerlendirmesi.md`)
- [x] KVKK m.9 aktarım sözleşmesi Google ile imzalandı (sözleşme tarafı ve tarih
      hukuki / sözleşme kaydında)
- [x] Üretim çalışma rolünün (`arilla_app`) yetkileri SALT OKUNUR sorguyla doğrulandı
      (gerekli SELECT/INSERT/DELETE var; 0046 sonrası `api_usage` DELETE ve
      `query_interpretation` UPDATE yok)
- [ ] Gizlilik politikası ve KVKK aydınlatma metni üretimde yayında (metin bu
      dalda hazır; birleştirme ve dağıtımla tamamlanır, anahtardan ÖNCE)
- [ ] Kurum'a gerekli bildirimin yapıldığı hukuki kayıttan teyit edildi (depoda
      kanıt yok; teyit edilmeden işaretlenmez)
- [ ] VERBİS etkisi (alıcı grubu, yurt dışı aktarım) hukuki kayıttan teyit edildi
- [ ] Google projesinde bütçe uyarısı ve kota tanımlandı

Açık rızanın tekrarlayan bir aktarım için yeterli olduğu varsayılmaz.

#### Kamuya açık metin

Metin doğrudan sayfalarda tutulur (taslak kopyası burada tutulmaz, ayrışmasın):
`/gizlilik` §2.2 (yapay zekâ destekli kategori yorumu), §3 (amaç), §4 (m.5/2-f),
§5 (alıcı), §6 (m.9 aktarım), §8 (90 gün); `/kvkk-aydinlatma` §3, §4, §5.
Sağlayıcı "Google (Gemini API)" olarak anılır; iki sayfanın güncelleme tarihi
`PRIVACY_NOTICE_UPDATED_LABEL` (`apps/web/app/legal-identity-block.tsx`,
6 Ekim 2026).

## Ticari elektronik ileti (İYS)

Türkiye'deki alıcılara ticari e-posta göndermek **İYS kaydı** gerektirir.
Kritik ayrım:

- **İşlemsel ileti** — kullanıcının kendi kurduğu fiyat alarmı, giriş
  bağlantısı. İzin gerekmez.
- **Ticari ileti** — haftalık özet, kampanya duyurusu, öneri e-postası. İYS'ye
  kaydedilmiş açık izin gerekir, her iletide ret hakkı sunulmalıdır.

Haftalık özet e-postası ticari iletidir. Kayıt formundaki onay kutusu
**işaretsiz** gelir ve girişin ön koşulu yapılamaz.

Yönetimden gönderilen e-posta kampanyaları (karar 0048) ticari iletidir:
yalnızca `user_consent`'te `marketing_email` izni güncel olarak açık ve adresi
doğrulanmış hesaplara gider; izin her ileti gönderilmeden hemen önce yeniden
denetlenir. Her iletide girişsiz abonelik iptali (bağlantı + RFC 8058 tek
tık) ve gönderen kimliği bulunur. İptal aynı rıza kaydına ret satırı yazar;
ayrı bir abonelik bayrağı yoktur. Alıcı adresi kampanya kaydında saklanmaz.
**İYS entegrasyonu henüz yok**: üretimde gerçek gönderim
(`MARKETING_EMAIL_ENABLED`) İYS kaydı ve rıza metninin hukuk onayından önce
açılmaz.

## Affiliate bildirimi

Affiliate ilişkisi kullanıcıya açıkça bildirilir. Bildirim çıkış öncesinde ve
altbilgide bulunur; küçük punto ile gizlenmez.

Sponsorlu içerik organik içerikten görsel olarak ayrılır ve rozetle
etiketlenir. `trend_snapshot.is_sponsored` alanı veritabanı kısıtıyla zorunlu
tutulmuştur.

## Çerezler

Zorunlu çerezler (oturum, güvenlik, tema tercihi) rıza gerektirmez. Analitik ve
kişiselleştirme çerezleri gerektirir.

Çerez bandı: kabul ve ret düğmeleri **eşit görsel ağırlıkta** olur. Reddetmeyi
zorlaştıran tasarım kabul edilmez.

### Google Analytics 4 (karar 0087)

- **Dayanak:** açık rıza (analitik çerez kategorisi). Rıza yoksa betik hiç
  yüklenmez; geri alınınca ölçüm anında durur, `_ga` / `_ga_<ID>` silinir.
  `CONSENT_VERSION` 2: eski tercihler yeniden sorulur.
- **Giden veri:** arındırılmış sayfa yolu (sorgu parametreleri, arama metni,
  token, sohbet kimliği, yönetim ve giriş alt yolları YOK), yalnızca güvenli
  UTM değerleri, yönlendiren sitenin kökeni, GA4'ün kendi topladığı cihaz,
  tarayıcı ve IP'den çıkarılan yaklaşık konum, çerez tanımlayıcısı. `user_id`
  gönderilmez; Google sinyalleri ve reklam kişiselleştirmesi kapalı.
- **Yurt dışına aktarım:** Google'ın tesislerinde işlenir; aktarım açık rızaya
  dayanır ve aydınlatma/gizlilik metinlerinde (yalnızca GA4 etkinken) anılır.
- **Saklama:** GA4 mülkünde veri saklama 2 ay (elle ayar, `docs/ops.md`).
- **Yönetim raporu:** yalnızca toplamlar; 5 kullanıcının altındaki ülke,
  bölge ve kaynak satırları birleştirilir. Kişi düzeyinde veri gösterilmez.
- **Hukuki durum:** ürün sahibi 9 Ekim 2026'da gerekliliklerin karşılandığını
  beyan etti; depoda GA4'e özel yazılı hukuk görüşü yok (karar 0087).

## Fiyat ve stok bilgisi sorumluluğu

Gösterilen fiyat ve stok bilgisi üçüncü taraf kaynaklardan gelir ve gecikmeli
olabilir. Kullanım koşullarında sorumluluk sınırlandırılır; arayüzde her fiyatın
yanında son güncelleme zamanı gösterilir.

## Marka ve görsel kullanımı

Ürün görselleri ve marka adları merchant kaynaklıdır. Karşılaştırma amaçlı
kullanım genelde meşrudur ancak "dupe" ve "muadili" gibi ifadelerin marka
hakları açısından değerlendirilmesi gerekir. Bu konu hukukçuya ayrıca sorulmalı.

## Yapılacaklar listesi

- [ ] Aydınlatma metni (hukukçu onaylı)
- [ ] Açık rıza metinleri: gezinme geçmişi, kişiselleştirme, ticari ileti
- [ ] Gizlilik politikası ve kullanım koşulları
- [ ] Çerez politikası ve bant
- [ ] VERBİS kaydı gerekliliği kontrolü
- [ ] İYS kaydı
- [ ] Yurt dışı aktarım için sağlayıcı sözleşmeleri
- [ ] Veri sahibi talep akışının uçtan uca testi
- [ ] Aydınlatma ve gizlilik metninde analitik olayları, kaba cihaz/ülke
  bilgisi ve saklama süreleri (0049). Hukukçu onaylı olmalı;
  `/gizlilik`, `/kvkk-aydinlatma`, `/cerez` adresleri değişmez.

**Faz 6 notu:** `/gizlilik` ve `/kosullar` altında, yukarıdaki maddeler
tamamlanana kadar geçerli olacak **taslak** sayfalar eklendi — yalnızca bu
dosyadaki ve koddaki doğrulanmış veri akışlarını açıklar, veri sorumlusu
tüzel kişi bilgisi içermez. Yukarıdaki kutucuklar bu yüzden işaretlenmedi;
sayfalar hukukçu onayı ve şirket kuruluşu sonrası güncellenmelidir. `/cerez`
sayfası ise mevcut (yalnızca zorunlu: `session`, `session_id`, `theme`) çerez
envanterini listeler — analitik/pazarlama çerezi olmadığı için consent bandı
kurulmadı. *(Sonradan: bant 0038 ile kuruldu; tercih `cookie_consent`
çerezinde tutulur.)*

**Faz 8.1 notu:** Geçici public iletişim adresi (`apps/web/app/site-config.ts`)
`/iletisim` sayfasında ve `/gizlilik` "Haklarınız" bölümünde soru kanalı olarak
gösterilir. Bu, veri sorumlusu bildirimi **değildir** — "Veri sorumlusu"
bölümü ve yukarıdaki kutucuklar tüzel kişi kurulana kadar açık kalır.

**Geri bildirim notu (0045):** `/geri-bildirim` formu tür, başlık, açıklama,
önem seviyesi ve (anonimde isteğe bağlı) e-posta toplar; girişli gönderim
`user_id` ve hesap e-postasıyla bağlanır, hesap silinince satırlar silinir
(`ON DELETE CASCADE`), veri indirme çıktısına dahildir. Oran sınırı IP'nin
SHA-256 özetiyle 10 dakika tutulur. `/gizlilik` 2.4 ve `/kvkk-aydinlatma`
"Talep/şikâyet" maddesi bu akışı kapsar. Anonim gönderimler için somut
saklama süresi henüz tanımlı değil (hukukçu onayıyla belirlenecek).

**İletişim formu notu (0061):** `/iletisim` aynı `feedback` tablosuna
(`kind = 'contact'`) ad, e-posta (zorunlu), konu, başlık ve mesaj yazar.
Girişli gönderim yalnızca sunucu oturumundan `user_id` ile bağlanır; hesap
silme, veri indirme ve oran sınırı geri bildirimle aynıdır (ortak kota).
Mesajlar yalnızca `messages.read` (yönetici) ile `/yonetim/mesajlar`'da
okunur, her görüntüleme denetime yazılır. `/gizlilik` 2.4 ve
`/kvkk-aydinlatma` "Talep/şikâyet" maddesi bu akışı kapsar. Anonim
gönderimlerin saklama süresi geri bildirimdeki açık kalemle aynıdır: henüz
tanımlı değil.

**Anket / form notu (0058):** `/anket/<slug>` formları seçenek ve metin
cevabı toplar. Girişli yanıt `user_id` ile hesaba bağlanır (hesap silinince
`ON DELETE CASCADE`); anonim yanıtta kimlik ve IP yoktur (oran sınırı IP'nin
SHA-256 özetiyle Redis'te 10 dk / 24 saat tutulur). "Şimdilik geç" yalnızca
`form_skip` satırı bırakır. Yanıtlar yalnızca `forms.manage` (yönetici)
yetkisiyle okunur, her sonuç görüntülemesi `forms.results_view` olarak
denetlenir; sonuç ekranı e-posta değil hesabın public kimliğini gösterir.
Veri indirme çıktısına dahildir. `/gizlilik` 2.5 ve `/kvkk-aydinlatma`
"Talep/şikâyet" maddesi bu akışı kapsar. Anonim ve girişli yanıtların somut
saklama süresi henüz tanımlı değil (hukukçu onayıyla belirlenecek).


## Konuşmalı keşif (`/sohbet`, karar 0074)

- Veri: kullanıcının sohbet mesajları (serbest metin) ve çıkarılan arama niyeti;
  `conversation` / `chat_message`, kullanıcıya bağlı. Hesap silinince CASCADE; son
  mesajdan 90 gün sonra silinir.
- Aktarım: her kullanıcı mesajı (son 12 mesaj bağlamıyla) Gemini'ye gider; kimlik,
  e-posta, IP gönderilmez. Özel nitelikli/kişisel veri/sır süzgeci (0059) mesaja
  uygulanır; eşleşen mesaj modele gitmez.
- **Etkinleştirme öncesi (açık):** hukuk danışmanı onayı (0059 yalnızca filtrelenmiş
  toplu sorgu içindi), aydınlatma/gizlilik metninde sohbet içeriği ve 90 gün saklama,
  `/hesap/veri-indir` kapsamına sohbetlerin eklenmesi kararı.

### Sohbet geri bildirimi: neden ve yorum (karar 0079)

- Veri: yanıt başına evet/hayır oyu (`chat_result_feedback`), olumsuzda isteğe bağlı
  neden kodu (`reasons`) ve en çok 500 karakterlik serbest metin `comment`; oy anındaki
  yaklaşık `model_version`. Kişi kimliği ayrı kolonda tutulmaz: sahiplik
  `conversation.user_id` üzerinden; oy sohbetle birlikte (hesap silme, 90 gün) gider.
- **Yorum kişisel veri içerebilir.** Arayüz "kişisel bilgi yazma" uyarısı verir. Yorum
  son değişiklikten 90 gün sonra `NULL`'lanır (`cleanup-auth`, `purgeExpiredFeedbackComments`);
  oy ve neden istatistiği kalır. Kamuya açık saklama süresi hukuk onayı bekler.
- Amaç: hizmet kalitesi analizi. **Model eğitimi için kullanılmaz;** oylar modeli
  otomatik değiştirmez, yalnızca kontrollü iyileştirme sinyalidir.
- Yönetici erişimi: yalnızca `feedback.chat.read` (yönetici rolü); oy, neden, yorum ve
  mesaj referansı görülür, **sohbet metni görülmez.** Her liste/detay görüntüleme
  `admin_audit_event`'e yazılır (yorum ve neden yazılmaz).
- Veri indirme: `/hesap/veri-indir` çıktısında her mesajın oyu (neden, yorum) bulunur.
- **Etkinleştirme öncesi (açık):** `/gizlilik` ve `/kvkk-aydinlatma` metninde sohbet
  içeriği, geri bildirim yorumu ve saklama süresi (sohbet bayrağı açılmadan önce, hukuk
  onayıyla).
- **Sohbet bağlamına yönetici erişimi bu kararda yoktur.** Ayrı faz için koşullar: kullanıcı
  onayı (varsayılan kapalı, paylaşılacak mesajlar gösterilir), yalnızca seçilen kapsam, ayrı
  capability, her erişim denetimde, aydınlatma metni ve hukuki inceleme.
