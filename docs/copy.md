# Metin bankası

Kullanıcıya görünen tüm metinler burada. Aynı eylem her yerde aynı isimle
anılır. Yeni metin eklenecekse önce bu dosyaya yazılır.

Kurallar `design.md` içinde: cümle düzeni, ALL CAPS yok, "satın al" yok,
"dupe" yok, "ucuz" yerine "daha uygun fiyatlı".

## Ana sayfa

| Anahtar | Metin |
| --- | --- |
| `home.tagline` | Bir ürün bul, aynısını veya benzerini farklı mağazalarda karşılaştır. |
| `home.hero_title_lead` | Alışveriş mi? (başlık aynı alanda "Manicepte." ile dönüşümlü; ~1,6 sn / ~2 sn) |
| `home.hero_title_accent` | Manicepte. |
| `home.hero_subline` | Ne aradığını anlat veya görselini yükle. |
| `home.search_ideas_title` | Arama fikirleri |
| `home.trends_title` | Trendler |
| `home.trends_subtitle` | Arilla'da öne çıkan stiller ve ürün fikirleri. |
| `home.discovery_title` | Arilla'da keşfedilenler |
| `home.discovery_subtitle` | Farklı kategorilerden öne çıkan ürünler, tek bakışta. |

## Nasıl çalışır

| Anahtar | Metin |
| --- | --- |
| `home.how_it_works_title` | Arilla nasıl çalışır? |
| `home.how_it_works_subtitle` | Ürünü tarif et veya fotoğrafını yükle. Arilla aynı ve benzer seçenekleri farklı mağazalarda karşılaştırmana yardımcı olur. |
| `home.how_it_works_text_search_title` | Metinle ara |
| `home.how_it_works_text_search_description` | Ürün adını, markayı ya da kısa bir tarifle ara. Arilla fiyat aralığı ve kategori gibi ayrıntıları anlar. |
| `home.how_it_works_photo_search_title` | Fotoğrafla ara |
| `home.how_it_works_photo_search_description` | Ürünün fotoğrafını yükle, Arilla aynı veya benzer seçenekleri bulsun. Fotoğrafın sistemde kalıcı olarak saklanmaz. |
| `home.how_it_works_link_search_title` | Bağlantıyla bul |
| `home.how_it_works_link_search_description` | Beğendiğin bir ürünün bağlantısını paylaşarak arama. |
| `home.how_it_works_link_search_status` | Yakında |
| `home.how_it_works_outcome` | Hangi yolu seçersen seç, sonuçlarda aynı ve benzer ürünleri inceleyebilir, farklı mağaza tekliflerini ve stok durumunu karşılaştırabilirsin. |

## Şeffaflık (Faz 5)

Bu bölüm sosyal kanıt değildir - doğrulanmamış sayı/istatistik içermez
(bkz. docs/design.md, görev talimatı). Affiliate ve fiyat/stok metinleri
`legal.*` anahtarlarıyla AYNI, tekrar yazılmaz.

| Anahtar | Metin |
| --- | --- |
| `home.trust_title` | Karar vermene nasıl yardımcı oluyoruz |
| `home.trust_point_alternatives` | Aynı ürünü veya görsel ve metin olarak benzer alternatiflerini bulursun. |
| `home.trust_point_compare` | Farklı mağazalardaki teklifleri kargo dahil toplam fiyata ve stok durumuna göre karşılaştırırsın. |
| `home.trust_point_freshness` | Fiyat ve stok bilgisi doğrudan mağaza kaynaklarından gelir, güncellenme zamanıyla birlikte gösterilir. |
| `home.trust_point_commission` | Bazı mağaza bağlantılarından komisyon kazanabiliriz. Bu, gösterilen fiyatı değiştirmez; sıralamada komisyon belirleyici değildir. |
| `home.trust_point_alternatives_title` | Aynı ve benzer ürünler |
| `home.trust_point_compare_title` | Mağazaları karşılaştır |
| `home.trust_point_freshness_title` | Kaynağı ve zamanı belli |
| `home.trust_point_commission_title` | Açık komisyon bildirimi |

`home.trust_point_commission` altbilgideki `legal.affiliate_notice`'in tekrarı
değil, sıralama ilkesinin açıklamasıdır (CLAUDE.md: komisyon sıralamada
belirleyici değildir; bugünkü sıralama kodu komisyonu hiç kullanmıyor).

## Altbilgi (Faz 5-6)

| Anahtar | Metin |
| --- | --- |
| `footer.product_group_title` | Ürün |
| `footer.account_group_title` | Hesap |
| `footer.legal_group_title` | Yasal |
| `footer.last_updated_prefix` | Son güncelleme: |

## Gezinme

| Anahtar | Metin |
| --- | --- |
| `nav.trends` | Trendler |
| `nav.discover` | Keşfet |
| `nav.how_it_works` | Nasıl Çalışır |
| `nav.account` | Hesabım |
| `nav.deals` | Fırsatlar |
| `nav.saved` | Kaydettiklerim |
| `nav.alerts` | Alarmlarım |
| `nav.history` | Geçmişim |
| `nav.privacy` | Gizlilik |
| `nav.terms` | Kullanım Koşulları |
| `nav.cookies` | Çerez Politikası |
| `nav.kvkk` | KVKK Aydınlatma |
| `nav.affiliate` | Affiliate Açıklaması |
| `nav.company` | Şirket Bilgileri |
| `nav.cookie_preferences` | Çerez Tercihleri |
| `nav.contact` | İletişim |
| `nav.feedback` | Geri bildirim |
| `nav.skip_to_content` | İçeriğe geç |

## İletişim (karar 0061)

İletişim formu `/geri-bildirim` ile aynı yazma yolunu kullanır. Metinler
`apps/web/app/iletisim/contact-copy.ts`; hitap "siz". E-posta adresi metin
değil yapılandırmadır: tek kaynağı `apps/web/app/site-config.ts`
(`PUBLIC_CONTACT_EMAIL`). Telefon, adres, unvan, çalışma saati bilerek yok.

