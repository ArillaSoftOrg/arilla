# ManiCepte frontend tasarım ve uygulama rehberi

Bu rehber, mevcut ManiCepte arayüzünü koruyarak kurumsal, destek ve hukuki sayfaları geliştirmek için uygulanır. Yeni bir tasarım sistemi veya bütün sayfalar için tek bir şablon tanımlamaz.

## 1. Kapsam, kaynaklar ve karar sırası

- Tasarım açısından kritik ürün ekranları (ana sayfa, sohbet, arama, ürün, nasıl çalışır) Codex; atanmış kurumsal ve destek sayfaları Claude Code tarafından ele alınır. Her görevde verilen sayfa ve kapsam belirleyicidir.
- Önce [repo kurallarını](../../CLAUDE.md), [arayüz kurallarını](../../.claude/rules/web-ui.md) ve ilgili klasörün talimatlarını oku. Uygulama kodu yazmadan önce [web talimatlarının](../../apps/web/AGENTS.md) istediği kurulu Next.js belgelerini incele.
- Tasarım ilkeleri ve ayrıntılı ölçü tabloları için ana kaynak [docs/design.md](../design.md); uygulanmış token değerleri için tek kaynak [tokens.css](../../packages/ui/src/tokens.css) dosyasıdır. Bu rehber bunların kullanımını açıklar, değerlerini yeniden tanımlamaz.
- Bileşenin güncel API'sini kendi kaynak dosyasından doğrula. Onaylı bir ekrandaki sayfaya özel ölçü, efekt veya davranış başka sayfalar için otomatik kural değildir.
- Kaynaklar çelişirse farkı dosyalarıyla raporla; çalışan ortak bileşeni, erişim kuralını veya token sistemini sayfa işi sırasında kendiliğinden değiştirme. Kullanıcının açık, güncel kararı görev kapsamını belirler.
- Sayfanın depoda bulunması, tasarımının tamamlandığı veya metninin onaylandığı anlamına gelmez. Özellikle hukuki içerik için ayrı onay gerekir.

**İnceleme kaydı:** 2 Kasım 2026; kaynak tabanı `5891b81`. Canlı `/` rotasında ürün erişimli ana sayfa açık temada, anonim erken erişim tanıtımı koyu temada; her ikisi de 390 × 844 ve 1280 × 900 görünüm boyutlarında incelendi. Ana sayfanın iki boyutta ekran görüntüsü; erken erişimin mobil ekran görüntüsü ve masaüstünde görünür alanı, DOM yerleşimi ve kaynak CSS birlikte değerlendirildi. Erken erişimin masaüstü görüntüsü tarayıcı paneli tarafından yatayda kırpıldığından tam ekran piksel karşılaştırması yapılmadı. Çerez bildirimi erken erişim görüntüsünün altını örtüyordu. Bu inceleme diğer sayfaların, iki temanın bütün kombinasyonlarının veya arama/kayıt işlevlerinin test edildiği anlamına gelmez.

## 2. Görsel dil ve sayfa aileleri

Ortak dil: içeriği öne çıkaran sade yüzeyler, belirgin başlık hiyerarşisi, rahat okuma aralıkları, ince ayırıcılar ve az sayıda güçlü eylem. Görsel bütünlük; aynı logo, tipografi, renk rolleri, ortak kabuk ve etkileşimlerden gelir. Her sayfanın aynı hero yüksekliğine veya kart dizilimine sahip olması gerekmez.

