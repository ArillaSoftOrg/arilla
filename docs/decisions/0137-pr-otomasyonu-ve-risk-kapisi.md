# 0137 — PR otomasyonu: merge queue, deterministik risk kapısı, dağıtım durumu

Tarih: 2026-10-18

## Karar

Rutin PR işleri yalnızca GitHub Actions ve GitHub'ın kendi özellikleriyle otomatikleşir. Sürekli
çalışan ajan, ücretli model çağrısı ya da ek servis yoktur.

1. **Tek zorunlu CI kontrolü `ci ok`.** `ci.yml`'deki bütün işlere bağlı toplayıcı iş. Başarısız ya da
   iptal edilen iş geçmez; atlama yalnızca PR'da (salt dokümantasyon) meşrudur, main ve merge queue
   tam koşar. Yeni iş eklenince yalnızca `needs` listesi güncellenir.
2. **Merge queue (squash) + auto-merge.** "Update branch" artık gerekmez: kuyruk her PR'ı main'in
   güncel ucuyla birleştirip `ci`, `security-checks` ve `pr-policy`'yi `merge_group` olayıyla yeniden
   koşar; yeşilse main'e yazar. Kuyruğun main'e yazdığı commit normal `push` olayıdır; mevcut
   `ci → build-push → deploy` zinciri değişmeden çalışır. Kuyruk dalları (`gh-readonly-queue/...`)
   imaj yayınlamaz, dağıtılmaz.
3. **`pr policy` durumu (deterministik risk kapısı).** `scripts/pr-policy.mjs`, `pull_request_target`
   ile **main'deki** sürümden çalışır; PR kendi kapısını değiştiremez, PR kodu çalıştırılmaz.
   - Yüksek risk: migration/şema, auth/authz/RLS/yönetim, üretim yapılandırması/CI/dağıtım/CLAUDE.md,
     bağımlılıklar, ödeme/affiliate/attribution, veri silme/saklama, ürün yayınlama/katalog, eklenen
     satırda yıkıcı SQL, >60 dosya ya da >1500 satır, belirsiz dosya listesi.
   - Yüksek riskli PR, yazma yetkili bir **insan** `risk-approved` etiketini ekleyene dek `failure`
     kalır. Yeni push etiketi düşürür (onay incelenen commit'e bağlıdır). İsteğe bağlı depo
     değişkeni `RISK_APPROVERS` (virgüllü kullanıcı adları) onaylayıcıları daraltır.
   - Bağımlılık: PR gövdesinde `Depends on #N` / `Bağımlı: #N` satırı. N birleşmeden `failure`;
     N birleşince bağımlı PR'lar kendiliğinden yeniden değerlendirilir. Merge queue grubunda da
     aynı karar yeniden verilir.
   - Çakışma: main'e her push'ta ve 6 saatte bir açık PR'lar taranır; çakışan PR'a `merge-conflict`
     etiketi ve tek yorum konur, çözülünce etiket kalkar. **Hiçbir çakışma otomatik çözülmez.**
4. **Dağıtım sonucu GitHub'da.** `deploy.yml` sonucu sürüm commit'ine `deploy/vps-production`
   durumu olarak yazar (success / failure / error = yapılandırma yok). Mevcut sha etiketli GHCR
   imajları, tek dağıtım kilidi, VPS sağlık kontrolü ve otomatik geri alma (karar 0109) aynen kalır.

Risk sınıfı yalnızca yol ve içerik kalıplarından çıkar. **Hiçbir AI/model kararı bu kapıyı geçemez
ya da onay yerine geçemez;** Claude Code `risk-approved` etiketini asla eklemez (CLAUDE.md).

## Gerekçe

- Kural setinde "branch güncel olmalı" açıktı, auto-merge kapalıydı: her PR elle güncelleniyor,
  sıra bekleniyordu. Merge queue bu işi güvenli biçimde (main'in ucu + PR birlikte test edilerek)
  üstlenir; açık depoda ücretsizdir.
- Zorunlu kontrol listesi beş işti; `compose stack`, `deploy engine`, migration testi gibi işler
  kırmızıyken PR birleşebiliyor, sonra dağıtım `plan` adımında duruyordu. `ci ok` bunu kapatır.
- Zorunlu onay sayısı 0 ve PR'ları çoğunlukla aynı kişi (Claude Code aracılığıyla) açıyor; GitHub
  kendi PR'ını onaylatmaz. Etiket tabanlı insan onayı bu ekip yapısında uygulanabilir tek kapıdır.

## Sınırlar (bilinçli)

- Claude Code kullanıcının `gh` oturumuyla çalıştığından GitHub, etiketi kullanıcının mı Claude'un
  mu eklediğini ayıramaz. Kapı teknik olarak "yazma yetkili kişi"yi doğrular; "Claude eklemez"
  kuralı protokoldür. Daha sıkı ayrım için ikinci bir onaylayıcı (`RISK_APPROVERS`) ya da zorunlu
  inceleme gerekir.
- Auto-merge iş akışı tarafından değil, PR sahibi (insan ya da Claude Code, kullanıcı oturumuyla)
  tarafından açılır: `GITHUB_TOKEN` ile açılan auto-merge'ün oluşturduğu commit `push` iş akışlarını
  tetiklemez ve `ci → build-push → deploy` zinciri kırılırdı.
- Kural seti değişikliği (merge queue + yeni zorunlu kontroller) bu PR main'e girdikten **sonra**
  `scripts/github-settings.sh --apply` ile uygulanır; önce uygulanırsa tüm PR'lar kilitlenir.

## Reddedilen alternatifler

- **Model tabanlı PR inceleme/risk kararı:** ücretli, deterministik değil, istek dışı bir güven
  kaynağı. Reddedildi.
- **Botun BEHIND PR'ları `update-branch` ile güncellemesi:** `GITHUB_TOKEN` push'u CI tetiklemez,
  PR'lar sonsuza dek bekler; PAT ise uzun ömürlü sır demek. Merge queue aynı işi sırsız yapar.
- **"Branch güncel olmalı"yı kapatıp yalnızca auto-merge:** main'de birlikte test edilmemiş
  birleşimler. Reddedildi.
- **Mergify / Kodiak gibi dış servis:** ek üçüncü taraf yetkisi; GitHub'ın yerleşik kuyruğu yeterli.