| Anahtar | Metin |
| --- | --- |
| `contact.title` | İletişim |
| `contact.description` | Sorunuzu, talebinizi veya bildirmek istediğiniz bir hatayı aşağıdaki formla iletebilirsiniz. Gerekirse bıraktığınız e-posta adresinden size dönüş yaparız. |
| `contact.faq_prompt` | Yanıtını aradığınız soru |
| `contact.faq_link` | Sıkça sorulan sorular |
| `contact.faq_prompt_end` | sayfasında olabilir. |
| `contact.name_label` | Adınız |
| `contact.email_label` | E-posta |
| `contact.email_hint` | Size dönüş yapmamız gerekirse bu adresi kullanırız. |
| `contact.category_label` | Konu |
| `contact.subject_label` | Başlık |
| `contact.subject_placeholder` | Ürün sayfasında fiyat farklı görünüyor |
| `contact.message_label` | Mesajınız |
| `contact.message_hint` | Ürün adı veya sayfa bağlantısı eklemeniz incelememizi kolaylaştırır. |
| `contact.auth_notice` | Giriş yaptığınız için mesajınız hesabınızla ilişkilendirilecektir. |
| `contact.privacy_note` | Bilgilerinizi yalnızca talebinizi yanıtlamak için kullanırız. Ayrıntılar |
| `contact.privacy_link` | Gizlilik Politikası |
| `contact.privacy_and` | ve |
| `contact.kvkk_link` | KVKK Aydınlatma Metni |
| `contact.privacy_note_end` | içinde. |
| `contact.email_alternative` | Dilerseniz doğrudan e-posta da gönderebilirsiniz: |
| `contact.submit` | Mesajı gönder |
| `contact.submitting` | Gönderiliyor… |
| `contact.success_title` | Mesajınız bize ulaştı. |
| `contact.success_body` | Mesajınızı inceleyeceğiz; gerekirse bıraktığınız e-posta adresinden size dönüş yaparız. |
| `contact.success_another` | Yeni mesaj gönder |
| `contact.error_name_required` | Adınızı yazın. |
| `contact.error_name_length` | Ad 2 ile 100 karakter arasında olmalı. |
| `contact.error_email_required` | Yanıt verebilmemiz için e-posta adresinizi yazın. |
| `contact.error_email` | Geçerli bir e-posta adresi girin. |
| `contact.error_category` | Bir konu seçin. |
| `contact.error_subject_required` | Bir başlık yazın. |
| `contact.error_subject_length` | Başlık 3 ile 120 karakter arasında olmalı. |
| `contact.error_message_required` | Mesajınızı yazın. |
| `contact.error_message_length` | Mesaj 10 ile 5000 karakter arasında olmalı. |
| `contact.error_fix_fields` | Lütfen işaretli alanları düzeltin. |
| `contact.error_malformed` | Form gönderilemedi. Sayfayı yenileyip tekrar deneyin. |
| `contact.error_too_large` | Mesajınız çok uzun. Lütfen kısaltıp tekrar deneyin. |
| `contact.error_rate_limited` | Kısa sürede çok fazla mesaj gönderdiniz. Birkaç dakika sonra tekrar deneyin. |
| `contact.error_unavailable` | Mesajınızı şu an kaydedemedik. Biraz sonra tekrar deneyin ya da e-posta gönderin. |
| `contact.error_network` | Bağlantı kurulamadı. İnternet bağlantınızı kontrol edip tekrar deneyin. |
| `contact.error_session_expired` | Oturumunuz sona ermiş. Mesajınızın hesabınızla ilişkilendirilmesi için tekrar giriş yapın. |
| `contact.login_again` | Tekrar giriş yap |
| `privacy.contact_prefix` | Verilerinle ilgili soruların için |
| `privacy.contact_suffix` | adresine yazabilirsin. |

Konu etiketleri (`CONTACT_CATEGORY_LABELS`, değer `feedback.category`):

| Değer | Etiket |
| --- | --- |
| `general` | Genel soru |
| `account` | Hesap ve giriş |
| `price_error` | Yanlış fiyat veya ürün bilgisi |
| `bug` | Teknik sorun |
| `partnership` | Mağaza ve iş birliği |
| `privacy` | Gizlilik ve KVKK talebi |
| `other` | Diğer |

## SSS (karar 0061)

Soru ve yanıtların TEK kaynağı `apps/web/app/sss/faq-content.ts`; burada
tekrarlanmaz (iki kopya ayrışır). Sayfa metinleri `apps/web/app/sss/faq-page-copy.ts`.
Yanıtlarda "satın al", "dupe", "ucuz" geçmez; sayı veren ayarlanabilir
sınırlar (ücretsiz arama sayısı vb.) yazılmaz.

| Anahtar | Metin |
| --- | --- |
| `nav.faq` | Sıkça sorulan sorular |
| `faq.meta_title` | Sıkça sorulan sorular |
| `faq.meta_description` | ManiCepte nasıl çalışır, fiyatlar ne kadar güncel, hesap gerekir mi, verileriniz nasıl kullanılır? Sık sorulan soruların yanıtları. |
| `faq.title` | Sıkça sorulan sorular |
| `faq.description` | Merak ettiğiniz bir konunun yanıtı büyük olasılıkla burada. |
| `faq.more_title` | Sorunuzun yanıtını bulamadınız mı? |
| `faq.more_body` | Bize yazın; mesajınızı inceleyip gerekirse e-posta ile size dönüş yapalım. |
| `faq.more_action` | İletişime geçin |

## Eylemler

| Anahtar | Metin |
| --- | --- |
| `action.search` | Ara |
| `action.upload_photo` | Fotoğraf yükle |
| `action.paste_link` | Link yapıştır |
| `action.open_at_merchant` | {mağaza}'da aç |
| `action.save` | Kaydet |
| `action.saved` | Kaydedildi |
| `action.create_alert` | Fiyat alarmı kur |
| `action.find_cheaper` | Daha uygununu bul |
| `action.follow` | Takip et |
| `action.following` | Takip ediliyor |
| `action.login` | Giriş yap |
| `action.close` | Kapat |
| `action.send_link` | Bağlantı gönder |
| `action.retry` | Tekrar dene |
| `action.clear_history` | Geçmişi sil |
| `action.delete_account` | Hesabı sil |
| `action.sign_out` | Çıkış yap |

## Arama

| Anahtar | Metin |
| --- | --- |
| `search.placeholder` | Manicepte’ye sor... |
| `search.placeholder_results` | Ürün adı, marka ya da kısa bir tarif yaz |
| `search.input_label` | Ürün ara |
| `search.title_empty_query` | Ne arıyorsun? |
| `search.title` | “{q}” için sonuçlar |
| `search.empty_query` | Aramak için aşağıya bir şey yaz ya da fotoğraf yükle. |
| `search.result_count` | {n} sonuç (binlik ayraçlı) |
| `search.loading_results` | Sonuçlar yükleniyor (yalnızca ekran okuyucu) |
| `search.tab_match_unavailable` | Bu arama için kullanılamıyor |
| `search.pagination_label` | Sayfalama |
| `search.page_status` | Sayfa {n} / {total} |
| `search.page_previous_label` | Önceki sayfa |
| `search.page_next_label` | Sonraki sayfa |
| `search.retry` | Tekrar dene |
| `search.offer_count` | {n} mağaza |
| `search.tab_balanced` | Bizim seçtiklerimiz |
| `search.tab_deals` | En iyi fırsatlar |
| `search.tab_match` | En yakın eşleşmeler |
| `search.clarify_intro` | Hangisini arıyorsun? |
| `search.clarify_other` | Başka bir şey |
| `search.clarify_other_placeholder` | Ne arıyorsun? |
| `search.loading` | Benzerlerini arıyoruz |
| `rights.summary` | Bugün kalan {kalan}/{limit} · Bonus {bonus} (fotoğraf ve link araması; 0047). Rozet etiketi: "Fotoğraf ve link araması: …"; link araması kapalıyken (`LINK_SEARCH_PUBLIC = false`) "Fotoğraf araması: …" |
| `rights.reset` | Günlük hakların {saat}'da yenilenir. |
| `rights.no_rights` | Bugünkü arama hakların ve bonus hakların bitti. Hakların gece 00:00'da yenilenir. |
| `rights.earn_link` | Bonus hak kazanmanın yolları |
| `rights.rate_limited` | Biraz hızlı gittin. Bir dakika sonra tekrar dener misin? |
| `rights.busy` | Önceki araman hâlâ sürüyor. Bitince yenisini başlatabilirsin. |
| `rights.section_title` | Arama hakların |
| `search.empty` | Bu aramada sonuç bulamadık. |
| `search.empty_hint` | Daha genel bir arama dene: fiyat, renk ya da beden gibi ayrıntıları çıkarabilir veya farklı kelimeler kullanabilirsin. |
| `search.empty_nearest` | Sana en yakın bulduklarımız |
| `search.page_previous` | Önceki |
| `search.page_next` | Sonraki |
| `search.error` | Arama şu an çalışmıyor. |
| `search.error_body` | Birazdan tekrar dener misin? |
| `visual_search.title` | Fotoğrafına benzeyen ürünler |
| `visual_search.empty` | Bu fotoğrafa benzeyen ürün bulamadık. |
| `visual_search.empty_hint` | Ürünün tek başına ve net göründüğü başka bir fotoğraf dene ya da ürünün adını yazarak ara. |
| `visual_search.new_search` | Yeni bir arama yap |