| Referans | Doğrulanan düzen | Başka sayfaya aktarılabilecek ilke | Sayfaya özel kalanlar |
| --- | --- | --- | --- |
| Ürün ana sayfası | Masaüstünde ortalı robot, başlık ve geniş arama yüzeyi; mobilde aynı sıra ve daralan alan. İlk görünüm aramaya odaklı; yardım ve keşif içeriği aşağıda. | Tek belirgin amaç, okunur başlık, mobilde korunmuş içerik sırası ve yeterli nefes alanı. | Ekran yüksekliğine göre hero, robot, arama gölgesi ve arama kutusunun özel genişliği. |
| Erken erişim tanıtımı | Masaüstünde solda anlatım/kayıt/ilerleme, sağda robot; mobilde anlatım, robot ve kayıt sırası. İnce çizgiler alt içeriği ayırıyor. | Açık eylem hiyerarşisi, kısa açıklamalar, bölümler arasında tutarlı ayrım. | Parlak marka dolgulu kayıt çağrısı, ilerleme sayacı, konuşan robot ve kaydırmalı temsili demo. |
| Ortak üst alan | Mobilde menü, logo/marka ve küçük Beta aynı satırda; masaüstünde gezinme genişliğe göre açılıyor. | Ortak bileşeni kullanmak ve alanı ona bırakmak. | Sayfa CSS'inden logo, Beta, menü aralığı veya gezinme eşiklerini yeniden düzenlemek uygun değildir. |

Referanslar: [ana sayfa](../../apps/web/app/page.tsx), [ana sayfa stilleri](../../apps/web/app/home.module.css), [arama bileşimi](../../apps/web/app/home-search-composer-client.tsx), [erken erişim tanıtımı](../../apps/web/app/coming-soon-landing.tsx), [tanıtım stilleri](../../apps/web/app/coming-soon.module.css), [temsili demo](../../apps/web/app/coming-soon-demo.tsx).

- Anonim ziyaretçinin `/` ekranı erken erişim tanıtımıdır. Ürün erişimli `/` ana sayfasından ve giriş gerektiren `/erken-erisim` durum sayfasından farklıdır. Görsel referansa ulaşmak için erişim kontrollerini kaldırma.
- Kurumsal anlatım, destek formu ve uzun hukuki metin kendi içerik akışını kullanır. Hepsine robot, tam ekran açılış, sayaç veya kayıt çağrısı ekleme.
- Ana sayfadaki “Nasıl çalıştığını gör / Yakında” alanı henüz tamamlanmış bir anlatım sayfası değildir. Bu rehberin oluşturulması o işin tamamlandığı anlamına gelmez; gerçek ürün görüntüleriyle ilgili çalışma ayrıca yapılacaktır.
- Dış siteler yalnızca görevde istenirse kullanım akışı açısından referans alınır. Dupe.com veya başka bir sitenin markasını, metnini, görsellerini ya da sayfa geometrisini kopyalama.

## 3. Token ve marka kullanımı

Değer listeleri için [tasarım dokümanını](../design.md) ve [token kaynağını](../../packages/ui/src/tokens.css) kullan. Yeni palet, font, gölge veya radius ölçeği oluşturma.

| İhtiyaç | Kullanılacak mevcut roller | Uygulama kuralı |
| --- | --- | --- |
| Sayfa ve yüzeyler | `--paper`, `--surface`, `--surface-raised`, `--surface-hover` | İçeriği ayırmak gerektiğinde yüzey kullan; her paragrafı karta çevirme. |
| Metin | `--ink`, `--ink-secondary`, `--ink-muted` | İkincil bilgi ile ana metni ayır; düşük kontrastı dekor olarak kullanma. |
| Çizgi ve kontrol sınırı | `--line`, `--line-strong`, `--border-width` | İnce ayırıcı ile etkileşimli kontrol sınırını karıştırma. |
| Eylem ve durum | `--accent*`, `--save`, `--on-save`, `--warning`, `--alert` | Nötr ana eylem ile olumlu işlem/durum rengini kendi anlamında kullan. |
| Marka | `--brand`, `--on-brand`, `--brand-label` | Ham limon yeşilini açık zeminde küçük metin veya tek başına kontrol çizgisi yapma. Beta için mevcut `Badge` marka tonunu kullan. |
| Koyu vurgu bölümü | `--feature-*` | Antrasit zemin + limon vurgu; yalnızca mevcut `/ortakliklar` düzeni gibi tek bir vurgu bölümü için. Editoryal sayfalar ana yüzey belirteçlerini kullanır (karar 0192). |
| Tipografi | `--text-*`, `--font-weight-*`, `--line-height-*`, `--letter-spacing-*` | Anlamsal başlık sırasını koru; görsel boyutu rolüne göre seç. Bütün sayfalara display başlık uygulama. |
| Boşluk ve genişlik | `--space-*`, `--section-space*`, `--content-width-*`, `--gutter` | Önce mevcut düzen bileşenlerini kullan. Okuma metnini wide alana yayma; yatay boşluğu iki kez uygulama. |
| Köşe, gölge, odak, hareket | `--radius-*`, `--shadow-*`, `--focus-*`, `--duration-*`, `--ease-*`, `--z-*` | Bileşenin mevcut stilini tercih et; özel efekt veya keyfi katman sayısı ekleme. |

