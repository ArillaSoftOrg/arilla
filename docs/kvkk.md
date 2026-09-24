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
| Gezinme geçmişi | `product_view` | **Açık rıza** | Son 50 kayıt, hesap silinince silinir |
| Kaydedilenler, alarmlar | `saved_item`, `alert` | Sözleşmenin ifası | Hesap silinene kadar |
| Beden profili | `user_size_profile` | Açık rıza | Hesap silinene kadar |
| Tıklama ve dönüşüm | `click`, `conversion` | Meşru menfaat + sözleşme | 5 yıl (mali mevzuat) |
| Yüklenen görseller | obje deposu | Açık rıza | **En fazla 30 gün** |
| Pazarlama e-postası izni | `user_consent` | Açık rıza + İYS | İzin geri alınana kadar |
| IP adresi | `auth_token`, `user_consent` | Meşru menfaat | 1 yıl |

Gezinme geçmişi ve kişiselleştirme **rızaya bağlıdır ve reddedilebilir
olmalıdır.** Reddedildiğinde ürün çalışmaya devam eder, sadece kişiselleştirme
kapalı olur.

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
- **İtiraz** — kişiselleştirmeyi kapat

Silme gerçekten silmelidir. Arayüzde var görünüp arkada saklamak ihlaldir.
Hesap silindiğinde `click` ve `conversion` kayıtları mali mevzuat gereği
kalabilir ama **kimliksizleştirilir** (`user_id` NULL'a çekilir).

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

**Faz 6 notu:** `/gizlilik` ve `/kosullar` altında, yukarıdaki maddeler
tamamlanana kadar geçerli olacak **taslak** sayfalar eklendi — yalnızca bu
dosyadaki ve koddaki doğrulanmış veri akışlarını açıklar, veri sorumlusu
tüzel kişi bilgisi içermez. Yukarıdaki kutucuklar bu yüzden işaretlenmedi;
sayfalar hukukçu onayı ve şirket kuruluşu sonrası güncellenmelidir. `/cerez`
sayfası ise mevcut (yalnızca zorunlu: `session`, `session_id`, `theme`) çerez
envanterini listeler — analitik/pazarlama çerezi olmadığı için consent bandı
kurulmadı.

**Faz 8.1 notu:** Geçici public iletişim adresi (`apps/web/app/site-config.ts`)
`/iletisim` sayfasında ve `/gizlilik` "Haklarınız" bölümünde soru kanalı olarak
gösterilir. Bu, veri sorumlusu bildirimi **değildir** — "Veri sorumlusu"
bölümü ve yukarıdaki kutucuklar tüzel kişi kurulana kadar açık kalır.
