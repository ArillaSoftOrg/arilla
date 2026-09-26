# Cookie Banner + Consent Management Uygulama Spesifikasyonu

## Amaç

Arilla sitesinde zorunlu olmayan çerez ve izleme teknolojilerini kullanıcı tercihi olmadan çalıştırmayan, tercihleri kaydeden ve sonradan değiştirilebilir kılan bir consent mekanizması oluşturmak.

## 1. İlk ziyaret banner'ı

İlk ziyarette banner göster.

Başlık:
**Gizlilik tercihlerinizi yönetin**

Kısa metin:
**Sitenin çalışması için gerekli çerezleri kullanıyoruz. Analitik, işlevsel ve reklam/affiliate ölçüm teknolojilerini ise yalnızca izin verdiğiniz kategoriler için etkinleştiriyoruz. Tercihlerinizi istediğiniz zaman değiştirebilirsiniz.**

Butonlar aynı seviyede erişilebilir olmalı:

1. **Tümünü Reddet**
2. **Tercihleri Yönet**
3. **Tümünü Kabul Et**

Kabul butonunu kullanıcıyı manipüle edecek ölçüde baskın tasarlama.

## 2. Tercih paneli

Kategoriler:

### Kesinlikle gerekli
- Daima açık.
- Toggle disabled.
- Oturum, güvenlik, auth, consent tercihi, rate-limit gibi gerçekten gerekli işlevler.

### İşlevsel
- Varsayılan: kapalı.
- Yalnızca gerçekten mevcutsa göster.

### Analitik / performans
- Varsayılan: kapalı.
- Analytics scriptleri kullanıcı kabulünden önce yüklenmemeli.

### Reklam / affiliate ölçüm
- Varsayılan: kapalı.
- Cihaz üzerinde zorunlu olmayan takip/ölçüm yapıyorsa izin öncesi yüklenmemeli.

## 3. Consent kaydı

Tercihi yalnızca bir gerekli cookie veya eşdeğer first-party storage ile kaydet.

Önerilen şema:

```json
{
  "version": 1,
  "necessary": true,
  "functional": false,
  "analytics": false,
  "marketing": false,
  "updatedAt": "ISO_DATE"
}
```

Politika/consent sürümü değiştiğinde gerektiğinde tekrar tercih iste.

## 4. Script gating

Kesin kural:

- `analytics === true` olmadan analitik script/import/event gönderme.
- `marketing === true` olmadan reklam/marketing tag/pixel çalıştırma.
- `functional === true` olmadan zorunlu olmayan işlevsel izleme çalıştırma.
- Zorunlu teknolojileri "analitik" etiketiyle gizlemeye çalışma.
- Affiliate dış linkine normal URL parametresi eklemek ile kullanıcı cihazında izleme teknolojisi çalıştırmayı ayrı değerlendir.

Next.js'te kullanılan script/SDK'lar client tarafında consent state doğrulandıktan sonra mount edilmeli. Server-side event gönderimi de kullanıcı cihazındaki consent ile ilişkili zorunlu olmayan ölçüm yapıyorsa aynı izin mantığını izlemeli.

## 5. Rıza geri çekme

Footer'a sürekli görünür:
**Çerez Tercihleri**

bağlantısı ekle.

Kullanıcı tercihini değiştirince:
- yeni tercih kaydedilmeli,
- reddedilen kategoriler için yeni event gönderimi derhal durmalı,
- mümkünse ilgili first-party non-essential cookies temizlenmeli,
- üçüncü taraf çerezlerinin temizlenemediği durumlarda en azından ilgili üçüncü taraf kodu yeniden çalıştırılmamalı.

## 6. Aydınlatma bağlantıları

Banner/panel içinde:
- Çerez Politikası
- Gizlilik Politikası
- KVKK Aydınlatma Metni

bağlantıları bulunmalı.

## 7. Erişilebilirlik

- Klavye ile tamamen kullanılabilir.
- Focus trap yalnız modal açıkken.
- ESC davranışı kullanıcının reddetmeden banner'ı görünmez kılmasına yol açmamalı.
- Screen reader label'ları.
- Yeterli kontrast.
- Mobilde butonlar taşmamalı.

## 8. Testler

En az şu testleri ekle:

1. İlk ziyarette banner görünür.
2. Consent yokken analytics/marketing scriptleri yüklenmez.
3. "Tümünü Reddet" gerekli dışındaki kategorileri false kaydeder.
4. "Tümünü Kabul Et" tüm kategorileri true kaydeder.
5. Tercihler panelinde kategori bazlı seçim kaydedilir.
6. Sayfa yenilendiğinde tercih korunur.
7. Footer'daki "Çerez Tercihleri" paneli yeniden açar.
8. Consent sürümü değişirse uygun yeniden onay akışı çalışır.
9. Legal sayfa rotaları 200 döner.
10. Footer legal linkleri doğru çalışır.