- Font [globals.css](../../apps/web/app/globals.css) üzerinden yerel IBM Plex Sans'tır. Yeni font, Google Fonts, harici ikon/font CDN'i veya üçüncü taraf betik ekleme.
- Başlıklarda sıkı, uzun metinde rahat satır yüksekliğini koru. Yeni içerikte ağırlık/harf aralığı kararını token rollerinden seç; mevcut marka yazısının stilini gövdeye taşıma.
- Kapsayıcı ailesi: `compact`, `reading`, `comparison`, `standard`, `wide`. Uzun anlatım için `reading`; genişlik gerçekten gerekiyorsa diğerlerini seç. Ayrıntılı ölçüler kanonik kaynakta kalır.
- Tema davranışı mevcut tema çerezi ve tokenlar üzerinden gelir. Sayfa içinde ayrı tema algılama, depolama veya renk paleti kurma. Sistem ve elle seçilmiş koyu temanın token blokları aynı kalmalıdır.
- Kullanıcının verdiği [logo dosyasını](../../apps/web/public/brand/manicepte-logo.png) yeniden çizme, maskeleme, vektörleştirme veya renklendirme. Navbar ve footer varlıklarını ortak kabuk seçer; bunları sayfa görevi içinde eşitlemeye çalışma.
- Beta: küçük “Beta” metni, şeffaf zemin, yeşil metin ve yeşil çerçeve; mobilde marka yazısının yanında kalır. Yeni rozet üretme veya tüm başlığı yeşile boyama. Kaynaklar: [Badge](../../packages/ui/src/Badge.tsx), [HomeHeader stilleri](../../packages/ui/src/HomeHeader.module.css).

## 4. Yeniden kullanılacak bileşenler

Paylaşılan UI dışa aktarımları: [packages/ui/src/index.ts](../../packages/ui/src/index.ts). Uygulamada mevcut `@arilla/ui` kullanımını takip et; aynı işi yapan yerel kopyalar oluşturma.

