# 0087 — GA4: rızaya bağlı trafik ölçümü ve `/yonetim/trafik`

**Tarih:** 9 Ekim 2026
**Durum:** Kabul edildi (kod hazır; üretimde etkinleştirme elle, aşağıda)

## Bağlam

Sitede trafik ölçümü yoktu: GA4 betiği, Measurement ID veya Data API yoktu;
CSP yalnızca `'self'`e izin veriyordu ve CLAUDE.md üçüncü taraf betiği
yasaklıyordu (0009). Analitik rıza kategorisi (0038) tanımlıydı ama arkasında
bir teknoloji yoktu. Denetim raporu (9 Ekim 2026) bunu ve kural çatışmasını
kayda geçirdi.

Sahip (ürün sahibi) 9 Ekim 2026'da hukuki ve güvenlik gerekliliklerinin
karşılandığını **beyan etti**. Depoda GA4'e özel yazılı hukuk onayı belgesi
yoktur; bu beyan bu karara dayanak olarak kaydedilmiştir. Aydınlatma ve
çerez metinleri aşağıdaki gibi koşullu güncellendi.

## Karar

1. **Kural istisnası (CLAUDE.md güncellendi):** tek üçüncü taraf betik GA4
   (`googletagmanager.com/gtag/js`). Yalnızca `GA4_MEASUREMENT_ID` geçerliyse
   VE ziyaretçi analitik rızası verdiyse `ConsentGate category="analytics"`
   arkasında yüklenir. Kimlik yoksa: betik yok, CSP genişlemez, çerez ve
   aydınlatma metinleri "kullanmıyoruz" demeye devam eder. Kimlik, çalışma
   anında sunucudan bileşene verilir (`NEXT_PUBLIC_` değil).
2. **Rıza geri alınması anında:** kapı bileşeni söker; söküm `ga-disable-<ID>`
   bayrağını açar, `analytics_storage` rızasını `denied` yapar ve `_ga`,
   `_ga_<ID>` çerezlerini siler. Sunucu tarafı tercih action'ı da aynı
   çerezleri siler (`OPTIONAL_COOKIES` + `OPTIONAL_COOKIE_PREFIXES`). Çerezler
   host'a özel yazılır (`cookie_domain: "none"`), böylece sunucu silebilir.
   `CONSENT_VERSION` 2'ye çıktı: eski tercih yok sayılır, banner yeniden çıkar.
3. **Toplanan veri en aza indirilir (`ga4-measurement.ts`, saf ve testli):**
   - Yalnızca `page_view` gönderilir (events.md). `send_page_view: false`;
     sayfa görüntüleme rota değişiminde elle gönderilir.
   - Sayfa yolu izin listesiyle: bilinen kamu rotaları aynen; içerik slug'ı
     (`/urun`, `/blog`, `/trendler`, `/anket`) yalnızca slug biçimindeyse;
     `/sohbet/<id>` → `/sohbet/[id]`; bilinmeyen her yol (link arama
     catch-all'u dahil: yolun kendisi kullanıcı girdisidir) → `/(diger)`.
   - Gönderilmeyen yollar: `/yonetim`, `/api`, `/giris/*` alt yolları,
     `/abonelik-iptali`.
   - Sorgu parametrelerinin TAMAMI atılır; yalnızca `utm_*` beşlisi, güvenli
     karakterlerle ve 100 karakterle kalır (e-posta veya 7+ hane içeren
     değer atılır). Hash atılır. Başlık olarak belge başlığı değil,
     arındırılmış yol gönderilir.
   - Dış yönlendiren yalnızca köken (`https://host`); iç yönlendiren
     arındırılmış yol.
   - `user_id` gönderilmez; Google sinyalleri ve reklam kişiselleştirmesi
     kapalı; reklam rızaları `denied`.
4. **CSP yalnızca GA4 etkinken genişler:** `script-src` +
   `https://www.googletagmanager.com`; `connect-src` +
   `https://*.google-analytics.com https://*.analytics.google.com
   https://www.googletagmanager.com`. `img-src` zaten `https:`.
5. **Raporlama yalnızca sunucuda (`packages/core/src/analytics-ga4`):** servis
   hesabı kimliğiyle (anahtarsız federe kip ya da anahtar yedeği, karar 0088;
   `analytics.readonly` kapsamı, mülkte Görüntüleyici rolü)
   GA4 Data API `batchRunReports`. Rapor tanımları kodda sabit (yalnızca
   doğrulanmış metrik/boyut adları); kullanıcı girdisi yalnızca doğrulanmış
   tarih aralığı ve zaman dilimi. Her istek 8 sn zaman aşımı; erişim belirteci
   bellekte. Redis önbelleği: tamamlanmış aralık 6 saat, bugünü içeren 15 dk;
   son iyi veri 7 gün tutulur ve hata ya da kota durumunda "eski veri" diye
   gösterilir. `returnPropertyQuota` ile kalan saatlik/günlük token izlenir;
   eşiğin altında yeni istek atılmaz. Hata mesajları anahtar ya da belirteç
   içermez.
6. **`/yonetim/trafik` (`traffic.read`, yalnızca yönetici):** kullanıcı,
   oturum, sayfa görüntüleme, etkileşim oranı (önceki dönemle), gün/hafta/ay
   grafiği (sunucuda SVG, yeni bağımlılık yok), kanal ve kaynak, popüler
   sayfalar, cihaz, ülke ve bölge (5 kullanıcıdan az satırlar "Diğer"e
   katılır). 7/28/90 gün ve özel aralık. Veri temeli rozeti: "Rızalı örneklem
   (GA4)". Genel bakışa yalnızca 7 günlük özet ve sayfaya bağlantı eklenir.

## Elle kurulum (kod dışı, zorunlu)

GA4 mülkünde: saat dilimi Europe/Istanbul; **gelişmiş ölçüm KAPALI** (en
azından site içi arama, giden tıklama, form, dosya indirme, video ve
"tarayıcı geçmişine göre sayfa değişimi"); veri saklama 2 ay; Google
sinyalleri kapalı; reklam bağlantıları yok. Ayrıntılı adımlar:
`docs/ops.md` → "GA4".

## Reddedilen alternatifler

- **Rızasız/Consent Mode modellemesi:** rıza vermeyenden çerezsiz ping
  gönderir; 0038 ve 0049 ile çelişir.
- **Measurement Protocol (sunucudan):** yine `client_id` çerezi ve aktarım
  gerektirir, kaynak/cihaz/coğrafya zayıf.
- **`@google-analytics/data` SDK'sı:** gRPC ve geniş bağımlılık ağacı; iki
  uç noktalık REST + `node:crypto` JWT yeterli.
- **Grafik kütüphanesi:** sunucuda üretilen SVG, CSP ve paket boyutunu
  değiştirmez.
