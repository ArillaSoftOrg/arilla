# ManiCepte bakım ve sistem durumu

## Eklenen davranış

Yönetim menüsünde **İşletim → Bakım ve sistem durumu** (`/yonetim/bakim`).
Yalnızca admin rolü okuyabilir ve değiştirebilir. Her değişiklik son bir saat
içinde yapılmış giriş, işlem gerekçesi ve mevcut sürümü gerektirir.

| Mod | Davranış |
| --- | --- |
| Normal çalışma | Duyuru kalkar; bakım ekranındakiler geri döner. Eski mesaj, hizmetler ve tahmini saat temizlenir. |
| Planlı bakım duyurusu | Uygulama açık kalır, mesaj ve tahmini saat gösterilir. Kendiliğinden tam bakıma geçmez. |
| Kısmi kesinti | Seçilen hizmetlerin sayfaları ve bu sayfalara yapılan mutasyonlar 503 alır; diğer hizmetler açık kalır. |
| Tam bakım | Kullanıcı istekleri uygulama render edilmeden durdurulur. Bağımsız HTML bakım ekranı 503 ile sunulur. |

Mesaj en fazla 1500 karakter, gerekçe 5–500 karakterdir. Tahmini bitiş
Türkiye saatiyle girilir, UTC saklanır. Saat dolunca bakım kapanmaz.
Kullanıcı ekranları 15 saniyede bir yeni durumu kontrol eder; ağ ve servis
gecikmesi bu süreye eklenebilir. Etkilenen sayfa yeniden açılınca kullanıcı
aynı **yola** döner; gizli token ve arama bilgisi taşımamak için sorgu/fragment
korunmaz. Bilgi ekranı `/durum` adresinden de açılabilir.

Hizmet kapsamı `packages/core/src/maintenance/policy.ts` içindedir:

- Ürün arama: `/ara` ve alt yolları (görsel/link dahil).
- Görselle arama: `/ara/gorsel` ve alt yolları.
- Linkle arama: `/ara/link` ve alt yolları.
- AI sohbet: `/sohbet` ve alt yolları.
- Hesap ve giriş: `/hesap`, `/giris`, `/kayit` ve alt yolları.
- Fiyat alarmları: `/alarmlar` ve alt yolları.

Yönetim, yönetim API'si, yönetim giriş ekranı, Google giriş/callback,
zamanlanmış işler, sağlık uçları, durum uçları ve Next iç varlıkları bakımdan
muaftır. Google girişi yönetici erişiminin korunması için açık bırakılır.
Bakım bir erişim yetkisi sistemi değildir; mevcut oturum/yetki kontrolleri sürer.
Yeni hizmet/rota eklenince bu kapsam da güncellenmelidir.

## Bağımsız servis

`services/maintenance/worker.ts`, Cloudflare Worker üzerinde çalışır.
Tek SQLite-backed Durable Object, durum ve son 100 değişikliğin geçmişini
aynı transaction içinde saklar. İki yöneticinin aynı sürüme yazmasında yalnızca
biri kazanır; diğeri 409 alır. PostgreSQL veya Redis bağımlılığı yoktur.

`GET /status` herkese açık, yalnızca yayınlanan durum ve hedef yolun engellenip
engellenmediğini döndürür. Yönetici kimliği, gerekçe ve geçmiş public yanıtta yoktur.
`GET/PUT /admin/status` güçlü bearer secret gerektirir. Bu secret tarayıcıya gönderilmez.
Bağımsız servis kökündeki `/durum` ekranı font, görsel, Next veya başka bir CDN
isteği olmadan açılır. Bağımsız servis ana adresinde `/` de durum ekranıdır.

Cloudflare tercihi mevcut altyapıya zorunlu bir bağımlılık olarak eklenmedi;
ayrı barındırma ihtiyacını karşılayan hazır uygulamadır. Bağımsız servis Cloudflare hesabında yayınlandı. Ana uygulamanın yayını mevcut GitHub/VPS hattından yapılır.

## İlk kurulum (bir defalık yayın gerekir)

1. Proje kökünde bağımlılıkları mevcut kilit dosyasıyla yükle.
2. `services/maintenance/wrangler.toml` içindeki `APP_URL` değerini gerçek
   public kökenle eşleştir (örnekte `https://manicepte.com`).
