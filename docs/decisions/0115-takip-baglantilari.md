# 0115 — Takip bağlantıları (kısa bağlantı yönetimi)

**Tarih:** Ekim 2026 · **Durum:** kabul edildi (kod bu PR'da; Umami bölümü 2. aşama)

## Bağlam

Instagram, creator ve kampanya bağlantıları için `manicepte.com/ig`,
`/arda`, `/sehzade` gibi kısa adresler gerekiyor. Her yeni bağlantı deploy
gerektirmemeli, yönetimden oluşturulup pasife alınabilmeli ve tıklamalar
zaman bazında izlenebilmeli. Umami v3.4.0 VPS'te ayrı bir alt alan adında
(`analytics.manicepte.com`) çalışıyor.

## Karar

1. **Ana kaynak Arilla PostgreSQL** (`tracking_link`, migration 0068).
   Yönlendirme Next.js route handler'ında (`app/[slug]/route.ts`); Umami'ye
   bağımlı DEĞİL. Umami kapalıyken bağlantılar çalışır.
2. **Tıklama sayacı Arilla'da**, `tracking_link_click_hour`: saat başına
   tek sayı. IP, User-Agent, oturum, çerez, yönlendiren adres YAZILMAZ.
   Günlük görünüm bu tablodan sorguda (Europe/Istanbul) toplanır.
   Bu veri kişisel veri değildir; `docs/kvkk.md`'ye satır eklendi.
3. **Sayılmayanlar:** HEAD, ön yükleme (prefetch/prerender/preview), bilinen
   botlar (`classifyClickRequest`, karar 0013). Yönlendirme yine yapılır,
   yalnızca sayaç artmaz. İnsan istekleri için ek olarak IP başına (HMAC'li,
   kısa ömürlü Redis anahtarı) dakikalık tavan vardır; aşılırsa yönlendirme
   sürer, sayaç artmaz. Redis yoksa sayılır (yönlendirme asla düşmez).
4. **302 + `Cache-Control: no-store`.** Hedef sonradan değişebilir, pasife
   alınabilir; tarayıcı/CDN önbelleği olmaz.
5. **Slug değişmez**, bağlantı silinmez (pasife alınır): basılı/paylaşılmış
   bağlantı kırılmasın. Slug `^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$`;
   rezerve sistem yolları kodda tutulur ve bir test depodaki gerçek `app/`
   klasörlerinden okuyarak listenin güncel kaldığını doğrular.
6. **Hedef kısıtı (açık yönlendirme / döngü):** mutlak adres yalnızca `https`
   ve yalnızca ManiCepte alan adları (`APP_URL` host'u, `www` eşi ve
   `TRACKING_LINK_EXTRA_HOSTS` ile elle eklenenler; yalnızca ManiCepte'nin kendi alan adları, harici mağaza DEĞİL: mağazaya çıkış `click` ister, kural 8); kullanıcı bilgisi, port,
   IP adresi, `\`, boşluk/kontrol karakteri yok. Kök-göreli yol (`/trendler/x`)
   `APP_URL` kökenine çözülür (istek `Host` başlığına güvenilmez). Kendi
   alanımızdaki hedefin ilk yol parçası bir sistem rotası olmalıdır: tek
   parçalı başka bir yol başka bir slug'a (döngü) ya da link-öneki catch-all'una
   düşer. Hedef Redis önbelleğinden okunsa bile aynı doğrulamadan yeniden
   geçer; zehirlenmiş önbellek açık yönlendirmeye yol açmaz.
7. **Önbellek:** Redis `tracking-link:v1:<slug>`, 60 sn (yok kaydı 30 sn),
   yönetimde her değişiklikte silinir. Redis hata verirse doğrudan veritabanı.
   Bilinmeyen yollar (`/wp-login.php`, `/%2e%2e`) slug biçimine uymadığı için
   veritabanına hiç gitmez.
8. **Mevcut `[...link]` catch-all korunur.** `app/[slug]/route.ts` yalnızca tek
   parçalı yolları alır. Slug değilse ya da kayıt yoksa aynı çözümleme
   (`urlFromPrefixSegments`) çalışır; hiçbiri değilse 404. Çok parçalı
   `/https:/...` yolları catch-all'da kalır.
9. **Yetki:** `links.read` ve `links.manage`, yalnızca yönetici; mutasyon taze
   giriş ister, core `assertCapability` ile ikinci kez denetler, her değişiklik
   aynı işlemde `admin_audit_event`'e yazılır (hedef adresin kendisi değil
   ana makine adı ve yol; sorgu dizgesi yazılmaz).
10. **UTM:** `source` ve `campaign` doluysa yönlendirmede hedefe
    `utm_source`, `utm_campaign` (+ `utm_medium=link`) eklenir; hedefte zaten
    varsa dokunulmaz. GA4 (0087) ve Umami bu parametrelerle kampanyayı ayırır.

## Umami — 2. aşama (bu PR'da kod YOK)

Doğrulananlar (docs.umami.is, v3.4.0): Bearer API anahtarı, `GET
/websites/{id}/stats` (`utmSource`/`utmCampaign`/`path` filtreleri),
`/pageviews`, `/metrics`, `POST /api/send`. Doğrulanamayanlar ve
varsayılmayanlar: Umami Links için herhangi bir API, özel alan adı,
Docker etiket sabitleme garantisi, token ömrü.

Neden ayrı: (a) sitede bugün Umami izleyicisi yok ve CSP `'self'`;
hedef sayfalarda ziyaretçi/kampanya verisi için betik eklemek CLAUDE.md'nin
"üçüncü taraf betik" istisna kuralını (yalnızca GA4) ve rıza akışını (0038)
değiştirir; (b) API anahtarı yalnızca sunucuda, `web.env`'de durmalı ve
sunucu→`analytics.manicepte.com` çıkışı ağ kuralı gerektirir (`web` yalnızca
`edge/data/egress`'e bağlı). 2. aşama: `packages/core/src/umami/` salt-okunur
istemci (zaman aşımı, Redis önbelleği, son iyi veri), `UMAMI_BASE_URL`,
`UMAMI_API_KEY`, `UMAMI_WEBSITE_ID`; ayrı ADR.

## Altyapı kalıcılığı (üretim öncesi, bu PR dokunmaz)

`infra/vps/Caddyfile` ve `infra/vps/postgres/pg_hba.conf` depoda yalnızca
`arilla` sitesini/veritabanını bilir; VPS'teki elle yapılan `analytics`
Caddy bloğu ve Umami veritabanı HBA kuralı depoda YOK. Dağıtım bu dosyaları
`/opt/arilla/` altına yeniden kopyalarsa Umami erişimi ve veritabanı bağlantısı
kopabilir. Canlı dosyalar okunup (yalnız okuma) PR ile depoya alınmalıdır;
komutlar PR açıklamasında. Yedek: Umami veritabanı Arilla kümesindeyse
pgBackRest/WAL zaten kapsar; ayrı bir Postgres kapsayıcısındaysa kapsamda DEĞİLDİR.

## Reddedilen alternatifler

- **Umami Links'i kullanmak:** API belgelenmemiş; ana kaynağı bir dış araca
  bağlar, Umami kapalıyken bağlantılar ölür.
- **Her tıklamayı satır olarak yazmak:** IP/UA/oturum olmadan da satır başına
  veri büyür ve kişi tanımlayıcısına dönüşme riski taşır; sayaç yeterli.
- **`proxy.ts` ile yönlendirmek:** her istekte veritabanı/Redis'e gider ve
  matcher'ı tüm yollara genişletir.
- **Slug'ı düzenlenebilir yapmak:** paylaşılmış bağlantıyı sessizce kırar.
