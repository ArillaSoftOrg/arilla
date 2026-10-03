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
| Arama kalitesi günlük özeti (0052, 0054) | `search_query_day` | Meşru menfaat (hizmet kalitesi); **anonim**: kullanıcı, oturum, IP yok; e-posta, telefon, adres, URL, 7+ haneli rakam içeren sorgu yazılmaz | 90 gün |

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
   hash'i tutulur. Ham dosya en fazla 30 gün geçici depoda kalır, sonra silinir.
2. **Yüz tespiti varsa uyarı gösterilir.** İnsan içeren fotoğraf yüklendiğinde
   kullanıcı bilgilendirilir; biyometrik veri işleme iddiasından kaçınmak için
   yüz bölgesi hiçbir modele ayrıca beslenmez.
3. **Ürün olmayan görsel reddedilir.** Sonuç dönmez, dosya saklanmaz.
4. **Moderasyon.** Uygunsuz içerik tespitinde sorgu reddedilir ve kayıt tutulur.
5. Yükleme ekranında tek satır bilgi: fotoğrafın ne için kullanıldığı ve ne
   kadar saklandığı.

Bu kurallar ilk görsel arama satırı yazılmadan önce uygulanmalıdır.

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