3. Cloudflare hesabında oturum açıp proje kökünden bağımsız servisi hazırla:

   ```sh
   pnpm dlx wrangler@4 secret put ADMIN_TOKEN --config services/maintenance/wrangler.toml
   pnpm dlx wrangler@4 deploy --config services/maintenance/wrangler.toml
   ```

   En az 32 karakterlik rastgele secret kullan. Kaynak koda/JSON dosyasına yazma.
   Durum servisi adresini (ör. Worker'ın workers.dev adresi) kaydet.

4. Web sunucusuna ekle:

   ```dotenv
   MAINTENANCE_SERVICE_URL=https://size-ait-durum-servisi.workers.dev
   MAINTENANCE_ADMIN_TOKEN=ayni-guclu-secret
   ```

5. Web uygulamasını bir kez yayınla. Sonraki mod/mesaj/saat/hizmet değişiklikleri
   admin panelinden yapılır; deploy ve DB migration gerekmez.
6. Admin panelinden önce duyuru, ardından kısmi ve tam bakım denemesi yap.
   Ayrı oturumsuz pencerede ekranı ve normale dönüşü kontrol et. Mevcut yönetim
   oturumu, yeniden giriş ve cron erişiminin açık kaldığını doğrula.

`MAINTENANCE_SERVICE_URL` boşsa entegrasyon pasiftir; mevcut site akışı sürer.
Adres yanlışsa veya durum servisi erişilemezse uygulama gelen trafiği açık bırakır
(fail-open), public durum ucu 503 döner ve açık uygulamada “durum doğrulanamıyor”
uyarısı görünür. Bilinmeyen durum normal olarak gösterilmez. Bu tercih, durum
servisi kesintisinin çalışan uygulamayı kapatmaması içindir; durum servisi
kesintisinde daha önceki bakımın uygulanacağı garantisi yoktur.

## Ana web sunucusu tamamen kapalıyken aynı alan adında ekran

Bağımsız durum adresi ana sistemden ayrıdır. **Yalnızca Next proxy entegrasyonu,
web sunucusu tamamen kapalıyken ana alan adında ekran sunamaz.** Bunun için
Worker'ın isteği web sunucusundan önce karşılaması gerekir:

1. Public alan adını Cloudflare üzerinden Worker'a yönlendir; yalnızca public
   siteye route bağla. Ayrı admin hostunu bu route'a ekleme.
2. Web uygulamasını ayrı bir origin hostname üzerinden erişilebilir yap.
3. `GATEWAY_ORIGIN` değerine bu HTTPS origin kökenini yaz. Public alan adıyla
   aynı olamaz; sonsuz proxy döngüsü kontrolü vardır.
4. Web'in `MAINTENANCE_SERVICE_URL` ayarında bağımsız workers.dev/durum adresini
   kullan; gateway domainini kullanıp kendi kendini çağırma.
5. Origin güvenliğini, izin verilen hostları ve mevcut oturum/OAuth alan adı
   ayarlarını gerçek altyapıda doğrula. Doğrudan origin adresini kullanıcıya
   duyurma; gerekirse ağ katmanında yalnızca gateway erişimine aç.
6. Origin'i durdurup public adresi aç: standalone 503 ekranı gelmeli. Origin
   düzelince `/api/health` başarılı olmadan otomatik dönüş yapılmaz. Bu uç web sunucusunun ayakta olduğunu gösterir; veritabanı sağlığını doğrulamaz.

Worker origin'e gidemediğinde veya origin HTML isteğine 5xx döndüğünde genel
erişilemiyor ekranı sunar. Bu otomatik durum adminin kalıcı bakım ayarını
değiştirmez. Worker/DNS/Cloudflare kesintisine karşı mutlak erişilebilirlik
garantisi verilmez. Bu adımlar gerçek DNS ve barındırma erişimi gerektirir;
pakette yalnızca kod ve konfigürasyon hazırlanmıştır.

## Admin/veritabanı erişilemiyorsa acil yönetim

Yetkili operatör Node.js 24 ve secret ortam değişkenleriyle, ana uygulamayı
çağırmadan bağımsız servisi yönetebilir. Secret komut satırına yazılmaz.

```sh
node services/maintenance/admin.mjs status
node services/maintenance/admin.mjs set degisiklik.json
```

`status` yanıtındaki güncel `version` ile örnek dosya:

```json
{
  "status": {
    "mode": "maintenance",
    "message": "Teknik bir sorun üzerinde çalışıyoruz. Anlayışın için teşekkürler.",
    "estimatedEnd": null,
    "services": [],
    "version": 0,
    "updatedAt": null
  },
  "reason": "Acil bakım; olay kaydıyla ilişkilendir",
  "actorId": 123
}
```

`actorId` gerçek operatörün yönetici kullanıcı kimliği olmalı; örnek 123'ü
değiştir. Bu araç ayrı bir acil yetkidir: secret'ı bilen kişi yazabilir,
uygulama rolünü bağımsız servis doğrulamaz. Secret erişimini sınırla ve olay
sonrası değiştir. İşlem geçmişi bağımsız serviste tutulur; mevcut PostgreSQL
`/yonetim/denetim` ekranına kopyalanmaz. Son 100 kayıt üst sınırını aşmadan
uzun süre saklanacak geçmişi güvenli olarak dışarı al.

## Kontroller

```sh
pnpm test:maintenance
pnpm --filter @arilla/core typecheck
pnpm --filter @arilla/web typecheck
pnpm --filter @arilla/web exec vitest run maintenance.test.ts
pnpm --filter @arilla/core exec vitest run src/admin/capabilities.test.ts src/admin/coverage.test.ts
pnpm dlx wrangler@4 deploy --dry-run --config services/maintenance/wrangler.toml
```

Bakım testleri gerçek üretim servisine yazmaz. Worker testlerinin depolama
taklidi transaction/sürüm çatışması ve başarısız yazma davranışlarını doğrular;
gerçek Cloudflare/DNS doğrulamasının yerini almaz. Teslimat sırasında Wrangler'ın
gerçek yerel SQLite çalışma ortamında da eşzamanlı iki yazma için 200/409,
public durum ve bağımsız bakım HTML'i ayrıca doğrulandı. Windows'ta uzun
proje yolları yerel SQLite erişiminde hata verebilir; `wrangler dev` komutunda
`--persist-to` ile daha kısa bir yerel klasör kullan.

Yerel kontroller: 13 bağımsız servis testi, 9 web entegrasyon testi,
17 yetki/kapsam testi ve 79 mevcut takip bağlantısı politika testi geçti.
Web'in 393 birim testinden ilk çalıştırmada `/durum` rezervasyonu testi hata
verdi; rota rezerve edilerek ilgili 3 test tekrar çalıştırıldı ve geçti.
Core, web ve bağımsız Worker tip kontrolleri geçti. Paketleme denemesi
(`wrangler deploy --dry-run`) başarılı; gerçek dağıtım yapılmadı.

Mevcut veritabanlı
entegrasyon testleri yerel PostgreSQL ve yapılandırılmış oturum ortamı ister.

Teknik referans: [Cloudflare SQLite-backed Durable Object depolaması](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## İlk yayın durumu

2026-10-21: Bağımsız Worker ve SQLite Durable Object Cloudflare hesabında yayınlandı. Yönetim secretı tanımlandı. Canlı durum ekranı: https://manicepte-maintenance.manicepte.workers.dev/durum . Ana uygulama entegrasyonu ve ana alan adı için gateway yönlendirmesi henüz etkinleştirilmedi.

## Mevcut VPS için aynı alan adı üzerinde Route kurulumu

`wrangler.production.toml` mevcut proxied `manicepte.com` DNS kaydının arkasındaki VPS’e Cloudflare Route olarak bağlanır; yeni bir origin DNS adı veya Caddy alan adı gerekmez. `GATEWAY_PASSTHROUGH=true` yalnızca `APP_URL` ile `GATEWAY_ORIGIN` aynı olduğunda geçerlidir. `global_fetch_private_origin` uyumluluk bayrağı, Worker alt isteklerinin aynı Worker’a yeniden girmek yerine mevcut DNS origin sunucusuna gitmesini sağlar. Gelen istemci isteğinin Cloudflare korumaları değişmez. Bu yapı Custom Domain olarak değil, mevcut origin önündeki Route olarak kurulmalıdır.

Önce yalnızca `manicepte.com/_maintenance-canary/*` yolu ile origin geçişi doğrulanır. Başarılıysa route `manicepte.com/*` olarak değiştirilip aynı config ile yayınlanır. Yönetimin ayrı hostu bu pattern dışında kalır. Geri almak için Worker route kaldırılır; web ortam dosyasının yedeği `/opt/arilla/env/web.env.before-maintenance-20261021` konumundadır.

Referans: https://developers.cloudflare.com/workers/configuration/routing/routes/ ve https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public .
