# 0116 — Umami: rızaya bağlı ziyaretçi analitiği ve yönetim ekranı

**Tarih:** Ekim 2026 · **Durum:** kabul edildi (kod hazır; üretimde etkinleştirme elle, aşağıda)

## Bağlam

Takip bağlantıları (0115) tıklamayı sayar ama ziyaretçiyi, kampanya
performansını, kaynağı, ülkeyi ve cihazı göstermez. VPS'te Umami v3.4.0
(`analytics.manicepte.com`, ayrı `umami` veritabanı, HTTPS, yönetici 2FA)
zaten çalışıyor. Sitede Umami izleyicisi yok; CSP `'self'` (GA4 hariç).

## Doğrulanan Umami yetenekleri (docs.umami.is, v3.4.0)

- Kimlik: `Authorization: Bearer <API anahtarı>` (kendi sunucuda önerilen yol).
- Okuma (hepsi `GET /api/websites/{id}/…`): `stats` (pageviews, visitors, visits,
  bounces, totaltime + `comparison`), `pageviews` (`pageviews[]` ve `sessions[]`,
  `{x,y}` noktaları; `compare` istenirse `compare`), `metrics?type=` (path,
  referrer, domain, channel, event, browser, os, device, country, region, city,
  language, utmSource, utmMedium, utmCampaign, utmContent, utmTerm …; satır
  `{x,y}`), `metrics/expanded`. Süzgeçler: `path`, `referrer`, `country`,
  `device`, `browser`, `utmSource`, `utmMedium`, `utmCampaign` …
- Gönderim: `umami.track(props => ({...props, url, title, referrer}))` ile sayfa
  değerleri geçersiz kılınabilir; `umami.track(ad, veri)`; `data-auto-track="false"`
  başlatmayı kapatır; `data-do-not-track`; `data-before-send` göndermeyi iptal
  edebilir; botlar varsayılan olarak hariçtir.
- **Doğrulanamayan, KULLANILMAYAN:** özel olay verisine (event-data) göre kampanya
  kırılımı API'leri, olay serisi uç noktası, özel UTM uç noktası, Links API'si,
  Bearer belirteç ömrü, tarayıcıda çerez/`localStorage` kullanımı (belgede yok).
  Çerez davranışı doğrulanamadığı için izleyici **rızaya bağlı** yüklenir.

## Karar

1. **Okuma yalnızca sunucuda** (`packages/core/src/analytics-umami`): anahtar
   `UMAMI_API_KEY` yalnızca `web` ortamında; tarayıcıya, günlüğe, hata iletisine
   girmez. Her istek 4 sn zaman aşımı, 1 MB yanıt tavanı, yanıt biçimi doğrulaması.
   Rapor tanımları kodda sabit (yukarıdaki doğrulanmış tipler); kullanıcı girdisi
   yalnızca doğrulanmış tarih aralığı ve güvenli `utmCampaign` etiketi.
2. **Hata izolasyonu:** Umami hata verir, zaman aşımına uğrar ya da tanımsızsa
   yalnız analitik ekranı "yanıt vermiyor" der (varsa eski veri, "eski" etiketiyle).
   Site ve kısa bağlantılar etkilenmez; yönlendirme yolu Umami'yi hiç çağırmaz.
   Redis önbelleği: tamamlanmış aralık 6 saat, bugünü içeren 5 dk; son iyi veri 7 gün.
3. **İzleyici (CLAUDE.md ikinci istisna):** `UMAMI_WEBSITE_ID` + `UMAMI_BASE_URL`
   tanımlıysa ve analitik rızası varsa, `ConsentGate category="analytics"`
   içinde `<UMAMI_BASE_URL>/script.js` yüklenir. `data-auto-track="false"`
   (tıklama/performans otomatik toplama yok), `data-do-not-track="true"`,
   `data-before-send` ile rıza geri alınınca gönderim anında durur. Gönderilen
   adres GA4 ile AYNI süzgeçten geçer (`sanitizePage`): arındırılmış yol + yalnızca
   güvenli `utm_*`; başlık yerine yol; dış yönlendiren yalnızca köken. `/yonetim`,
   `/api`, `/giris/*`, `/abonelik-iptali` gönderilmez.
4. **CSP:** yalnızca Umami etkinken `script-src` ve `connect-src`'ye Umami kökeni
   eklenir. Yönetim yanıtları bu genişlemeyi almaz.
5. **Olaylar (`docs/events.md`):** sayfa görüntüleme ve `early_access_joined`.
   Başka olay gönderilmez.
6. **Erken erişim dönüşümü:** kayıt ekranı "az önce katıldı" durumundayken (10 dk
   penceresi, `earlyAccessState`) ve rıza varsa tek olay gönderilir; aynı
   sekmede tekrarı `sessionStorage` bayrağı bastırır (yalnızca iyileştirme, akış
   ona bağlı değil). Olay verisi: iniş sayfasındaki güvenli `utm_source` /
   `utm_campaign` (sessionStorage'a rızayla yazılır). Kullanıcı kimliği,
   e-posta, hesap numarası GÖNDERİLMEZ ve Umami'de `identify` çağrılmaz.
   Kampanya kırılımını okuyan bir Umami uç noktası doğrulanamadığından yönetim
   ekranı yalnızca olay SAYISINI gösterir (`metrics?type=event`); kampanya bazlı
   dönüşüm Umami arayüzünde incelenir. Arilla veritabanına kampanya–kullanıcı
   bağı YAZILMAZ (kişisel veri bağı olur; ayrı hukuki karar ister).
7. **Çift sayım:** Umami ve GA4 ayrı araçlardır, birbirine eklenmez. Umami içinde
   tek gönderim noktası vardır (rota değişimi + aynı adres tekrarı bastırılır;
   otomatik izleme kapalı). Kısa bağlantı tıklaması (Arilla sayacı) ziyaret
   DEĞİLDİR: tıklama sayısı ile Umami ziyaretçisi farklı şeyleri ölçer (bot,
   rızasız ve reklam engelleyen ziyaretçi Umami'de görünmez). Ekranlar bunu yazar.
8. **Bot trafiği:** Umami botları kendisi eler (varsayılan); ek olarak kısa bağlantı
   sayacı 0115'teki süzgeci kullanır.
9. **Yönetim:** `/yonetim/analitik` (`traffic.read`, yalnızca yönetici). Kampanya
   etiketi dolu kısa bağlantıların ayrıntı sayfasında o kampanyanın Umami özeti.

## Reddedilen alternatifler

- Yönlendirmede sunucudan `POST /api/send`: IP ve User-Agent'ı Umami'ye aktarır,
  rıza dışı işleme olur.
- Kullanıcı kimliğini Umami'ye bağlamak (`identify`): kişisel veri bağı.
- Umami Links: API belgelenmemiş (0115).
- Betiği rızasız yüklemek: çerez/depolama davranışı doğrulanamadı.

## Altyapı (üretim öncesi, bu PR dokunmaz)

0115 ve `docs/ops.md` "Takip bağlantıları ve Umami" bölümü: canlı Caddy bloğu ve
`pg_hba.conf` kuralının depoya alınması, Umami veritabanının yedek kapsamı,
`web` → Umami ağ yolu, `UMAMI_*` değişkenleri. API anahtarı Umami arayüzünde
(Settings > API keys) en az yetkili ayrı bir kullanıcıyla üretilir (anahtar kapsamı belgelenmediği için anahtarın o kullanıcının yetkisini taşıdığı varsayılır) ve yalnızca `web.env`'e yazılır.
