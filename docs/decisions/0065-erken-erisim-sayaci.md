# 0065 - Erken erişim sayacı ve ilerleme çubuğu

## Karar

Lansman öncesi landing (`/`) ve `/erken-erisim` sayfasında erken erişim
ilerleme çubuğu gösterilir: **gösterilen sayı = platform dışı gerçek
başvurular + `early_access` satır sayısı, hedef 5.000 ile sınırlı**.

- **Platform dışı başvurular**: siteden kayıt olamayıp e-postayla erken erişim
  isteyen gerçek kişiler. Tek satırlık `early_access_counter` tablosunda
  tutulur (migration 0050); başlangıç değeri 78 (kurucunun beyanı).
- **Güncelleme**: yalnızca yönetici (`early_access.manage`),
  `/yonetim/erken-erisim`. Girilen değer yeni toplamdır; gerekçe (kaynak ve
  tarih) zorunludur; her değişiklik aynı işlemde `admin_audit_event`'e
  (`early_access.counter_set`, önceki/yeni değer + gerekçe) yazılır.
- **Gerçek kayıt**: `COUNT(early_access)` her istekte veritabanından okunur;
  yeni kayıt bir sonraki istekte +1 görünür, sayfa yenilemek sayıyı
  değiştirmez. İstemci deposu (`localStorage`) ve cache yok.
- Yüzde = `min(hedef, toplam) / hedef`, bir ondalık. Hesap saf fonksiyondur
  (`computeEarlyAccessProgress`), birim testlidir.
- Sayaç okunamazsa çubuk gösterilmez; uydurma yedek sayı yoktur.
- Hedef (5.000) kodda sabittir (`EARLY_ACCESS_TARGET`).

## Gerekçe

Kullanıcıya gösterilen "X kişi listede" iddiası doğru olmalıdır. Siteye
sığmayan gerçek başvurular (e-posta) elle ve denetlenebilir biçimde eklenir;
sayı sonradan açıklanabilir bir kaynağa dayanır.

## Reddedilen

- **Takvime bağlı, tohumlu rastgele günlük artış (günde 5-20 kişi).** Kimsenin
  kayıt olmadığı rakamı kayıtlı kişi gibi göstermek kullanıcıyı yanıltır
  (sahte sosyal kanıt; yanıltıcı ticari uygulama riski) ve ürünün güven
  vaadiyle çelişir. Bu yüzden hiçbir otomatik/sahte artış yok.
- İstemci tarafında `localStorage` ile sayma: güvenilir değil, yenilemede
  tutarsız.
- Cron ile sayaç güncelleme: gerekmiyor, sayı istek anında hesaplanır.
