# 0044 — Yönetim girişi ve yönetim oturumu politikası

**Tarih:** 28 Eylül 2026
**Durum:** Kabul edildi

0039'un yetki haritası (rol → yetenek, her sayfa ve action'da
`requireCapability`) değişmez. Bu karar yönetim alanına ayrı giriş ekranı ve
normal kullanıcı oturumundan daha sıkı bir oturum politikası ekler.

## Karar

1. **Ayrı giriş ekranı:** `/yonetim/giris`. Aynı dört sağlayıcı (Google,
   Apple, telefon, e-posta) ve aynı oturum modeli (`session` tablosu); fark
   yalnızca dönüş yolu. `next` her zaman güvenli bir `/yonetim` yoludur
   (`safeAdminNext`). Sayfa yönetim kabuğunun dışında çizilir: proxy adresi
   `/giris/yonetim`'e rewrite eder, böylece layout'un yetki kapısına takılmaz.
2. **Yetkisiz giriş:** Yönetim girişini kullanan normal kullanıcı yönetim
   alanına yönlendirilmez; kendi akışına döner (`postAuthRedirect`: ürün
   kapalıyken `/erken-erisim`). Doğrudan `/yonetim` açarsa 404 (0039).
3. **Yönetim oturumu:** Normal oturum 90 gün kalır. Yönetim alanında aynı
   oturum şu kurallarla değerlendirilir (sunucuda, her istekte):
   - en uzun ömür: girişten itibaren **12 saat**;
   - boşta kalma: son istekten itibaren **30 dakika** (`last_used_at`'in bu
     istekten önceki değeri).

   Kural ihlal edilirse oturum **sunucuda silinir** ve kullanıcı
   `/yonetim/giris?neden=sure|bosta&next=...` adresine gider. Silmek
   zorunludur: `last_used_at` doğrulamada güncellendiği için sayfayı yenilemek
   boşta kalma kuralını aksi halde atlatırdı. Bu yalnızca yönetim yetkili
   hesapları etkiler.
4. **Taze giriş:** Yüksek etkili mutasyonlar son **1 saat** içinde yapılmış
   bir giriş ister (`requireFreshCapability`). Değilse işlem yapılmaz ve
   `/yonetim/giris?neden=yeniden&next=...` bağlantısı gösterilir.
   Bugünkü liste:
   - mağaza aç/kapat (`merchant.manage`): canlı katalogdaki fiyat ve
     teklifleri etkiler, yalnızca yönetici.

   Kapsam dışı (bilinçli): eşleştirme onay/red ve sözlük yazma — moderatörün
   rutin, denetime yazılan ve geri alınabilen işleri; kullanıcı arama salt
   okunur. Rol değiştirme, hesap silme ve kimliğe bürünme arayüzde yok
   (yalnızca SQL, 0039); eklenirse bu listeye girer.
5. **Rol düşürme:** Rol her istekte veritabanından okunur; rolü düşürülen
   kişi aynı oturumla bir sonraki yönetim isteğinde erişimi kaybeder.

## 0043 ile ilişki

0043 (lansman öncesi landing) ile birlikte geçerlidir:

- Landing ve footer'daki "Admin Girişi" bağlantısı 0043'teki gibi
  `/giris?next=/yonetim` kalır (`ADMIN_LOGIN_PATH`). `/yonetim/giris`
  (`ADMIN_LOGIN_PAGE_PATH`) anonim yönetim isteğinin, süresi dolan ya da
  boşta kalan yönetim oturumunun ve taze giriş isteyen işlemin gittiği
  ekrandır. İkisi aynı giriş akışını ve aynı `postAuthRedirect`'i kullanır.
- `product.preview` yalnızca yöneticidedir (0043). Ürüne erişemeyen
  moderatör giriş sonrası konsola döner; ürüne erişebilen ama yönetim
  yetkisi olmayan kullanıcı `/yonetim` hedefine gönderilmez (madde 2).

## Gerekçe

Yönetim oturumu, çalınması en pahalı çerezdir: 90 günlük bir yönetici
oturumu 90 gün boyunca katalog ve kullanıcı verisine erişim demekti. Ayrı
kimlik sistemi ya da ikinci tablo yerine mevcut `session` satırının
`created_at` ve `last_used_at` alanları yeterli; migration gerekmez.

## Reddedilen alternatifler

- **Ayrı yönetici oturum tablosu / ikinci çerez:** iki oturum modeli ve iki
  giriş kodu yolu; kazanç yok.
- **Yönetim alanını route grubuna taşımak** (`/yonetim/(panel)/...`): tüm
  dosyaların ve göreli import'ların yer değiştirmesi; proxy rewrite aynı
  sonucu tek satırla veriyor.
- **Tüm yönetim mutasyonlarına taze giriş:** moderatörü saatte bir yeniden
  girişe zorlar; rutin ve geri alınabilir işlerde güvenlik kazancı düşük.