## Link öneki

| Anahtar | Metin |
| --- | --- |
| `link.resolving` | Bu ürünü arıyoruz, birazdan hazır olur. |
| `link.not_found` | Bu bağlantıyı çözemedik. Ürünü mağazada açabilirsin. |
| `link.open_original` | Orijinal bağlantıyı aç |

## Ürün

| Anahtar | Metin |
| --- | --- |
| `product.saving` | {tutar} tasarruf |
| `product.price_lowest_90d` | Son 90 günün en düşük fiyatı |
| `product.price_dropped_count` | Son 3 ayda {n} kez daha uygun fiyatlıydı |
| `product.list_price_note` | Liste fiyatı {gün} gün önce {tutar} idi. |
| `product.updated_at` | {süre} önce güncellendi |
| `product.out_of_stock` | Şu an stokta yok |
| `product.your_size` | Senin bedenin |
| `product.size_unavailable` | Bu beden şu an yok |
| `product.other_colors` | Diğer renkler |
| `product.alternatives` | Daha uygun fiyatlı alternatifler |
| `product.shipping_included` | Kargo dahil {tutar} |
| `product.free_shipping` | Kargo bedava |
| `product.merchant_error` | Bu mağazadan fiyat alamadık. Ürünü mağazada açabilirsin. |
| `product.offer_count_suffix` | mağaza (ör. "3 mağaza") |
| `product.sr_list_price` | Liste fiyatı (yalnızca ekran okuyucu) |
| `product.sr_current_price` | En uygun teklif (yalnızca ekran okuyucu) |
| `product.no_offers` | Şu an bu ürün için mağaza fiyatı yok. |
| `product.compare_offers_link` | {n} mağazanın fiyatını karşılaştır |
| `product.offers_title` | Mağaza fiyatları |
| `product.offers_sorted_note` | Fiyatlar kargo dahil toplamdır, en uygundan sıralanır. |
| `product.shipping_cost` | {tutar} kargo |
| `product.in_stock` | Stokta |
| `product.best_offer` | En uygun fiyat |
| `product.starting_price` | Başlangıç fiyatı |
| `product.variant_label` | Boyut |
| `product.variant_choose_hint` | Fiyat boyut seçimine göre değişir. Karşılaştırmak için bir seçenek seç. |
| `product.variant_missing` | Seçtiğin boyut şu an hiçbir mağazada yok. Başka bir seçenek dene. |
| `product.variant_from` | {fiyat}'den |
| `product.best_offer_for_variant` | En uygun teklif, {varyant} |
| `product.unit_price` | 100 ml: {fiyat} (tamamlayıcı; mağaza fiyatının yerine geçmez) |
| `product.variant_unknown` | Boyutu belirtilmemiş |
| `product.offers_for_variant` | Mağaza fiyatları, {varyant} |
| `product.offers_sorted_variant_note` | Fiyatlar kargo dahil toplamdır, yalnızca bu seçenek için en uygundan sıralanır. |
| `product.offers_grouped_note` | Fiyatlar seçeneğe göre gruplanır; farklı boyutlar birbirinin daha uygun alternatifi değildir. |
| `product.card_price_from` | {fiyat}'den başlayan (yalnızca varyantları farklı fiyatlı ürünlerde) |
| `product.variant_history_unavailable` | {varyant} için henüz yeterli fiyat geçmişi yok. |
| `product.variant_history_needs_selection` | Fiyat geçmişi, bir boyut seçildiğinde yalnızca o boyut için gösterilir. |
| `product.variant_history_coverage` | Geçmiş, bu boyutu satan {toplam} mağazanın {katılan} tanesinin verisini içeriyor. |
| `product.variant_restock` | Stok gelince haber ver |
| `product.variant_restock_created` | {varyant} stoğa gelince haber vereceğiz. |
| `product.variant_restock_unavailable` | Bu seçenek hiçbir mağazada listelenmediği için stok alarmı kurulamaz. |
| `product.size_label` | Beden |
| `product.color_fallback` | Renk {n} |
| `product.price_history_title` | Fiyat geçmişi |
| `product.price_chart_toggle` | Fiyat grafiği |
| `product.price_range_90d` | Son 90 günde {min} ile {max} arasında değişti. |
| `product.price_flat_90d` | Son 90 günde fiyat {tutar} olarak kaldı. |

Çıkış eylemi "{Mağaza}'da aç" ünlü uyumuyla yazılır ('da/'de/'ta/'te):
`packages/ui/src/locative.ts` `withLocativeSuffix`.

## Fırsatlar

| Anahtar | Metin |
| --- | --- |
| `deals.title` | Fırsatlar |
| `deals.lead` | Fiyatı son günlerde düşen ürünler. Düşüş, ürünün son 90 gündeki olağan fiyatına göre hesaplanır. |
| `deals.list_label` | Fiyatı düşen ürünler |
| `deals.empty_title` | Şu an öne çıkan bir fırsat yok. |
| `deals.empty_body` | Fiyatı gerçekten düşen ürünler her gün yeniden belirlenir. Bu arada aradığın ürünü arayabilir veya keşfedilen ürünlere göz atabilirsin. |
| `deals.empty_search_action` | Ürün ara |
| `deals.savings_percent` | %{n} daha uygun |
| `deals.savings_amount` | {tutar} tasarruf |

## Keşfet

| Anahtar | Metin |
| --- | --- |
| `discover.description` | Farklı kategorilerden bugün öne çıkan ürünler. |
| `discover.curated_title` | Bugün öne çıkanlar |
| `discover.organic_title` | Kullanıcıların bulduğu |

## Giriş

