# Yayına Çıkmadan Önce Doldurulması Gereken Hukuki Bilgiler

Aşağıdaki alanlar doğrulanmadan Claude Code bunları tahmin etmemeli veya örnek değer üretmemelidir.

| Alan | Durum |
|---|---|
| Marka adı | Arilla |
| Yasal işletmeci / veri sorumlusu unvanı | `{{LEGAL_ENTITY_NAME}}` |
| Açık adres | `{{LEGAL_ADDRESS}}` |
| Ülke | `{{COUNTRY}}` |
| Gizlilik/KVKK e-postası | `{{PRIVACY_EMAIL}}` |
| Genel destek e-postası | `{{SUPPORT_EMAIL}}` |
| Ana site URL'si | `{{WEBSITE_URL}}` |
| MERSİS No | `{{MERSIS_NO}}` — varsa |
| Vergi dairesi / vergi no | `{{TAX_OFFICE_AND_NO}}` — varsa |
| Ticaret sicil no | `{{TRADE_REGISTRY_NO}}` — varsa |
| Telefon | `{{PHONE}}` — kullanılacaksa |

## Uygulama kuralı

Bu alanlar için tek bir merkezi `legal/company` config kaynağı oluşturulmalıdır. Footer, şirket bilgileri sayfası, gizlilik politikası, KVKK metni ve kullanım koşulları aynı kaynaktan beslenmelidir.

Production'da `{{...}}`, `TODO`, örnek telefon veya örnek şirket adresi görünmemelidir.
