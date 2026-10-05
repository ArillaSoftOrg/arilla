# 0059 — Sade hesap sayfası, ilk giriş karşılaması, sistem teması, yeni hesap rıza varsayılanları

**Tarih:** 5 Ekim 2026
**Durum:** Kabul edildi (ürün sahibi talebi). KVKK açısından hukukçu onayı bekliyor — bkz. "Risk".

## Karar

1. **`/hesap` bir tüketici profil sayfasıdır**, ayar paneli değil: profil kartı
   (avatar, ad, e-posta, "Yeni arama", "Yönet" menüsü), davet bonusu ("Bonus hak
   kazan") ve son bakılan ürünler. Sayfadan kalkanlar: Tema, İzinler, "Verilerimi
   indir", geçmişi sil, "Tüm cihazlardan çıkış", ayrı "Çıkış yap", arama hakkı
   sayacı/günlük-bonus açıklamaları, haftalık özet anahtarı. "Yönet" menüsü
   yalnızca **Hesabı sil** (mevcut onay akışı) ve **Çıkış yap** (mevcut
   `logoutAction`) içerir. Sunucu işlevleri (`/hesap/veri-indir`,
   `clearHistoryAction`, `logoutAllDevicesAction`, `updateConsentAction`) silinmez;
   yalnızca arayüzden çıkar.
2. **Tema yalnızca sistem tercihidir** (0007'yi değiştirir): `prefers-color-scheme`.
   `theme` çerezi artık yazılmaz ve okunmaz; `[data-theme]` blokları kalktı.
3. **İlk giriş karşılaması** (`/hos-geldin`): yeni hesap ilk girişte karşılamaya
   yönlenir (`next` taşınır). Son adım "Gelişmelerden haberdar ol.": haftalık
   özet kartı varsayılan **KAPALI**; yalnızca kullanıcı açarsa `marketing_email`
   `granted = true` (kaynak `onboarding`). Devam (dokunmadan) ve Atla `false`
   yazar. Tamamlanınca `app_user.onboarded_at` dolar; bir daha açılmaz. Mevcut
   hesaplar migration'da doldurulur, karşılamayı görmez. Personel görmez.
4. **Yeni hesapta varsayılan AÇIK izinler:** kişiselleştirme (`browsing_history` +
   `personalization`) ve anonim keşif katkısı (`public_discovery`). Yalnızca
   hesap açılırken (`createSessionForUser`, `isNewUser`), kaynak `signup_default`,
   metin sürümü `signup-default-v1`. Mevcut kullanıcıların kayıtlarına ve
   açık tercihlerine dokunulmaz; geriye dönük rıza üretilmez.

## Gerekçe

Sade profil deneyimi; ayarların çoğu kimsenin açmadığı kalabalık kartlardı.
Sistem teması tek kaynak ve bakım yükünü düşürür. Bülten ancak açık eylemle
açıldığı için ticari ileti rızası opt-in kalır.

## Risk (açık)

- `docs/kvkk.md` kişiselleştirme/gezinme geçmişi/keşif için **açık rıza** ve
  opt-in der. Varsayılan AÇIK kayıt, önceden işaretli kutu gibi okunabilir ve
  "açık rıza" olarak geçmeyebilir. Karşılamanın 1. adımı bu iki tercihi açıkça
  söyler, kayıtlar ayrı kaynakla ayrışır (`signup_default`), ama **arayüzde
  geri çekme yolu artık yok**: `/hesap` anahtarları kalktı. Hukuk onayı olmadan
  canlıya almadan önce geri çekme yolu (ör. gizlilik sayfasından ya da Yönet
  menüsünden) ve metin gözden geçirilmeli.
- Karşılamanın 1. adımı bilgilendirmedir; rıza metni onaylı değildir.

## Reddedilen alternatifler

- Varsayılanı kayıt yazmadan kodda "açık" saymak: denetim izi olmaz, `getConsents`
  ve analitik/aktivite okuyucularıyla çelişir.
- Bülten kartını varsayılan açık yapmak: ticari ileti için İYS/açık rıza.
- Geri çekme anahtarlarını `/hesap`'ta tutmak: ürün sahibi sade sayfayı istedi.
