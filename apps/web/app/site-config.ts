/**
 * Faz 8.1: public iletisim e-postasinin TEK kaynagi - footer'daki /iletisim
 * sayfasi ve /gizlilik buradan okur, adres baska yerde tekrar yazilmaz.
 *
 * GECICI: kurumsal alan adi ve e-posta alininca (Admitad basvurusu oncesi)
 * yalnizca bu satir degisir. Secret degildir, env'e konmaz - env'de tanimsiz
 * kalirsa iletisim sayfasi bos kalirdi.
 *
 * Bu adres SMTP gondericisi DEGILDIR: giris/alarm e-postalari `EMAIL_FROM` ve
 * `SMTP_*` ile ayri yapilandirilir (bkz. .env.example).
 */
export const PUBLIC_CONTACT_EMAIL = "arillasoft@gmail.com";
