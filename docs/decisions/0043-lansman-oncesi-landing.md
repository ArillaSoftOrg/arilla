# 0043 — Lansman öncesi landing, erken erişim hunisi ve yönetici önizlemesi

**Tarih:** 2026-09
**Durum:** kabul edildi (yerel görsel kabul bekliyor; üretim ortamı ayarı
değiştirilmedi)

## Bağlam

ManiCepte yayında ama ürün açılmadı. Bu dönemde public sitenin üç işi var:
ne olduğunu anlatmak, pazarlama trafiğini karşılamak ve erken erişim talebi
toplamak. Ziyaretçi gerçek ürüne (arama, görsel/link araması, keşif, ürün
sayfası, karşılaştırma, kaydetme, alarm, geçmiş) erişmemeli; yönetici ise
üretimde gerçek siteyi test edebilmeli.

P2 (`51c6649`) bunun erişim tarafını zaten kurmuştu: `PRODUCT_ACCESS`
bayrağı (fail-closed), core'da tek karar noktası `canAccessProduct`, her
ürün sayfası/action/route handler'da `requireProductAccess`, proxy'de anonim
yönlendirme, girişte idempotent `early_access` kaydı, bayrağa bağlı site
haritası ve robots. Eksik olan deneyimdi: landing, başarı ekranı, marka
tutarlılığı, yönetici girişi ve kök metadata.

## Karar

**1. Tek mod anahtarı: mevcut `PRODUCT_ACCESS`.** Yeni bir
`PUBLIC_SITE_MODE` eklenmedi. `PRODUCT_ACCESS=open` normal site; boş ya da
başka her değer lansman öncesi mod. İki bayrak birbirinden ayrışabilir ve
"kapı kapalı ama landing açık" gibi tutarsız durumlar üretirdi; mevcut
bayrak ayrıca fail-closed: üretimde ayar unutulursa ürün kapalı kalır.
`NEXT_PUBLIC_` yok, sorgu parametresi/gizli adres/çerez ile atlama yok.

**2. Yetki mevcut modelde; önizleme yalnızca yönetici.** Önizleme
`product.preview` yeteneğidir ve bu karar onu P2'deki "moderatör + yönetici"
yerine **yalnızca yöneticiye** verir. Yetenek başka hiçbir yerde
kullanılmıyor; moderatörün diğer tüm konsol yetenekleri aynen kalır.
Lansman öncesi moderatör girişten sonra yalnızca yönetim konsoluna döner
(`next` konsol altındaysa o, değilse `/yonetim`), erken erişim listesine
yazılmaz ve ürün sayfaları onu da `/erken-erisim`'e gönderir. Rol her
istekte veritabanındaki oturumdan okunur (`verifySession`). Proxy yalnızca iyimser anonim
yönlendirme yapar; gerçek kapı Node çalışma zamanında, her sayfada.

**3. Landing** (`coming-soon-landing.tsx`): marka + "yakında" durumu +
değer önerisi + tek birincil eylem ilk mobil ekranda; üç fayda; "Nasıl
çalışacak?" üç adım; hafif "geliştiriyoruz" bölümü (elle güncellenen gerçek
durum, yüzde/tarih yok); kapanış çağrısı. Form, arama kutusu, istemci
betiği, veri sorgusu, demo ürün görseli yok. Anonim ziyaret veritabanına
hiç gitmez. Görsel dekoratiftir (`aria-hidden`).

**4. Huni mevcut giriş akışıdır.** "Erken erişime katıl" →
`/giris?next=/erken-erisim` (`EARLY_ACCESS_LOGIN_PATH`, mevcut
`safeRedirectPath`). Kayıt girişin kendisinde yazılır; normal kullanıcı her
girişte `/erken-erisim`'e gider. İkinci liste, ikinci tablo yok.

**5. Başarı ekranı.** Katılımdan sonraki ilk 10 dakika "Listedesin.", sonra
"Erken erişim listesindesin." (yalnızca metin seçimi, `created_at`'ten).
Ürüne bağlantı yok; ana sayfa, hesap (KVKK hakları) ve çıkış var.

**6. Yönetici girişi.** Header'da (masaüstünde hesap düğmesinin yanında
düz metin, telefonda menü panelinde) ve footer'da sade "Admin Girişi" →
`/giris?next=/yonetim` (`ADMIN_LOGIN_PATH`). Aynı giriş; yetkisiz hesap
`next`'e hiç dönmez (`postAuthRedirect`), `/yonetim` kendi
`requireCapability`'siyle korunmaya devam eder. Giriş ekranı bu durumda
nötr "Hesabınla giriş yap." der; girişten önce hiçbir hesabın rolü belli
olmaz. Ayrı parola, belirteç, gizli adres ya da e-posta listesi yok.

**7. Marka ve sosyal hesaplar.** Yayındaki ad tek sabit: `SITE_BRAND`
(`site-config.ts`); header, footer, kök metadata, giriş ekranları, landing
ve erken erişim metinleri buradan okur. Resmi sosyal hesaplar
`SOCIAL_PROFILES`'ta; bugün hiçbiri doğrulanmadığı için hepsi `null` ve
hiçbiri gösterilmez.

**8. SEO.** Kapalıyken kök sayfa "ManiCepte – Yakında" başlığı ve açıklaması,
kanonik `/`. Ürün yolları haritada yok ve robots'ta kapalı (P2); yasal
sayfalar ve landing taranabilir. Metadata oturuma değil yalnızca bayrağa
bağlı. 404 sayfası kapalıyken ürün bağlantısı önermez. `open` olunca eski
davranış kendiliğinden döner.

## Reddedilen alternatifler

- **Ayrı `PUBLIC_SITE_MODE` değişkeni.** İkinci anahtar, kapıyla ayrışma
  riski; mevcut bayrak zaten tam bu işi yapıyor.
- **Yetkiyi proxy'de vermek.** Proxy oturumu veritabanından doğrulamaz;
  rolü orada okumak ya ek sorgu ya da güvenilmez çerez demekti.
- **Sorgu parametresi, gizli adres ya da çerezle önizleme.** Paylaşılabilir
  ve sızdırılabilir; rol tabanlı yetkinin yerini tutamaz.
- **Yeni bekleme listesi formu (e-posta alanı).** Mevcut girişle ikinci bir
  kimlik ve KVKK akışı demekti.

## Açık konular

- **Lansman bildirimi tercihi** (e-posta/SMS) için şema değişikliği gerekir;
  bu kararda yapılmadı (bkz. görev raporu).
- Analitik gönderici yok; `docs/events.md`'ye huni olayları sonra eklenebilir.
- Yasal sayfalar `LEGAL_IDENTITY.brandName` ("Arilla") ile konuşuyor; yasal
  kimlik ayrı bir karar. **Güncelleme (6 Ekim 2026):** yasal sayfalar ve
  `LEGAL_IDENTITY.brandName` da "ManiCepte" kullanır; tescilli unvan
  (`legalEntityName`) ayrı alan olarak kalır.