| Bileşen / kaynak | Kullanım ve sınır |
| --- | --- |
| [PublicSiteShell / SubpageShell](../../apps/web/app/public-site-shell.tsx) | SkipLink, tek `main#icerik`, navbar, oturuma uygun bağlantılar, tema ve footer'ın sahibi. Route layout zaten sarıyorsa sayfayı tekrar sarma. |
| [HomeHeader](../../packages/ui/src/HomeHeader.tsx) | Marka, Beta, menü, hesap ve duyarlı gezinme. Sayfaya özel alternatif header oluşturma. |
| [SiteFooter](../../packages/ui/src/SiteFooter.tsx), [EditorialFooter](../../apps/web/app/editorial-footer.tsx) | Varyantı kabuk seçer. Bağlantıları/sosyal hesapları sayfa içinde kopyalama; mobil büyük marka yazısını kesme. |
| [Container](../../packages/ui/src/Container.tsx) | Genişlik ve yatay gutter. Standart kabuk zaten wide Container sağlar; içeride daraltmak için max-width uygula, ikinci gutter ekleme. |
| [Section](../../packages/ui/src/Section.tsx), [Stack](../../packages/ui/src/Stack.tsx), [Cluster](../../packages/ui/src/Cluster.tsx) | Bölüm aralığı, dikey akış, yatay/sarılabilir gruplar. Sadece bu düzen ihtiyacı için yeni bileşen yazma. |
| [LegalPageLayout](../../packages/ui/src/LegalPageLayout.tsx) | Okuma genişliği, başlık, gerçekse güncelleme tarihi ve metin hiyerarşisi. `article` üretir; ikinci `main` veya gutter üretmez. |
| [Accordion](../../packages/ui/src/Accordion.tsx) | SSS; sabit öğe kimlikleri, uygun `headingLevel`, klavye ve hash davranışı korunur. Yeni açılır panel sistemi kurma. |
| [Button](../../packages/ui/src/Button.tsx) | `accent`: nötr ana eylem; `primary`: olumlu eylem; `secondary`: ikincil; `ghost`: hafif eylem. `md`/`lg`, mevcut şekil ve tam genişlik seçeneklerini kullan. Gezinme için semantik bağlantıyı koru. |
| [Input](../../packages/ui/src/Input.tsx), [PasswordInput](../../packages/ui/src/PasswordInput.tsx) | Mevcut etiket/hata yapısı. Form istemcisinin doğrulama ve gönderim davranışını yeniden yazma. |
| [Badge](../../packages/ui/src/Badge.tsx), [Card](../../packages/ui/src/Card.tsx) | Mevcut tonlar ve yüzeyler; her metni rozet/kart yapma. Sponsor/durum anlamlarını gizleme. |
| [EmptyState](../../packages/ui/src/EmptyState.tsx), [ErrorNotice](../../packages/ui/src/ErrorNotice.tsx) | Gerçek boş/hata durumları. İçerik yokken sahte başarı, ürün veya sayı gösterme. |

**Kabuk istisnası:** `fullBleed`, standart dış Container'ı kaldırır ve mevcut uygulamada footer'ı `EditorialFooter` olarak değiştirir. Sadece boşluk düzeltmek için açma. Kullanılıyorsa bölüm içeriğinin yatay hizasını tek bir Container/gutter katmanı üstlenir. `chrome="chat"` yalnızca sohbet çalışma alanına aittir; kurumsal sayfa seçeneği değildir.

## 5. Sayfa türüne uygun düzeni seçme

Önce mevcut route layout'unu ve sayfanın amacını oku. Çalışan bir sayfanın kabuk modunu yalnızca görev açıkça gerektiriyorsa değiştir. Ortaklıklar sayfasının editoryal yapısı ile gizlilik sayfasının okuma yapısı aynı kalite standardını farklı düzenlerde taşır.

