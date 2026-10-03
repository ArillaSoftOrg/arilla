# 0056 — Yönetim konsolunu ayrı alan adına taşıma (plan)

**Tarih:** 3 Ekim 2026
**Durum:** Kabul edildi — uygulama ayrı dağıtım görevi

Hedef: yönetim konsolu `www.<alan>/yonetim` yerine `admin.<alan>` üzerinden
sunulsun (üretim alanı bugün `manicepte.com`). Konsol olgunlaştı (0039–0055);
bu karar, ayrımın NASIL yapılacağını ve neden bu dalda yapılmadığını kaydeder.

## Bugünkü durum (depodan)

- Tek uygulama: `apps/web`. Yönetim `/yonetim` altında; vekil (`proxy.ts`)
  oturumsuz isteği `/yonetim/giris`'e çevirir, asıl yetki her sayfa/eylemde
  (`dal.ts` `requireCapability`) ve core'da (`assertCapability`).
- Oturum çerezi `session`: `Domain` niteliği YOK → yalnızca onu koyan ana
  makineye gider (host-only). Ayrı bir `admin.` ana makinesi kendiliğinden ayrı
  çerez alır; `.manicepte.com` gibi geniş bir çerez yazılmamalıdır.
- OAuth dönüş adresleri tek `APP_URL`'den üretilir
  (`googleRedirectUri`, `appleRedirectUri` → `<APP_URL>/giris/{google,apple}/callback`).

## Karar

Ayrım **iki adımda**, bu daldan bağımsız bir dağıtım görevi olarak yapılır.

**Adım 1 — aynı uygulama, ana makineye göre yönlendirme (önerilen ilk adım):**
1. `ADMIN_HOST` ortam değişkeni (ör. `admin.manicepte.com`). Tanımsızken
   davranış bugünkü gibi kalır (yerel geliştirme, geri dönüş yolu).
2. `proxy.ts`: istek `ADMIN_HOST`'a geliyorsa `/` → `/yonetim`'e içten
   yeniden yazılır, yönetim dışı public yollar 404; `www`'ye gelen `/yonetim*`
   istekleri `ADMIN_HOST`'a 308 ile gönderilir (bilgi sızdırmaz, yetki yine
   sayfada).
3. Giriş: yönetim ana makinesinde Google/Apple dönüş adresi
   `https://ADMIN_HOST/giris/.../callback` olur (`appUrlFor(host)`); iki
   sağlayıcı konsolunda bu adresler **elle** kayıt edilir. Oturum çerezi
   host-only kalır → yönetim oturumu public oturumdan ayrıdır; public sitedeki
   bir XSS yönetim çerezini taşıyamaz (asıl güvenlik kazancı bu).
4. Güvenlik başlıkları (0050) aynen; yönetim ana makinesinde ek olarak sıkı
   `form-action` ve `noindex` zaten var.
5. Doğrulama: yerelde `admin.localhost` ile E2E (yetki matrisi, oturum
   ayrımı, `www/yonetim` → 308, OAuth başlangıç adresi).

**Adım 2 — `apps/admin` ayrı uygulama (yalnızca gerekirse):** Adım 1'den sonra
bağımsız derleme/dağıtım gerçek bir ihtiyaç olursa (ör. ayrı ekip, ayrı
yayın döngüsü) `/yonetim` sayfaları `apps/admin`'e taşınır; iş mantığı zaten
`packages/core`'da olduğundan çoğaltılmaz, yalnızca giriş rotaları, `dal.ts`
ve vekil ikinci uygulamaya kopyalanır.

## Neden bu dalda uygulanmadı

- Dış yapılandırma gerektirir: DNS kaydı, Vercel alan adı (ya da ikinci
  proje), Google OAuth istemcisi ve Apple Services ID dönüş adresleri. Bunlar
  bu dalda doğrulanamaz.
- Kod, dış yapılandırmadan ÖNCE dağıtılırsa yönetim girişi kırılır (dönüş
  adresi kayıtlı olmaz). Doğru sıra: önce sağlayıcı kayıtları + DNS, sonra kod.
- Bu daldaki konsol işleri bundan bağımsızdır; `/yonetim` çalışmaya devam eder.

## Reddedilen alternatifler

- **Doğrudan `apps/admin`:** giriş akışı, vekil ve DAL'ın kopyalanması ilk
  adımda gereksiz risk; aynı uygulamada ana makine ayrımı güvenlik kazancının
  tamamını verir.
- **Geniş alan çerezi (`.manicepte.com`):** yönetim oturumunu public alt
  alanlara açar; kesinlikle yapılmaz.
- **Gizli yol / belirsiz adres:** güvenlik sağlamaz (0050).