| Anahtar | Metin |
| --- | --- |
| `auth.modal_title` | Sonuçlarını kaydedelim mi? |
| `auth.modal_body` | Hesabın yok mu? Ücretsiz kaydol, bu sonuçları senin için saklayalım. |
| `auth.email_label` | E-posta adresin |
| `auth.link_sent_title` | Bağlantıyı gönderdik |
| `auth.link_sent_body` | E-postana bir giriş bağlantısı gönderdik. Bağlantı 15 dakika geçerli. |
| `auth.rate_limited` | Az önce bir bağlantı gönderdik. Birkaç dakika sonra tekrar dene. |
| `auth.token_expired` | Bu bağlantının süresi dolmuş. Google ya da Apple ile giriş yapabilirsin. |
| `auth.token_used` | Bu bağlantı zaten kullanılmış. |
| `auth.google_failed` | Google ile giriş şu an tamamlanamadı. Apple ile devam edebilir ya da biraz sonra tekrar deneyebilirsin. |
| `auth.apple_failed` | Apple ile giriş şu an tamamlanamadı. Google ile devam edebilir ya da biraz sonra tekrar deneyebilirsin. |
| `auth.confirm_title` | Girişi tamamla |
| `auth.confirm_body` | Giriş yapmak için aşağıdaki düğmeye bas. Bağlantı yalnızca bir kez kullanılabilir. |
| `auth.login_title` | Giriş yap |
| `auth.login_intro` | E-posta adresini yaz, sana tek kullanımlık bir giriş bağlantısı gönderelim. Şifre gerekmez. |
| `auth.submit` | Bağlantı gönder |
| `auth.submitting` | Gönderiliyor… |
| `auth.link_sent_hint` | Birkaç dakika içinde gelmezse gereksiz klasörüne de göz at. |
| `auth.invalid_email` | Geçerli bir e-posta adresi gir. |
| `auth.send_failed` | Bağlantıyı şu an gönderemedik. Biraz sonra tekrar dene. |
| `auth.provider_unavailable` | şu an kullanılamıyor |
| `auth.phone_unavailable` | Telefonla giriş şu an kullanılamıyor. Başka bir yöntemle devam edebilirsin. |
| `auth.phone_country_unsupported` | Şu an yalnızca Türkiye (+90) numaralarıyla giriş yapılabiliyor. |

`auth.rate_limited` mesajı hesabın var olup olmadığını belli etmez; her iki
durumda da aynı metin gösterilir.

Giriş ekranları (`/giris`, `/yonetim/giris`) yalnızca Google ve Apple gösterir.
E-posta bağlantısı ve telefon metinleri, backend'leri yeniden açılabilsin diye
burada kalır.

## Erken erişim

Lansman öncesi ürün kapalıyken (`PRODUCT_ACCESS` açık değil) ana sayfa,
giriş ekranı, üst çubuk ve `/erken-erisim` bu metinleri kullanır.

| Anahtar | Metin |
| --- | --- |
| `early_access.cta` | Erken erişime katıl |
| `early_access.progress_label` | Erken erişim listesindeki kişi |
| `early_access.progress_unit` | kişi |
| `early_access.progress_value_text` | {target} kişilik hedefin {count} kişisi tamamlandı |
| `early_access.landing_note` | ManiCepte şu an erken erişimde. Listeye katıl, açıldığında haber verelim. |
| `early_access.login_title` | Erken erişime katıl. Hesabınla devam et ya da yeni hesap aç. |
| `early_access.nav_status` | Erken erişim |
| `early_access.joined_title` | Listedesin. |
| `early_access.joined_body` | Erken erişim listesine katıldın. ManiCepte açıldığında haber vereceğiz. |
| `early_access.returning_title` | Erken erişim listesindesin. |
| `early_access.returning_body` | ManiCepte açıldığında haber vereceğiz. O zamana kadar yapman gereken bir şey yok. |
| `early_access.not_yet_open` | ManiCepte henüz kullanıma açık değil. Açıldığında aynı hesapla devam edebileceksin. |
| `early_access.joined_on` | Katılım tarihi: {tarih} |
| `early_access.in_list` | Erken erişim listesindesin. |
| `early_access.view_status` | Durumunu gör |
| `early_access.join_title` | Erken erişim listesine katıl |
| `early_access.join_body` | Listeye katıl, ManiCepte açıldığında haber verelim. |
| `early_access.join_submit` | Listeye katıl |
| `early_access.back_home` | Ana sayfaya dön |
| `admin.early_access.title` | Erken erişim |
| `admin.early_access.note` | Listeye katılan hesaplar. Yalnızca hesap kimliği gösterilir; ayrıntı için kimliği yukarıdaki aramaya yapıştır. |
| `admin.early_access.empty` | Henüz listeye katılan yok. |

`joined_*` katılımdan sonraki ilk dakikalarda, `returning_*` daha sonra
dönen kullanıcıya gösterilir (`apps/web/app/erken-erisim/state.ts`).

## Lansman öncesi landing

Karar 0043. Ürün kapalıyken ana sayfa. Gelecek zaman bilerek kullanılır:
hizmet henüz açık değildir. Sahte ürün, fiyat, tasarruf, sayı, yorum ya da
tarih yok. Metinler `apps/web/app/coming-soon-copy.ts`'te; marka adı
`SITE_BRAND`'den gelir.

| Anahtar | Metin |
| --- | --- |
| `coming_soon.eyebrow` | Erken Erişim |
| `coming_soon.status` | ManiCepte yakında. |
| `coming_soon.headline` | Aradığın ürünü bul. Fiyatları karşılaştır. Daha akıllı alışveriş yap. |
| `coming_soon.body` | ManiCepte, aradığın ürünü, alternatiflerini ve farklı mağazalardaki fiyatlarını tek yerde görmeni kolaylaştırmak için yapay zekâ destekli bir alışveriş asistanı olarak geliştiriliyor. |
| `coming_soon.cta_note` | Hesabınla devam et ya da yeni hesap aç; listeye otomatik eklenirsin. |
| `coming_soon.how_it_works_anchor` | Nasıl çalışacak? |
| `coming_soon.benefits_title` | ManiCepte ile neler yapabileceksin? |
| `coming_soon.benefit_describe_title` | Ne aradığını anlatarak bul |
| `coming_soon.benefit_describe_body` | Ürünün adını bilmen gerekmeyecek. Aklındakini kendi cümlelerinle anlatabilecek, bir fotoğraf ya da ürün bağlantısıyla başlayabileceksin. |
| `coming_soon.benefit_compare_title` | Fiyatları karşılaştır |
| `coming_soon.benefit_compare_body` | Aynı ürünün farklı mağazalardaki tekliflerini yan yana görüp karar vermeden önce seçenekleri tartabileceksin. |
| `coming_soon.benefit_alternatives_title` | Alternatifleri keşfet |
| `coming_soon.benefit_alternatives_body` | Beğendiğin ürüne benzeyen, farklı bütçelere uygun seçenekleri tek yerde inceleyebileceksin. |
| `coming_soon.how_it_works_title` | Nasıl çalışacak? |
| `coming_soon.how_it_works_body` | ManiCepte henüz kullanıma açık değil. Açıldığında her şey üç adımda olacak. |
| `coming_soon.step_start_title` | Ara, fotoğraf yükle veya ürün bağlantısı paylaş |
| `coming_soon.step_start_body` | Elinde ne varsa onunla başla: kısa bir tarif, bir fotoğraf ya da beğendiğin ürünün bağlantısı. |
| `coming_soon.step_analyze_title` | ManiCepte seçenekleri analiz etsin |
| `coming_soon.step_analyze_body` | Aynı ürünü ve ona benzeyen seçenekleri farklı mağazalarda bulup senin için düzenler. |
| `coming_soon.step_compare_title` | Ürünleri, alternatifleri ve fiyatları karşılaştır |
| `coming_soon.step_compare_body` | Seçenekleri yan yana gör; sana en uygun olanı sen seç. |
| `coming_soon.build_title` | ManiCepte'yi geliştiriyoruz. |
| `coming_soon.build_body` | Ürünü adım adım inşa ediyoruz. Şu an üzerinde çalıştıklarımız: |
| `coming_soon.build_status_done` | Tamamlandı |
| `coming_soon.build_status_in_progress` | Geliştiriliyor |
| `coming_soon.build_item_early_access` | Erken erişim sistemi |
| `coming_soon.build_item_search` | Arama deneyimi |
| `coming_soon.build_item_discovery` | Ürün keşfi ve karşılaştırma |
| `coming_soon.build_item_data` | Mağaza ve fiyat altyapısı |
| `coming_soon.build_updated` | Son güncelleme: {ay} |
| `coming_soon.follow_title` | Gelişmeleri takip et |
| `coming_soon.closing_title` | Açıldığında ilk sen haberdar ol. |
| `coming_soon.closing_body` | Erken erişim listesine katıl; hazır olduğumuzda sana haber verelim. |
| `coming_soon.admin_login` | Admin Girişi |
| `coming_soon.admin_login_title` | Hesabınla giriş yap. |
| `coming_soon.footer_description` | ManiCepte yakında: aradığın ürünü bul, alternatiflerini keşfet, fiyatları karşılaştır. |
| `coming_soon.meta_title` | ManiCepte – Yakında |
| `coming_soon.meta_description` | ManiCepte yakında: aradığın ürünü bul, alternatiflerini keşfet ve farklı mağazalardaki fiyatları karşılaştır. Erken erişim listesine katıl. |
| `error.not_found_body_closed` | Bağlantı değişmiş ya da taşınmış olabilir. |