| Sayfa türü | Önerilen içerik akışı | Mevcut uygulama referansı |
| --- | --- | --- |
| Basit kurumsal anlatım | Sayfa başlığı → kısa giriş → anlamlı alt başlıklarla okuma bölümleri → gerekiyorsa mevcut bağlantı/eylem. Okuma genişliği ve sade hiyerarşi. | [Hakkında](../../apps/web/app/hakkinda/page.tsx); mevcut fullBleed yapısı ve yerel boşlukları evrensel şablon değildir. |
| Ortaklık / çok bölümlü editoryal sayfa | Kısa amaç → ilgili açıklama/fayda bölümleri → mevcut başvuru formu → mevcut SSS. Mevcut fullBleed kabukta bölümleri Container ile hizala. | [Ortaklıklar](../../apps/web/app/ortakliklar/page.tsx), [layout](../../apps/web/app/ortakliklar/layout.tsx), [PartnerFormClient](../../apps/web/app/ortakliklar/partner-form-client.tsx). |
| SSS | Başlık ve kısa açıklama → mevcut soru grupları/Accordion → varsa mevcut destek bağlantısı. | [SSS](../../apps/web/app/sss/page.tsx). Görünen yanıtlar ve FAQ yapılandırılmış verisi aynı içerikten gelmeye devam etmeli. |
| İletişim / geri bildirim | Başlık → kısa yönlendirme → etiketli form → gönderim/hata/başarı durumu ve mevcut iletişim bilgileri. | [İletişim](../../apps/web/app/iletisim/page.tsx), [ContactFormClient](../../apps/web/app/iletisim/contact-form-client.tsx), [FeedbackFormClient](../../apps/web/app/geri-bildirim/feedback-form-client.tsx). |
| Hukuki / uzun bilgi metni | Mevcut SubpageShell → LegalPageLayout → başlık → varsa doğrulanmış sabit tarih → açık, numaralı/başlıklı metin bölümleri ve bağlantılar. | [Gizlilik](../../apps/web/app/gizlilik/page.tsx), [Koşullar](../../apps/web/app/kosullar/page.tsx), [KVKK](../../apps/web/app/kvkk-aydinlatma/page.tsx). |
| Çerez politikası ve tercihleri | Mevcut hukuki metin düzeni içinde çalışan tercih formunu ve koşullu açıklamaları koru. | [Çerez sayfası](../../apps/web/app/cerez/page.tsx). Bu sayfa yalnızca statik politika metni değildir. |

Ortak sayfa iskeleti başlık, kısa giriş ve içerik bölümleridir; form, görsel, SSS veya çağrı yalnızca sayfanın gerçek amacına hizmet ediyorsa eklenir. Kart, renkli hero, robot, tam ekran boşluk veya yeni kayıt çağrısı zorunlu değildir. Mevcut kurumsal sayfalardaki dekoratif gölge/nokta desenlerini ve yerel sabit ölçüleri bütün sayfalara yayma.

**Hukuki içerik sınırı:**

- Mevcut metni değiştirmeden sunum üzerinde çalış. Yeni hüküm, saklama süresi, veri aktarımı açıklaması, rıza metni veya hukuki iddia üretme.
- Depodaki metni onaylı sayma: KVKK sayfasının kaynak notunda hukukçu onayının beklendiği açıkça yazıyor. Onaylı metin sağlanmamışsa bunu teslimde içerik bağımlılığı olarak belirt; boşluğu kendi yazdığın metinle doldurma.
- `lastUpdatedLabel` yalnızca doğrulanmış sabit tarihle kullanılır. Bugünün tarihini otomatik “son güncelleme” yapma.
- Uzun hukuki metnin tamamını açılır panellere gizleme. Başlıklar, listeler ve uzun bağlantılar okunur kalsın.
- [Hukuki kimlik bloğunu](../../apps/web/app/legal-identity-block.tsx) ve [site yapılandırmasını](../../apps/web/app/site-config.ts) kullan; firma/iletişim bilgisi uydurma. Çerez tercihlerinin işlevini veya rıza semantiğini görsel düzenleme kapsamında değiştirme.

## 6. Masaüstü, mobil ve erişilebilirlik

