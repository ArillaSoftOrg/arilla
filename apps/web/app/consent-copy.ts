/**
 * docs/copy.md "Çerez rızası" (karar 0038) - anahtarlar birebir aynı. Metin
 * önce copy.md'de değişir, sonra burada.
 */
export const CONSENT_COPY = {
  bannerTitle: "Gizlilik tercihlerini yönet", // consent.banner_title
  bannerBody:
    "Sitenin çalışması için gerekli çerezleri kullanıyoruz. Analitik, işlevsel ve reklam/affiliate ölçüm teknolojilerini yalnızca izin verdiğin kategoriler için etkinleştiririz; şu an bu kategorilerde kullandığımız bir teknoloji yok. Tercihini istediğin zaman değiştirebilirsin.", // consent.banner_body
  rejectAll: "Tümünü Reddet", // consent.reject_all
  manage: "Tercihleri Yönet", // consent.manage
  acceptAll: "Tümünü Kabul Et", // consent.accept_all
  save: "Tercihleri Kaydet", // consent.save
  close: "Kapat", // consent.close
  panelTitle: "Çerez tercihleri", // consent.panel_title
  panelDescription:
    "Kesinlikle gerekli çerezler her zaman açıktır. Diğer kategoriler sen açmadıkça kapalı kalır.", // consent.panel_description
  necessaryTitle: "Kesinlikle gerekli", // consent.necessary_title
  necessaryBody: "Oturum, güvenlik, giriş, arama limiti, tema ve bu tercihin kaydı. Kapatılamaz.", // consent.necessary_body
  functionalTitle: "İşlevsel", // consent.functional_title
  functionalBody: "İsteğe bağlı site özelliklerini hatırlar.", // consent.functional_body
  analyticsTitle: "Analitik / performans", // consent.analytics_title
  analyticsBody: "Sitenin nasıl kullanıldığını ve performansını ölçer.", // consent.analytics_body
  marketingTitle: "Reklam / affiliate ölçüm", // consent.marketing_title
  marketingBody: "Reklam ve affiliate yönlendirmelerini cihazında ölçer.", // consent.marketing_body
  categoryUnused: "Şu an bu kategoride kullandığımız bir teknoloji yok.", // consent.category_unused
  alwaysOn: "Her zaman açık.", // consent.always_on
  linksLabel: "Ayrıntılar", // consent.links_label
} as const;

/** Banner ve panelde gösterilen aydınlatma bağlantıları (legal pack 07 §6). */
export const CONSENT_LINKS = [
  { label: "Çerez Politikası", href: "/cerez" },
  { label: "Gizlilik Politikası", href: "/gizlilik" },
  { label: "KVKK Aydınlatma Metni", href: "/kvkk-aydinlatma" },
] as const;

/** JS kapalıyken "Tercihleri Yönet" ve footer bağlantısının düştüğü yer. */
export const COOKIE_PREFERENCES_HREF = "/cerez#tercihler";