## Boş durumlar

| Anahtar | Metin |
| --- | --- |
| `empty.saved` | Henüz kaydettiğin ürün yok. Beğendiğin bir ürünü kaydet, ucuzlayınca haber verelim. |
| `empty.alerts` | Alarmın yok. Bir ürünün fiyatı düşünce ya da bedenin gelince haber verelim. |
| `empty.history` | Henüz gezindiğin ürün yok. |
| `empty.creator_visitor` | Bu vitrin hazırlanıyor. |
| `empty.creator_owner` | İlk koleksiyonunu oluştur ve beğendiğin ürünleri ekle. |
| `empty.discovery` | Bugünlük içerik hazırlanıyor. |
| `empty.discovery_description` | Bu sırada aradığın ürünü yazarak ya da fotoğrafını yükleyerek başlayabilirsin. |
| `empty.discovery_action` | Aramaya başla |

## Alarm ve e-posta

| Anahtar | Metin |
| --- | --- |
| `alert.price_created` | {tutar} altına düşünce haber vereceğiz. |
| `alert.restock_created` | Stoğa girince haber vereceğiz. |
| `alert.size_created` | {beden} bedeni gelince haber vereceğiz. |
| `email.login_subject` | Giriş bağlantın |
| `email.price_drop_subject` | {ürün} ucuzladı |
| `email.restock_subject` | {ürün} yeniden stokta |
| `email.weekly_subject` | Kaydettiklerinden {n} tanesi ucuzladı |
| `email.unsubscribe` | Bu bildirimleri almak istemiyorsan buradan kapatabilirsin. |
| `email.marketing_reason` | Bu e-postayı, {marka} hesabında kampanya ve fırsat e-postalarına izin verdiğin için aldın. |
| `email.marketing_manage` | İzinlerini hesabından da yönetebilirsin. |
| `email.marketing_test_notice` | Bu bir test iletisidir. Gerçek alıcılara gönderilmedi; abonelikten çıkma bağlantısı test iletisinde çalışmaz. |
| `unsubscribe.title` | E-posta aboneliği |
| `unsubscribe.body` | Kampanya ve fırsat e-postalarını artık almak istemiyorsan aşağıdaki düğmeye bas. |
| `unsubscribe.submit` | Abonelikten çık |
| `unsubscribe.done_title` | Abonelikten çıktın |
| `unsubscribe.done_body` | Artık kampanya ve fırsat e-postası almayacaksın. Giriş bağlantısı ve kurduğun fiyat alarmları gibi hesap iletileri gelmeye devam eder. |
| `unsubscribe.invalid_title` | Bağlantı geçersiz |
| `unsubscribe.invalid_body` | Bu bağlantı geçersiz ya da artık kullanılamıyor. Test iletilerindeki bağlantı da çalışmaz. |

Giriş, fiyat alarmı ve stok bildirimi **işlemsel iletidir.** Haftalık özet ve
yönetimden gönderilen e-posta kampanyaları **ticari iletidir** ve ayrı izin
gerektirir (`kvkk.md`, karar 0048). Ticari iletinin altbilgisi
(`email.marketing_reason`, `email.unsubscribe`, `email.marketing_manage`)
yönetici tarafından değiştirilemez.

## Yönetim

Rol gerektiren `/yonetim/*` ekranları için. Erişim `requireCapability(<yetenek>)`
ile her sayfa ve server action'da ayrı ayrı zorlanır (`app/lib/dal.ts`); core
mutasyonu aynı yeteneği tekrar denetler (docs/decisions/0039).

