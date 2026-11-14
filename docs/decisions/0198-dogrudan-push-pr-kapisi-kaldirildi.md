# 0198 — Doğrudan main'e push; PR/risk kapısı kaldırıldı

Tarih: 2026-11-14. Karar 0137'nin PR otomasyonunu (merge queue, `pr policy`, `risk-approved`) geçersiz kılar.

## Karar
- Varsayılan akış: Claude Code değişikliği `main`'e doğrudan push eder. `main`'e her push otomatik
  üretim dağıtımıdır (`ci → build-push → deploy`, karar 0109 geri alma ve sağlık kontrolü aynen kalır).
- `pr policy` iş akışı, `scripts/pr-policy.*`, `risk-approved` etiketi, auto-merge ve merge queue
  kaldırıldı. Bağımlılık (`Depends on`) ve çakışma taraması da bununla birlikte gitti.
- main kural seti yalnız `deletion` ve `non_fast_forward` (silme ve force-push yasağı) içerir.
  PR zorunluluğu ve zorunlu durum kontrolleri yoktur.
- PR açmak isteğe bağlıdır (kullanıcı isterse ya da şema/auth/yıkıcı SQL gibi riskli işte).

## Gerekçe
Kullanıcı her değişikliği Claude Code ile oturumda birlikte inceliyor; ayrı bir etiket onayı ikinci,
tekrarlayan bir katmandı ve akışı yavaşlatıyordu (0137 "Sınırlar": GitHub etiketi kimin eklediğini ayıramaz).

## Kabul edilen risk
Push öncesi CI kapısı yoktur: kırmızı CI main'e girer, yalnız dağıtım durur (düzeltme yeni commit).
Şema/migration push'u önce `migrate` ister (bkz. 0137 öncesi uygulama notu); bu kapı yok, dikkat gerekir.

## Reddedilen
- Admin bypass ile kural setini koruma: yine de ayrı bir PR yolu bırakır; kullanıcı tamamen kaldırmayı seçti.
- `pr policy`'yi yalnız bilgilendirmeye çevirmek: kullanıcı tamamen kaldırmayı seçti.
