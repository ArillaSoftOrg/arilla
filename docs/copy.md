# Metin bankası

Kullanıcıya görünen tüm metinler burada. Aynı eylem her yerde aynı isimle
anılır. Yeni metin eklenecekse önce bu dosyaya yazılır.

Kurallar `design.md` içinde: cümle düzeni, ALL CAPS yok, "satın al" yok,
"dupe" yok, "ucuz" yerine "daha uygun fiyatlı".

## Ana sayfa

| Anahtar | Metin |
| --- | --- |
| `home.tagline` | Bir ürün bul, aynısını veya benzerini farklı mağazalarda karşılaştır. |
| `home.hero_title` | Aradığın ürünü bul |
| `home.continue_shopping_title` | Alışverişe devam et |
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

## Altbilgi (Faz 5-6)

| Anahtar | Metin |
| --- | --- |
| `footer.product_group_title` | Ürün |
| `footer.account_group_title` | Hesap |
| `footer.info_group_title` | Bilgi |
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
| `nav.cookies` | Çerezler |
| `nav.contact` | İletişim |
| `nav.skip_to_content` | İçeriğe geç |

## İletişim (Faz 8.1)

E-posta adresi metin değil yapılandırmadır: tek kaynağı
`apps/web/app/site-config.ts` (`PUBLIC_CONTACT_EMAIL`). Geçici adres;
kurumsal e-posta alınınca yalnızca o satır değişir. Telefon, adres, unvan,
çalışma saati bilerek yok — doğrulanmış bilgi değil.

| Anahtar | Metin |
| --- | --- |
| `contact.title` | İletişim |
| `contact.description` | Arilla ile ilgili soru, geri bildirim veya destek talepleri için bizimle iletişime geçebilirsiniz. |
| `contact.email_label` | E-posta |
| `privacy.contact_prefix` | Verilerinle ilgili soruların için |
| `privacy.contact_suffix` | adresine yazabilirsin. |

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

## Arama

| Anahtar | Metin |
| --- | --- |
| `search.placeholder` | Ürün adı yaz, link yapıştır veya fotoğraf yükle |
| `search.empty_query` | Aramak için yukarıya bir şey yaz. |
| `search.result_count` | {n} sonuç |
| `search.offer_count` | {n} mağaza |
| `search.tab_balanced` | Bizim seçtiklerimiz |
| `search.tab_deals` | En iyi fırsatlar |
| `search.tab_match` | En yakın eşleşmeler |
| `search.clarify_intro` | Hangisini arıyorsun? |
| `search.clarify_other` | Başka bir şey |
| `search.clarify_other_placeholder` | Ne arıyorsun? |
| `search.loading` | Benzerlerini arıyoruz |
| `search.empty` | Bu aramada sonuç bulamadık. Filtreleri gevşetmeyi deneyebilirsin. |
| `search.empty_nearest` | Sana en yakın bulduklarımız |
| `search.page_previous` | Önceki |
| `search.page_next` | Sonraki |
| `search.error` | Arama şu an çalışmıyor. Birazdan tekrar dener misin? |

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

## Giriş

| Anahtar | Metin |
| --- | --- |
| `auth.modal_title` | Sonuçlarını kaydedelim mi? |
| `auth.modal_body` | Hesabın yok mu? Ücretsiz kaydol, bu sonuçları senin için saklayalım. |
| `auth.email_label` | E-posta adresin |
| `auth.link_sent_title` | Bağlantıyı gönderdik |
| `auth.link_sent_body` | E-postana bir giriş bağlantısı gönderdik. Bağlantı 15 dakika geçerli. |
| `auth.rate_limited` | Az önce bir bağlantı gönderdik. Birkaç dakika sonra tekrar dene. |
| `auth.token_expired` | Bu bağlantının süresi dolmuş. Yeni bir tane isteyebilirsin. |
| `auth.token_used` | Bu bağlantı zaten kullanılmış. |

`auth.rate_limited` mesajı hesabın var olup olmadığını belli etmez; her iki
durumda da aynı metin gösterilir.

## Boş durumlar

| Anahtar | Metin |
| --- | --- |
| `empty.saved` | Henüz kaydettiğin ürün yok. Beğendiğin bir ürünü kaydet, ucuzlayınca haber verelim. |
| `empty.alerts` | Alarmın yok. Bir ürünün fiyatı düşünce ya da bedenin gelince haber verelim. |
| `empty.history` | Henüz gezindiğin ürün yok. |
| `empty.creator_visitor` | Bu vitrin hazırlanıyor. |
| `empty.creator_owner` | İlk koleksiyonunu oluştur ve beğendiğin ürünleri ekle. |
| `empty.discovery` | Bugünlük içerik hazırlanıyor. |

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

Giriş, fiyat alarmı ve stok bildirimi **işlemsel iletidir.** Haftalık özet
**ticari iletidir** ve ayrı izin gerektirir (`kvkk.md`).

## Yönetim

Rol gerektiren `/yonetim/*` ekranları için. Erişim `requireRole(["moderator",
"admin"])` ile her sayfa ve server action'da ayrı ayrı zorlanır (`app/lib/
dal.ts`) - `docs/routes.md`'nin öngördüğü gibi.

| Anahtar | Metin |
| --- | --- |
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
| `admin.lexicon.tier3_empty` | Şu an aday yok. |

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

Rıza kutuları **işaretsiz** gelir ve girişin ön koşulu değildir.

## SEO

Arama sonucunda görünen ama sayfada gösterilmeyen metinler (D6). `{ürün}` ve
`{marka}` ham veriden gelir, yazılı metin değildir.

| Anahtar | Metin |
| --- | --- |
| `seo.product_title` | {ürün} – {marka} fiyat karşılaştırma |
| `seo.product_title_no_brand` | {ürün} fiyat karşılaştırma |
| `seo.product_description` | {ürün} fiyatlarını karşılaştır, en uygun fiyatlı mağazayı bul. |

## Hata

| Anahtar | Metin |
| --- | --- |
| `error.generic` | Bir şeyler ters gitti. Tekrar dener misin? |
| `error.not_found` | Aradığın sayfayı bulamadık. |
| `error.rate_limited` | Çok hızlı gidiyorsun. Biraz bekleyip tekrar dene. |
| `error.upload_too_large` | Fotoğraf çok büyük. Daha küçük bir dosya dener misin? |
| `error.upload_not_product` | Bu fotoğrafta bir ürün göremedik. Ürünün net göründüğü bir fotoğraf dener misin? |
| `error.daily_limit` | Bugünlük görsel arama hakkın doldu. Yarın tekrar bekleriz. |

Hatalar özür dilemez, ne olduğunu ve ne yapılacağını söyler.