| Anahtar | Metin |
| --- | --- |
| `admin.login.title` | Yönetim girişi |
| `admin.login.intro` | Yönetim paneline yetkili hesabınla giriş yap. Yönetim oturumu en fazla 12 saat sürer. |
| `admin.login.no_access` | Bu hesabın yönetim yetkisi yok. Yetkili bir hesapla giriş yap. |
| `admin.login.expired` | Yönetim oturumun 12 saati doldurdu. Güvenlik için yeniden giriş yap. |
| `admin.login.idle` | 30 dakikadır işlem yapılmadığı için yönetim oturumun kapandı. Yeniden giriş yap. |
| `admin.login.reauth` | Bu işlem için yakın zamanda giriş yapmış olman gerekiyor. Yeniden giriş yap. |
| `admin.login.back` | Siteye dön |
| `admin.reauth_link` | Yeniden giriş yap |
| `admin.matching.title` | Eşleştirme kuyruğu |
| `admin.matching.queue_count` | Kuyrukta {n} eşleştirme bekliyor |
| `admin.matching.offer_label` | Mağaza teklifi |
| `admin.matching.product_label` | Kayıtlı ürün |
| `admin.matching.approve` | Onayla |
| `admin.matching.reject` | Reddet |
| `admin.matching.skip` | Atla |
| `admin.matching.shortcuts` | Kısayollar: A onayla, R reddet, S atla |
| `admin.matching.empty` | Kuyruk boş. |
| `admin.matching.batch_done` | Bu grup bitti. Yeni bir grup için sayfayı yenile. |
| `admin.matching.reload` | Yenile |
| `admin.lexicon.title` | Sözlük |
| `admin.lexicon.add` | Yeni satır ekle |
| `admin.lexicon.save` | Kaydet |
| `admin.lexicon.cancel` | Vazgeç |
| `admin.lexicon.edit` | Düzenle |
| `admin.lexicon.filter` | Filtrele |
| `admin.lexicon.clear_filter` | Temizle |
| `admin.lexicon.field_kind` | Tür |
| `admin.lexicon.field_surface` | Yüzey |
| `admin.lexicon.field_normalized` | Normalize |
| `admin.lexicon.field_weight` | Ağırlık |
| `admin.lexicon.search_placeholder` | Ara |
| `admin.lexicon.kind_all` | Tümü |
| `admin.lexicon.empty` | Sözlükte satır yok. |
| `admin.lexicon.tier3_heading` | Son 7 günde kademe 3'e düşen sorgular |
| `admin.lexicon.tier3_empty` | Şu an aday yok. Kademe 3 (model) henüz devrede değil; o zamana kadar bu liste boş kalır. |
| `admin.lexicon.intro` | Kaydedilen değişiklik aramayı hemen etkiler ve denetim kaydına yazılır. |
| `admin.lexicon.delete` | Sil |
| `admin.lexicon.delete_title` | Satırı sil |
| `admin.lexicon.delete_body` | "{yüzey}" ({tür}) sözlükten silinecek. Arama hemen etkilenir; silinen değer denetim kaydında kalır. |
| `admin.lexicon.duplicate` | Bu tür ve yüzeyle başka bir satır zaten var. |
| `admin.lexicon.not_found` | Satır bulunamadı; başka bir yerde silinmiş olabilir. Sayfayı yenile. |
| `admin.lexicon.save_failed` | Kaydedilemedi. Tekrar dene. |
| `admin.lexicon.prev_page` | Önceki |
| `admin.lexicon.next_page` | Sonraki |
| `admin.matching.conflict` | Bu teklif bu arada başka bir ürüne bağlanmış. Reddedebilir ya da atlayabilirsin. |
| `admin.matching.already_decided` | Bu satır başka bir yerde zaten karara bağlanmış. |
| `admin.matching.save_failed` | Karar kaydedilemedi. Tekrar dene. |
| `admin.shell.title` | Arilla yönetim |
| `admin.shell.back_to_site` | Siteye dön |
| `admin.shell.nav_overview` | Genel bakış |
| `admin.shell.nav_audit` | Denetim kaydı |
| `admin.confirm.cancel` | Vazgeç |
| `admin.overview.title` | Genel bakış |
| `admin.overview.no_search_metrics` | Arama sayısı ve sonuçsuz arama oranı burada yok: arama günlüğü henüz tutulmuyor. |
| `admin.overview.attention_heading` | Dikkat gerektiren mağazalar |
| `admin.overview.attention_empty` | Son koşusu başarısız ya da kısmi biten mağaza yok. |
| `admin.audit.title` | Denetim kaydı |
| `admin.audit.intro` | Yönetim ekranlarındaki her değişiklik burada, değiştirilemez olarak tutulur. Yeniden eskiye. |
| `admin.audit.empty` | Kayıt yok. |
| `admin.audit.older` | Daha eski kayıtlar |
| `admin.audit.newest` | En yeniye dön |
| `admin.matching.reject_reason_title` | Red nedeni |
| `admin.matching.reason.not_same_product` | Farklı ürün |
| `admin.matching.reason.different_color` | Farklı renk |
| `admin.matching.reason.different_size` | Farklı boyut/hacim |
| `admin.matching.reason.bad_data` | Bozuk veri |
| `admin.matching.reason.other` | Diğer |
| `admin.matching.reason.superseded` | Başka aday onaylandı |
| `admin.matching.reject_without_reason` | 0 Belirtmeden reddet |
| `admin.matching.copy_url` | Adresi kopyala |
| `admin.matching.history_title` | İnceleme geçmişi |
| `admin.merchants.title` | Mağazalar |
| `admin.merchants.readonly_note` | Feed ayarları, komisyon ve para birimi kanıtı burada düzenlenmez; kaynakta ve komut satırında kalır. |
| `admin.merchants.deactivate` | Veri toplamayı kapat |
| `admin.merchants.activate` | Veri toplamayı aç |
| `admin.merchants.deactivate_body` | Kapalı mağaza için sonraki toplama koşusu çalışmadan durur. Mevcut teklifler silinmez. |
| `admin.merchants.activate_body` | Açmak Shopify para birimi kapısını atlamaz; doğrulanmamış mağaza yine toplanmaz. |
| `admin.merchants.reason_label` | Gerekçe (denetim kaydına yazılır) |
| `admin.merchants.confirm_label` | Onaylamak için mağazanın kısa adını yaz: {slug} |
| `admin.merchants.stale_session` | Güvenlik için bu işlemden önce yeniden giriş yap (son girişin 1 saatten eski). |
| `admin.ingest.title` | Veri toplama |
| `admin.ingest.note` | Koşular komut satırı ya da zamanlayıcıdan çalışır; bu ekran yalnızca izlerini gösterir. |
| `admin.catalog.products_title` | Ürünler |
| `admin.catalog.offers_title` | Teklifler |
| `admin.search_diagnostics.title` | Arama tanısı |
| `admin.search_diagnostics.note` | Bir sorgunun /ara'da nasıl işlendiğini gösterir. Gerçek arama çalışır ama önbelleğe, arama sayacına ve analitiğe yazılmaz. |
| `admin.search_diagnostics.rate_limited` | Dakikada en fazla {n} tanı çalıştırılabilir. Biraz bekle. |
| `admin.link.title` | Link araması |
| `admin.images.title` | Görsel arama |
| `admin.images.note` | Yüklenen görseller burada gösterilmez; ham dosya en fazla 30 gün saklanır. |
| `admin.seo.title` | SEO tanısı |
| `admin.seo.not_search_console` | Arilla'nın kendi katalog ve sitemap verisinden üretilir. Search Console verisi değildir: tarama, dizine ekleme, gösterim ya da tıklama sayısı burada yok. |
| `admin.operations.title` | İşletim |
| `admin.operations.note` | Veritabanından okunabilen sağlık sinyalleri. İş geçmişi tablosu olmadığı için işlerin durumu ürettikleri verinin tazeliğinden okunur ("son kanıt"). |
| `admin.users.title` | Kullanıcılar |
| `admin.users.note` | Destek için tek hesap bulma. Arama ve görüntüleme denetim kaydına yazılır; aranan değer yazılmaz. |
| `admin.users.not_found` | Bu bilgiyle eşleşen hesap yok. |
| `admin.users.input_invalid` | E-posta, telefon (+90…) ya da hesap kimliği gir. |

## Hukuki

| Anahtar | Metin |
| --- | --- |
| `legal.affiliate_notice` | Bazı bağlantılardan alışveriş yaptığında komisyon kazanabiliriz. Bu, sana gösterdiğimiz fiyatı değiştirmez. |
| `legal.sponsored_badge` | Sponsorlu |
| `legal.price_disclaimer` | Fiyat ve stok bilgisi mağazalardan alınır, gecikmeli olabilir. |
| `legal.consent_history` | Gezinme geçmişimi kaydet, bana daha iyi öneriler göster. |
| `legal.consent_marketing` | Haftalık fırsat özetini e-posta ile gönder. |
| `legal.consent_discovery` | Bulduğum ürünler isimsiz olarak keşfet akışında görünebilsin. |
| `legal.delete_warning` | Bu işlem geri alınamaz. |
| `account.delete_staff_blocked` | Yönetim yetkisi olan bir hesap silinemez. Önce yetkinin kaldırılması için ekiple iletişime geç. |
| `account.logout_all` | Tüm cihazlardan çıkış yap |
| `admin.users.revoke_sessions` | Tüm oturumları kapat |
| `admin.campaign.test_recipient_not_allowed` | Test e-postası yalnızca kendi adresine ya da izinli test adreslerine gönderilebilir. |

