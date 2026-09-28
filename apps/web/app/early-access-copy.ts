/** docs/copy.md "Erken erişim" - anahtarlar yorumda. */
export const EARLY_ACCESS_COPY = {
  cta: "Erken erişime katıl", // early_access.cta
  landingNote: "Arilla şu an erken erişimde. Listeye katıl, açıldığında haber verelim.", // early_access.landing_note
  loginTitle: "Erken erişime katıl. Hesabınla devam et ya da yeni hesap aç.", // early_access.login_title
  navStatus: "Erken erişim", // early_access.nav_status
  joinedTitle: "Erken erişim listesine katıldın", // early_access.joined_title
  joinedBody: "Arilla açıldığında haber vereceğiz.", // early_access.joined_body
  joinedOn: (date: string) => `Katılım tarihi: ${date}`, // early_access.joined_on
  inList: "Erken erişim listesindesin.", // early_access.in_list
  viewStatus: "Durumunu gör", // early_access.view_status
  joinTitle: "Erken erişim listesine katıl", // early_access.join_title
  joinBody: "Listeye katıl, Arilla açıldığında haber verelim.", // early_access.join_body
  joinSubmit: "Listeye katıl", // early_access.join_submit
} as const;