- Yeni sayfa içeriğinde [design.md](../design.md) referans eşiklerini (640/1024/1440) ve token gutter'ını izle. Mevcut HomeHeader'ın yaklaşık 360/480/900 gibi bileşen içi eşikleri korunur; bunlar yeni sayfalara yayılacak ikinci bir breakpoint sistemi değildir. Doküman/kod farkını genel bir responsive düzeltmesine dönüştürme.
- Dar ekranda çok sütunlu anlatımı tek sütuna geçir; içerik ve klavye sırasını anlamlı tut. Uzun başlıkları, Türkçe sözcükleri ve bağlantıları kırılabilir tasarla. Masaüstü görünümünü sadece küçültme.
- 320 px genişlikte sayfa genelinde yatay taşma olmamalı. Bir içerik rayı yatay kayıyorsa yalnızca o alan kaymalı; sayfanın taşmasını gizlemek için genel `overflow-x: hidden` kullanma.
- Metin, logo, Beta veya eylemi sığdırmak için ortak header'ı küçültme. Menü/avatar/tema görünürlüğünü mevcut bileşene bırak. Footer marka yazısı mobilde kesilmeden sığmalı; ortak footer'ı sayfa CSS'iyle bozma.
- Normal kurumsal ve hukuki içerikte ilk bölümü ekran yüksekliğine zorlayıp büyük boşluk üretme. Ana sayfa ve erken erişim için onaylanan ilk ekran sınırı bu sayfalara özeldir. Kısa sayfada footer'ın konumunu kabuk yönetir.
- Yeni kontrollerde `--size-touch-target` (44 px) tabanını izle. Küçük bir ikonun görünür boyutu ile dokunma alanını ayrı düşün; kontrolü komşusuyla çakıştırma. Mevcut ortak bileşen istisnalarını görev dışında yeniden tasarlama.
- Tek `h1`, mantıklı `h2`/`h3` sırası, gerçek form etiketi, anlaşılır bağlantı metni ve ikon düğmesinde erişilebilir ad kullan. Renk tek başına durum anlatmamalı.
- Klavye odağını ve SkipLink'i koru. Açılır alanlarda mevcut Accordion/native davranışı kullan; odağı kesen animasyon veya yalnızca hover ile çalışan içerik üretme.
- İki temada metin, çizgi, kontrol ve odak kontrastını kontrol et; WCAG AA tabanını koru. Sadece açık tema ekran görüntüsüne bakarak işi tamamlandı sayma.
- Görsellerin oranını/boyutunu ayır; içerik sıçraması oluşturma. Bilgi taşıyan görselin açıklaması anlamlı, salt dekorun alternatifi boş olmalı. Yeni harici görsel veya ürün ekran görüntüsü uydurma.
- Hareket mevcut tokenları ve `prefers-reduced-motion` tercihini izlemeli. Tanıtımdaki kaydırma sahnesini destek/hukuki sayfalara taşıma.

## 7. Kodlama sınırları ve kaçınılacak hatalar

- Önce mevcut çalışma ağacını incele; başkasının değişikliğini silme, geri alma veya genel formatlama içine katma. Değişiklikleri atanmış sayfanın gerekli dosyalarıyla sınırla.
- Mevcut Next.js/React yapısını ve CSS Modules kullanımını izle. Sayfa sunucu bileşeni kalabiliyorsa sadece görsel düzen için tamamını istemci bileşenine çevirme. Etkileşimde mevcut istemci bileşenlerini kullan.
- Aynı ihtiyacı karşılayan UI bileşenini kopyalama; yeni tasarım sistemi, bağımlılık, global CSS sıfırlaması veya sayfa içine gömülmüş renk kodu ekleme.
- Ortak token, navbar, footer, logo, Beta, tema ve genel font değişikliği gerekiyorsa bunu ayrı kapsam olarak raporla; yerel sayfa düzeltmesi adı altında uygulama.
- Rotaları, oturum/ürün erişimi denetimlerini, form action'larını, doğrulama kurallarını, gönderim durumlarını, rıza kontrollerini, analitik ve attribution davranışını koru. Her bağlantıya aynı takip davranışını zorlamak yerine mevcut akışın kuralını izle.
- Metin için [copy.md](../copy.md), [glossary.md](../glossary.md) ve ilgili sayfanın mevcut copy kaynağını kullan. Türkçe ve doğal cümle düzenini koru; ALL CAPS, “Satın al”, “dupe”, “ucuz” gibi yasaklı ürün ifadeleri ekleme.
- Yeni başarı iddiası, kullanıcı sayısı, mağaza/fiyat bilgisi, sosyal hesap veya çalışmayan eylem üretme. Gerçek içerik yoksa mevcut dürüst boş/bekleme durumunu koru ve eksikliği raporla.
- Görsel sadeleştirme gerekçesiyle hata/başarı mesajlarını, sponsor etiketlerini, yasal bağlantıları veya form açıklamalarını kaldırma. Kullanıcıya altyapı terimlerini gösterme.
- Mevcut metadata, canonical ve yapılandırılmış veriyi koru; görünür içerikle çelişki oluşturma. Tasarım işi kapsamında yeni hukuki veya SEO iddiaları yazma.

