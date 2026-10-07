# 0067 - Okunabilir davet kodu ve "Son baktıkların" yazma yolu

## Karar

**1. Son baktıkların.** `/hesap` ve `/gecmis` `product_view` tablosunu okuyordu;
ürün sayfası ise yalnızca `user_activity_event` (analitik, 0049) yazıyordu.
`product_view` için yazma yolu hiç yoktu, liste her zaman boştu. Artık ürün
sayfası `recordProductView` çağırır (`packages/core/src/account/history.ts`):

- Yalnızca girişli kullanıcı ve yalnızca son `browsing_history` kararı `granted`
  iken yazılır (kvkk.md: gezinme geçmişi açık rıza). Analitik rızasından ayrıdır.
- Kullanıcı başına ürün başına TEK satır: tekrar görüntüleme `viewed_at`'i
  günceller (en yeni başta, kopya yok). Kullanıcı başına son 50 tutulur (0009).
- `session_id` (NOT NULL) sabit `account` yazılır; oturum kimliği saklanmaz.
- Kullanıcı başına danışma kilidi eşzamanlı isteklerde tek satır garanti eder.

**2. Okunabilir davet kodu.** `app_user.referral_public_code`
(`<2 harf>-<5 rakam>`, örn. `YS-49577`), migration 0051, EKLEMELİ.

- Önek: görünen addan, Türkçe harfler ASCII'ye (ç→C, ğ→G, ı/İ→I, ö→O, ş→S,
  ü→U); iki+ sözcükte ilk ve son sözcüğün baş harfi, tek sözcükte ilk iki harf.
  Ad yoksa, harf içermiyorsa ya da `@` içeriyorsa `MC`. E-posta kullanılmaz.
- Rakamlar `10000-99999` rastgele. Benzersiz kısmi indeks çakışmayı yakalar;
  12 denemenin ilk yarısı kendi önekiyle, sonrası `MC` ile tekrarlanır.
- Kod `/hesap` ilk açıldığında bir kez yazılır; ad değişse de değişmez
  (`WHERE referral_public_code IS NULL`).
- **Geriye uyumluluk:** `referral_code` (0034) ve dağıtılmış tüm linkler
  değişmeden çalışır; bağlama `referral_code = $1 OR referral_public_code = $1`
  ile arar. Backfill yok, mevcut `referral` ilişkilerine dokunulmaz. Ödül
  mantığı (`qualifyReferralInTx`) aynıdır.

**3. Arayüz.** `/hesap` davet kartı sadeleşti: "Arkadaşlarınıza tavsiye edin"
başlığı, "Yönlendirme bağlantınız" etiketi, büyük bağlantı, tam genişlik
"Panoya kopyala" düğmesi (sonra onay işareti ve "Kopyalandı"). Ödül metni,
sayaç ve hak/limit ifadesi arayüzde yoktur; mantık core'da durur.
Düğme metni ALL CAPS değil (CLAUDE.md: Türkçe büyük harf dönüşümü).

## Gerekçe

Yazma yolu eksikti; analitik tablosundan okumak rıza sınıflarını karıştırırdı
ve `/gecmis` silme/dışa aktarma/hesap silme akışları zaten `product_view`
üzerine kuruludur. Davet için yeni kolon, mevcut paylaşılmış linkleri
bozmayan en basit yoldur.

## Reddedilen alternatifler

- Son baktıkları `user_activity_event`'ten okumak: analitik rızasına bağlı
  olur, silme/dışa aktarma akışlarını bölerdi.
- `referral_code` değerini yeniden yazmak: dağıtılmış linkleri kırar; CHECK
  kısıtı da değişirdi (geriye uyumsuz).
- Önek için e-posta yerel kısmı: kişisel veri sızıntısı.
