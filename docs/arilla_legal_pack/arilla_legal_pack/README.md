# Arilla Legal + Consent Pack

**Sürüm:** 1.0  
**Tarih:** 26 Eylül 2026  
**Amaç:** Arilla sitesine gizlilik, KVKK, çerez yönetimi, kullanım koşulları, affiliate açıklaması ve şirket bilgileri katmanlarını eklemek.

## İçerik

1. `01-gizlilik-politikasi.md`
2. `02-kvkk-aydinlatma-metni.md`
3. `03-cerez-politikasi.md`
4. `04-kullanim-kosullari.md`
5. `05-affiliate-aciklamasi.md`
6. `06-sirket-bilgileri.md`
7. `07-cookie-banner-uygulama-spesifikasyonu.md`
8. `08-claude-code-entegrasyon-promptu.md`
9. `LEGAL_FIELDS_REQUIRED.md`

## Kritik kural

Bu pakette doğrulanmamış şirket bilgileri uydurulmamıştır. Aşağıdaki değişkenler gerçek ve doğrulanmış bilgilerle doldurulmadan ilgili sayfalar production'da "tamamlanmış hukuki metin" olarak kabul edilmemelidir:

- `{{LEGAL_ENTITY_NAME}}`
- `{{LEGAL_ADDRESS}}`
- `{{COUNTRY}}`
- `{{PRIVACY_EMAIL}}`
- `{{SUPPORT_EMAIL}}`
- `{{WEBSITE_URL}}`
- varsa `{{MERSIS_NO}}`
- varsa `{{TAX_OFFICE_AND_NO}}`
- varsa `{{TRADE_REGISTRY_NO}}`

## Entegrasyon ilkesi

Claude Code önce mevcut repoyu denetlemeli ve gerçekten kullanılan servisleri/veri akışlarını tespit etmelidir. Politikalarda yalnızca fiilen kullanılan sağlayıcılar, çerezler, analitik araçlar ve veri kategorileri yer almalıdır.

Özellikle:
- Google OAuth gerçekten kullanılıyorsa belirtilmeli.
- Analitik/ölçüm aracı yoksa politika sırf örnekte var diye sağlayıcı adı eklememeli.
- Admitad veya başka affiliate ağı production'da aktif olmadan sağlayıcıya özgü kesin ifadeler yazılmamalı.
- Zorunlu olmayan çerezler kullanıcı açıkça izin verene kadar çalıştırılmamalı.