## 8. Teslim kontrolü ve Claude Code görev promptu

Bir sayfa işi teslim edilmeden önce:

- [ ] Değişen dosyalar görev kapsamında; mevcut çalışmalar korunmuş; ortak kabuk/token/marka izinsiz değişmemiş.
- [ ] Doğru sayfa ailesi seçilmiş; tek main/h1, doğru okuma genişliği ve tek gutter katmanı var.
- [ ] Mobil ve masaüstünde gerçek görüntü incelenmiş; en az dar mobil ve geniş masaüstüyle başlanıp 320/360/390, 768, 1024–1280, 1440 ve 1920 referanslarında ilgili kırılmalar/taşmalar kontrol edilmiş. Kontrol edilemeyen boyutlar açıkça belirtilmiş.
- [ ] Açık ve koyu tema; uzun metin, boş/hata/bekleme/başarı gibi sayfada bulunan durumlar incelenmiş. Başka sayfalara ait ilgisiz senaryolar test listesine eklenmemiş.
- [ ] Mevcut bağlantılar, klavye/odak ve açılır alanlar çalışıyor. Formun label/validation/gönderim durumları korunmuş; canlıya veri gönderen test ayrıca yetkilendirilmiş.
- [ ] Değişikliğin gerektirdiği mevcut kontroller çalıştırılmış; salt sunum işi için yeni iş mantığı testi uydurulmamış. Çalıştırılamayan kontrol ve sebebi belirtilmiş.
- [ ] Hukuki metin değişmemiş; onay durumu varsayılmamış. İçerik veya erişim bağımlılıkları teslimde yazılmış.
- [ ] Teslim, değişen alanları ve doğrulama sınırlarını kısa anlatıyor. Doğrulanmamış sayfa/işlev tamamlandı sayılmıyor; görev takip belgesi ayrıca istenmeden işaretlenmiyor.

### Yeniden kullanılabilir Claude Code promptu

```text
Görev: [sayfa/rota] için [onaylanmış frontend kapsamı].
İçerik kaynağı ve onay durumu: [dosya / sağlanan metin / bekleyen onay].

Önce CLAUDE.md, ilgili klasör talimatları, apps/web/AGENTS.md ve
docs/frontend/DESIGN-GUIDELINES.md dosyasını oku. Rehber zorunlu referanstır;
ilgili docs/design.md bölümlerini, tokens.css'i, mevcut sayfa/layout ve UI
bileşenlerini incele. Kod yazmadan ilgili kurulu Next.js belgelerini oku.

Çalışma ağacını kontrol edip mevcut değişiklikleri koru. Sayfanın amacına
uygun mevcut düzeni ve ortak bileşenleri kullan. Yeni tasarım sistemi kurma;
erken erişim/ana sayfa hero'sunu her sayfaya kopyalama. Yalnızca atanmış
kapsamı değiştir; ortak kabuk, token, marka veya işleyiş değişikliği ihtiyacını
uygulamadan raporla. Hukuki metin üretme/değiştirme veya onaylı varsayma.
Rotaları, erişim denetimlerini, form/çerez/rıza ve veri akışlarını koru.

Rehberin teslim kontrolünü uygula; mobil/masaüstü ve iki temayı incele.
Değişen alanları, yapılan kontrolleri ve eksik doğrulamaları kısa raporla.
Canlıya test mesajı/form/fotoğraf göndermek ve commit, push, PR veya deploy
yapmak için görevde ayrıca açık yetki bulunmalı. Teslimden sonra dur.
```
