# 0088 — GA4 raporlaması: anahtarsız federe kimlik (Vercel OIDC + Workload Identity Federation)

**Tarih:** 9 Ekim 2026
**Durum:** Kabul edildi (kod hazır; Google Cloud ve Vercel ayarları elle, `docs/ops.md` → "GA4")

## Bağlam

Karar 0087, `/yonetim/trafik` için GA4 Data API'ye servis hesabının JSON
özel anahtarıyla (JWT-bearer) erişiyordu. Kalıcı bir anahtar Vercel ortam
değişkeninde durur, sızarsa iptal edilene kadar geçerlidir ve elle
döndürülmesi gerekir. Vercel her fonksiyon çağrısına kısa ömürlü, imzalı bir
OIDC belirteci verir; Google Cloud Workload Identity Federation bu belirteci
doğrudan kabul edebilir.

## Karar

1. **İki kimlik kipi, aynı anda yalnızca biri** (`analytics-ga4/config.ts`):
   - `federated` (önerilen): `GA4_WIF_AUDIENCE` = sağlayıcının tam kaynak adı.
     Akış: OIDC belirteci → `sts.googleapis.com/v1/token` (RFC 8693 belirteç
     değişimi) → `iamcredentials …:generateAccessToken` ile servis hesabına
     bürünme (kapsam yalnızca `analytics.readonly`, 1 saat) → Data API.
   - `key` (taşınabilirlik yedeği): mevcut `GA4_PRIVATE_KEY` akışı, değişmedi.
   - İkisi birden tanımlıysa yapılandırma **geçersizdir**; hangisinin
     kullanılacağı tahmin edilmez, ağ çağrısı yapılmaz.
2. **Çekirdek sağlayıcıdan bağımsız:** `packages/core` Vercel'i tanımaz;
   OIDC belirtecini `Ga4Transport.subjectToken` sağlayıcısından ister.
   Sağlayıcıyı `apps/web/app/lib/ga4-identity.ts` verir: Vercel üzerinde
   (`VERCEL=1`) istek başlığı `x-vercel-oidc-token`, yoksa `VERCEL_OIDC_TOKEN`.
   Vercel dışında istemcinin gönderdiği başlık kimlik sayılmaz.
3. **Bürünme zorunlu:** GA4 mülk erişimi yalnızca e-posta kabul eder; federe
   kimlik (`principal://…`) mülke eklenemez. Mevcut servis hesabı ve mülkteki
   Görüntüleyici rolü korunur.
4. **En dar güven:** sağlayıcının öznitelik koşulu ve IAM bağı tek bir `sub`
   değerine bağlıdır: bu projenin **yalnızca production** ortamı. Preview ve
   geliştirme erişemez.
5. **Belirteç hijyeni:** OIDC ve federe ara belirteç hiç saklanmaz; yalnızca
   bürünülmüş erişim belirteci süreç belleğinde, `expireTime`'dan 60 sn önceye
   kadar tutulur. Hata mesajları yalnızca sabit kod taşır; yeni kodlar
   `identity_unavailable`, `federation_rejected`, `impersonation_denied`
   operatöre hangi halkanın koptuğunu söyler. Kimlik hatasında bellekteki
   belirteç atılır.
6. **Değişmeyenler:** rapor tanımları, önbellek, kota koruması, küçük hücre
   kuralı, `traffic.read` yetkisi ve CSP (çağrılar yalnızca sunucudan). SDK
   ya da yeni bağımlılık eklenmedi.

## Gerekçe

Kalıcı sır ortadan kalkar; sızan bir belirteç en fazla bir saat ve yalnızca
salt okunur GA4 kapsamında işe yarar. Erişim Google tarafında bir sağlayıcı
devre dışı bırakılarak tek adımda kesilebilir. Anahtar kipinin kalması
`docs/ops.md`'deki "Vercel'e kilitlenilmez" ilkesini korur.

## Reddedilen alternatifler

- **`google-auth-library` `ExternalAccountClient`:** aynı akışı yapar, ancak
  büyük bir bağımlılık getirir; mevcut istemci bilinçli olarak SDK'sızdır ve
  akış iki `fetch` çağrısıdır.
- **`@vercel/oidc` paketi:** başlığı ve ortam değişkenini okumaktan ibaret;
  bağımlılık eklemeye değmez.
- **Federe kimliğe doğrudan kaynak erişimi (bürünmesiz):** GA4 mülk erişimi
  federe özneleri kabul etmez.
- **`principalSet` ile havuzun tamamına izin:** preview ve diğer projeleri de
  kapsar; tek özne yeterli ve daha dar.
- **İki kip birlikteyken federeyi tercih etmek:** sessiz öncelik, yanlış
  yapılandırmayı gizler; açık hata daha güvenli.
