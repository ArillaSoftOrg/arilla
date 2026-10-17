# 0056 — Yönetim konsolunu ayrı alan adına taşıma (plan)

**Tarih:** 3 Ekim 2026
**Durum:** Kabul edildi — Adım 1 uygulandı (17 Ekim 2026); `ADMIN_HOST` üretimde açılınca etkin

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

## Uygulama — Adım 1 (17 Ekim 2026)

Kurallar `packages/core/src/admin/admin-host.ts`'te (saf, birim testli);
`proxy.ts`, `app/lib/dal.ts`, Google giriş rotaları ve `/api/yonetim/*` yalnızca
onu çağırır. Plandan farklar ve gerekçeleri:

- **Yetenek kapısı ana makineye bağlı.** Yol yönlendirmesi yetmez: Next, bir
  server action'ı hangi sayfaya POST edilirse edilsin bulur ve sahibi olan
  sayfaya içeride iletir. Yerelde doğrulandı: `ADMIN_HOST` yokken
  `searchUsersAction` kimliği `/hakkinda`'ya POST edildiğinde çalıştı. Bu yüzden
  `requireCapability` ve yönetim API'si, `ADMIN_HOST` tanımlıyken istek o ana
  makineden gelmiyorsa oturuma bakmadan 404 verir. Public sitedeki bir XSS,
  yöneticinin public oturumuyla konsol işlemi yapamaz.
- **Yönetim ana makinesinde yalnızca Google.** Apple dönüş adresi kaydı
  gerekmez; doğrulanmış e-postayla hesap bağlama yüzeyi yönetim girişinde tek
  sağlayıcıya iner. Apple/telefon/e-posta yolları public siteye yönlenir.
- **Önce kod, sonra yapılandırma.** Kod `ADMIN_HOST` olmadan etkisizdir; bu
  yüzden dış kayıtlardan önce dağıtılabilir. Sıra yalnızca değişkeni açarken
  önemlidir (docs/ops.md "Yönetim ana makinesi").
- **Bozuk değer kapalı kalır.** Biçimi bozuk ya da üretimde port/localhost
  içeren `ADMIN_HOST` konsolu hiçbir yerde açmaz; public site etkilenmez.
- **Yönlendirmeler mutlak `Location` ile.** `NextResponse.redirect(URL)`
  localhost adlarını isteğin ana makinesiyle değiştirdiği için proxy başlığı
  doğrudan yazar.
- Proxy matcher'ı genişledi (dosyalar ve `_next` hariç her yol); diğer proxy
  görevleri yalnızca kendi yollarına bakar.

Açık: çerez savurma (cookie tossing) — public alt alandaki bir XSS
`Domain=.<alan>` ile `session` çerezi yazıp yöneticiyi kendi (yetkisiz)
hesabına sokabilir. Etki düşük (yetkisiz hesap 404 görür); kapatmak için
yönetim ana makinesinde `__Host-` önekli ayrı çerez adı ayrı bir adımdır.
