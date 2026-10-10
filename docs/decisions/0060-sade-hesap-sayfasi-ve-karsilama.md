# 0060 — Sade hesap sayfası, onboarding bülten adımı, sistem teması, yeni hesap rıza varsayılanları

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
2. ~~**Tema yalnızca sistem tercihidir** : `prefers-color-scheme`.
   `theme` çerezi artık yazılmaz ve okunmaz; `[data-theme]` blokları kalktı.~~
   **Karar 0092 ile değişti:** üst çubukta elle seçim, `theme` çerezi →
   `<html data-theme>`; ilk ziyaret cihaz tercihi. Profil sayfasına tema
   ayarı geri gelmedi.
3. **Haftalık özet, onboarding anketinin (0058) SON adımıdır.** Ayrı bir
   karşılama rotası yoktur. Anket sihirbazı, yalnızca `kind = 'onboarding'`
   formunda ve kullanıcının henüz ilk kararı yokken (`app_user.onboarded_at`
   boş) soru adımlarından sonra "Gelişmelerden haberdar ol." adımını ekler:
   hesap e-postası gösterilir, kart varsayılan **KAPALI**. Yalnızca açıkça
   açılırsa `marketing_email` `granted = true` (kaynak `onboarding`); Devam
   (dokunmadan) ve "Şimdilik geç" `false` yazar. **İlk karar değişmez:**
   `onboarded_at` doluysa sonraki gönderimler hiçbir şey yazmaz. Migration
   mevcut hesapları `created_at` ile doldurur (adımı görmez). Başka bir form
   bülten rızası yazamaz. Giriş sonrası yönlendirme DEĞİŞMEDİ.
4. **Yeni hesapta varsayılan AÇIK izinler:** kişiselleştirme (`browsing_history` +
   `personalization`) ve anonim keşif katkısı (`public_discovery`). Yalnızca
   hesap açılırken (`createSessionForUser`, `isNewUser`), kaynak `signup_default`,
   metin sürümü `signup-default-v1`. Mevcut kullanıcıların kayıtlarına ve
   açık tercihlerine dokunulmaz; geriye dönük rıza üretilmez.

## Gerekçe

Sade profil deneyimi; ayarların çoğu kimsenin açmadığı kalabalık kartlardı.
Sistem teması tek kaynak ve bakım yükünü düşürür. Bülten ancak açık eylemle
açıldığı için ticari ileti rızası opt-in kalır.

## Risk (açık, hukuk kararı bekliyor)

- `docs/kvkk.md` kişiselleştirme/gezinme geçmişi/keşif için **açık rıza** ve
  opt-in der. Ürün sahibi yeni hesapta varsayılan AÇIK istedi; bu, önceden
  işaretli kutu gibi okunabilir ve "açık rıza" sayılmayabilir. Kod bunu
  uygular ama ayrı kaynakla (`signup_default`) işaretler, böylece sonradan
  ayrıştırılabilir. **Hukuk onayı olmadan canlıya alınmamalı**; onaylanmazsa
  `SIGNUP_DEFAULT_CONSENTS` boşaltılır (tek satır).
- Çerez analitik rızası (`cookie_analytics`) bu varsayılanlara DAHİL DEĞİLDİR;
  yalnızca çerez bandı kararı yazar (0049).
- Geri çekme yolu: `/hesap/gizlilik` (iki anahtar), "Hesabım" sayfasının
  altından bağlantılı. Haftalık özet e-postadaki abonelik iptali bağlantısıyla
  kapanır (0048).

## Reddedilen alternatifler

- Varsayılanı kayıt yazmadan kodda "açık" saymak: denetim izi olmaz, `getConsents`
  ve analitik/aktivite okuyucularıyla çelişir.
- Bülten kartını varsayılan açık yapmak: ticari ileti için İYS/açık rıza.
- Geri çekme anahtarlarını `/hesap` ana sayfasında tutmak: ürün sahibi sade sayfa istedi; ayrı `/hesap/gizlilik` sayfasına taşındı.