Rıza kutuları **işaretsiz** gelir ve girişin ön koşulu değildir.

Yasal sayfaların gövde metni (hitap "siz") sayfa dosyalarında durur:
`apps/web/app/{gizlilik,kvkk-aydinlatma,cerez,kosullar,affiliate-aciklamasi,sirket-bilgileri}/page.tsx`.
Şirket kimliği metin değil yapılandırmadır: tek kaynağı
`packages/core/src/config/legal-identity.ts` (karar 0038).

| Anahtar | Metin |
| --- | --- |
| `legal.affiliate_notice_link` | Affiliate açıklaması |
| `legal.identity_pending` | Hizmeti işleten tüzel kişiliğin tescil bilgileri tamamlandığında bu sayfada yayımlanacaktır. |

## Çerez rızası (karar 0038)

Banner ve tercih paneli sitenin genel "sen" dilindedir. Üç düğme aynı görsel
ağırlıktadır; hiçbiri vurgulanmaz.

| Anahtar | Metin |
| --- | --- |
| `consent.banner_title` | Gizlilik tercihlerini yönet |
| `consent.banner_body` | Sitenin çalışması için gerekli çerezleri kullanıyoruz. Analitik, işlevsel ve reklam/affiliate ölçüm teknolojilerini yalnızca izin verdiğin kategoriler için etkinleştiririz; şu an bu kategorilerde kullandığımız bir teknoloji yok. Tercihini istediğin zaman değiştirebilirsin. |
| `consent.reject_all` | Tümünü Reddet |
| `consent.manage` | Tercihleri Yönet |
| `consent.accept_all` | Tümünü Kabul Et |
| `consent.save` | Tercihleri Kaydet |
| `consent.close` | Kapat |
| `consent.panel_title` | Çerez tercihleri |
| `consent.panel_description` | Kesinlikle gerekli çerezler her zaman açıktır. Diğer kategoriler sen açmadıkça kapalı kalır. |
| `consent.necessary_title` | Kesinlikle gerekli |
| `consent.necessary_body` | Oturum, güvenlik, giriş, arama limiti, tema ve bu tercihin kaydı. Kapatılamaz. |
| `consent.functional_title` | İşlevsel |
| `consent.functional_body` | İsteğe bağlı site özelliklerini hatırlar. |
| `consent.analytics_title` | Analitik / performans |
| `consent.analytics_body` | Sitenin nasıl kullanıldığını ve performansını ölçer. |
| `consent.marketing_title` | Reklam / affiliate ölçüm |
| `consent.marketing_body` | Reklam ve affiliate yönlendirmelerini cihazında ölçer. |
| `consent.category_unused` | Şu an bu kategoride kullandığımız bir teknoloji yok. |
| `consent.always_on` | Her zaman açık. |
| `consent.links_label` | Ayrıntılar |

## SEO

Arama sonucunda görünen ama sayfada gösterilmeyen metinler (D6). `{ürün}` ve
`{marka}` ham veriden gelir, yazılı metin değildir.

| Anahtar | Metin |
| --- | --- |
| `seo.product_title` | {ürün} – {marka} fiyat karşılaştırma |
| `seo.product_title_no_brand` | {ürün} fiyat karşılaştırma |
| `seo.product_description` | {ürün} fiyatlarını karşılaştır, en uygun fiyatlı mağazayı bul. |

## Link araması

Kaynak: `apps/web/app/ara/link/link-search-copy.ts` (docs/decisions/0035).

Geçici olarak kapalı (`LINK_SEARCH_PUBLIC = false`): `/ara/link` yalnızca
"Yakında" durumunu gösterir — başlık `Yakında`, açıklama "Link ile ürün arama
özelliği yakında aktif olacak. Şimdilik ürün adını yazarak ya da fotoğraf
yükleyerek arayabilirsin.", arama kutusu "Ürün adı, marka ya da kısa bir tarif
yaz". Ana sayfa "Ürün linki yapıştır" kartını ve kutudaki "Ürün linki"
ifadesini göstermez.

| Anahtar | Metin |
| --- | --- |
| `link_search.pending_title` | Ürün inceleniyor… |
| `link_search.results_title` | Bu ürüne benzer sonuçlar |
| `link_search.same_title` | Bu ürün Arilla'da da var |
| `link_search.source_label` | İncelediğin ürün |
| `link_search.source_note` | Bu ürün başka bir sitede. Aşağıdakiler Arilla kataloğundan. |
| `link_search.empty_title` | Bu ürüne benzeyen bir şey bulamadık. |
| `link_search.timeout_title` | İnceleme beklenenden uzun sürüyor. |
| `link_search.robots_disallowed` | Bu site ürün sayfasının okunmasına izin vermiyor. |
| `link_search.no_product` | Bu sayfada ürün bilgisi bulamadık. |
| `link_search.daily_limit` | Bugünlük bağlantı arama hakkın doldu. |

"Aynı ürün" yalnızca barkod ya da marka + üretici kodu eşleşmesinde yazılır;
görsel benzerlik "aynı" diye etiketlenmez.

## Sohbet geri bildirimi (karar 0079)

Hitap "sen". Metinler `apps/web/app/sohbet/chat-copy.ts`. Neden kodları kodda
İngilizce, metinleri Türkçedir.

| Anahtar | Metin |
| --- | --- |
| `chat.feedback_question` | Bu yardımcı oldu mu? |
| `chat.feedback_yes` | Evet, yardımcı oldu |
| `chat.feedback_no` | Hayır, yardımcı olmadı |
| `chat.feedback_thanks` | Teşekkürler, not aldım. |
| `chat.feedback_failed` | Kaydedemedim, tekrar dener misin? |
| `chat.feedback_rate_limited` | Çok sık oy verdin. Biraz sonra tekrar dener misin? |
| `chat.feedback_dialog_title` | Bu yanıtı nasıl iyileştirebiliriz? |
| `chat.feedback_reason_label` | Sorun nedeni |
| `chat.feedback_reason_placeholder` | Bir neden seç (isteğe bağlı) |
| `chat.feedback_reason.not_found` | Aradığım ürünleri bulamadı |
| `chat.feedback_reason.irrelevant` | Alakasız ürünler önerdi |
| `chat.feedback_reason.misunderstood` | İsteğimi yanlış anladı |
| `chat.feedback_reason.wrong_info` | Yanlış bilgi verdi |
| `chat.feedback_reason.wrong_price_or_product` | Fiyat veya ürün bilgisi hatalı |
| `chat.feedback_reason.slow` | Yanıt çok yavaştı |
| `chat.feedback_reason.other` | Diğer |
| `chat.feedback_comment_label` | Ayrıntı ekle (isteğe bağlı) |
| `chat.feedback_comment_placeholder` | Ne yanlıştı ya da ne eksikti? |
| `chat.feedback_comment_hint` | Kişisel bilgi yazma. En fazla 500 karakter. |
| `chat.feedback_cancel` | İptal |
| `chat.feedback_submit` | Gönder |
| `chat.feedback_submitting` | Gönderiliyor |

## Geri bildirim (karar 0045)

Hitap "siz" (ürün sahibinin verdiği metin). Ürün adı bu metinlerde de
yayındaki marka "ManiCepte" (karar 0045 §9). Metinler
`apps/web/app/geri-bildirim/feedback-copy.ts`.

| Anahtar | Metin |
| --- | --- |
| `feedback.title` | ManiCepte'yi birlikte geliştirelim |
| `feedback.description` | Eksik gördüğünüz, geliştirilmesini istediğiniz veya sorun yaşadığınız noktaları bize iletebilirsiniz. |
| `feedback.category_label` | Geri bildirim türü |
| `feedback.category.*` | Öneri · Hata bildirimi · Özellik isteği · Tasarım / kullanım deneyimi · Ürün / mağaza önerisi · Diğer |
| `feedback.title_label` | Başlık |
| `feedback.title_placeholder` | Arama sonuçlarında filtreleme olmalı |
| `feedback.message_label` | Açıklama |
| `feedback.message_hint` | Ne bekliyordunuz, ne oldu veya neyin geliştirilmesini istersiniz? |
| `feedback.priority_label` | Önem seviyesi (isteğe bağlı) |
| `feedback.priority.*` | Düşük · Orta · Yüksek |
| `feedback.email_label` | E-posta (isteğe bağlı) |
| `feedback.email_hint` | Yanıt almak isterseniz e-posta adresinizi bırakabilirsiniz. |
| `feedback.auth_notice` | Erken erişim üyesi olarak gönderdiğiniz geri bildirim hesabınızla ilişkilendirilecektir. |
| `feedback.privacy_note` | Kişisel verilerinizin nasıl işlendiğini Gizlilik Politikası'nda bulabilirsiniz. |
| `feedback.submit` | Geri bildirim gönder |
| `feedback.submitting` | Gönderiliyor… |
| `feedback.success_title` | Geri bildiriminiz alındı. |
| `feedback.success_body` | ManiCepte'yi geliştirmemize yardımcı olduğunuz için teşekkür ederiz. |
| `feedback.success_another` | Yeni geri bildirim gönder |
| `feedback.error_category` | Bir geri bildirim türü seçin. |
| `feedback.error_title_required` | Bir başlık yazın. |
| `feedback.error_title_length` | Başlık 3 ile 120 karakter arasında olmalı. |
| `feedback.error_message_required` | Bir açıklama yazın. |
| `feedback.error_message_length` | Açıklama 10 ile 5000 karakter arasında olmalı. |
| `feedback.error_priority` | Listeden bir önem seviyesi seçin. |
| `feedback.error_email` | Geçerli bir e-posta adresi girin ya da alanı boş bırakın. |
| `feedback.error_fix_fields` | Lütfen işaretli alanları düzeltin. |
| `feedback.error_malformed` | Form gönderilemedi. Sayfayı yenileyip tekrar deneyin. |
| `feedback.error_too_large` | Gönderdiğiniz metin çok uzun. Lütfen kısaltıp tekrar deneyin. |
| `feedback.error_rate_limited` | Kısa sürede çok fazla geri bildirim gönderdiniz. Birkaç dakika sonra tekrar deneyin. |
| `feedback.error_unavailable` | Geri bildiriminizi şu an kaydedemedik. Biraz sonra tekrar deneyin. |
| `feedback.error_network` | Bağlantı kurulamadı. İnternet bağlantınızı kontrol edip tekrar deneyin. |
| `feedback.error_session_expired` | Oturumunuz sona ermiş. Geri bildiriminizin hesabınızla ilişkilendirilmesi için tekrar giriş yapın. |
| `feedback.login_again` | Tekrar giriş yap |
| `feedback.early_access_prompt` | Bir fikriniz mi var? ManiCepte'yi birlikte geliştirelim. |

## Hata

| Anahtar | Metin |
| --- | --- |
| `error.generic` | Bir şeyler ters gitti. Tekrar dener misin? |
| `error.not_found` | Aradığın sayfayı bulamadık. |
| `error.not_found_code` | Hata 404 |
| `error.not_found_body` | Bağlantı eskimiş ya da sayfa taşınmış olabilir. Aramaya ana sayfadan yeniden başlayabilir veya keşfedilen ürünlere göz atabilirsin. |
| `error.home_action` | Ana sayfaya dön |
| `error.generic_title` | Bu sayfa şu an açılamadı. |
| `error.global_title` | Arilla şu an açılamadı. |
| `error.document_title` | Bir hata oluştu – Arilla |
| `action.retry` | Tekrar dene |
| `error.rate_limited` | Çok hızlı gidiyorsun. Biraz bekleyip tekrar dene. |
| `error.upload_too_large` | Fotoğraf çok büyük. 4 MB'tan küçük bir dosya dener misin? |
| `error.visual_search_unavailable` | Fotoğrafla arama şu an kullanılamıyor. Biraz sonra tekrar dener misin? |
| `error.upload_not_product` | Bu fotoğrafta bir ürün göremedik. Ürünün net göründüğü bir fotoğraf dener misin? |
| `error.daily_limit` | Bugünlük görsel arama hakkın doldu. Yarın tekrar bekleriz. |
| `error.upload_unprocessable` | Bu görseli işleyemedik. Başka bir fotoğrafla yeniden dener misin? |

Hatalar özür dilemez, ne olduğunu ve ne yapılacağını söyler.

## Anket (karar 0058)

Hitap "sen". Form başlığı, açıklaması ve soruları yönetimden gelir (ilk
onboarding formu `0043_forms.sql`). Sabit arayüz metinleri
`apps/web/app/anket/survey-copy.ts`'tedir.

| Anahtar | Metin |
| --- | --- |
| `survey.submit` | Gönder |
| `survey.back` | Geri |
| `survey.next` | İleri |
| `survey.finish` | Tamamla |
| `survey.progress_label` | Anket ilerlemesi |
| `survey.step_of` | Soru {n} / {toplam} |
| `survey.skip` | Şimdilik geç |
| `survey.success_title` | Teşekkürler, yanıtın alındı. |
| `survey.success_body` | Cevapların ürünü senin ihtiyaçlarına göre geliştirmemize yardımcı olacak. |
| `survey.auth_notice` | Giriş yaptığın için yanıtın hesabınla ilişkilendirilecek. |
| `survey.anonymous_notice` | Bu formda kimliğin istenmez; yanıtın hesabınla ilişkilendirilmez. |
| `survey.onboarding_prompt` | Seni biraz daha tanıyalım: birkaç kısa soru. |
| `survey.onboarding_cta` | Şimdi doldur |
| `survey.closed_title` | Bu form artık yanıt almıyor. |
| `survey.not_started_title` | Bu form henüz açılmadı. |
| `survey.login_title` | Bu formu yanıtlamak için giriş yap. |
| `survey.early_access_title` | Bu form erken erişim üyelerine özel. |
| `survey.responded_title` | Bu formu zaten yanıtladın. |
| `survey.error_required` | Bu soru zorunlu. |

