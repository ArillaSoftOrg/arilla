# 0092 — Elle tema seçimi geri geliyor; sıcak açık tema

**Tarih:** 10 Ekim 2026 · **Durum:** kabul edildi (ürün sahibi talebi)

Karar 0060'ın 2. maddesini ("tema yalnızca sistem tercihidir") değiştirir;
0007'deki elle geçişi üst çubukta geri getirir.

## Karar

1. **Üst çubukta tema düğmesi.** Hesap alanının solunda, her genişlikte ve
   sohbet çubuğunda görünür, 44px'lik kompakt güneş/ay düğmesi. Erişilebilir
   adı sabit ("Koyu tema", `nav.theme_toggle`), durum `aria-pressed` ile.
2. **İlk ziyaret cihaz tercihidir** (`prefers-color-scheme`). Elle seçim onu
   geçersiz kılar ve kalıcıdır.
3. **Kalıcılık 0026'daki desendir:** `theme` çerezi (`light` | `dark`, 1 yıl,
   `SameSite=Lax`, https'te `Secure`) → kök layout `<html data-theme>`
   yazar. İlk HTML doğru temada gelir: satır içi betik yok, `localStorage`
   yok, titreme yok. Kök layout zaten çerez okuduğu (rıza, 0038) için yeni
   dinamik render maliyeti yok. Düğme seçimi `<html data-theme>`a anında ve
   çereze yazar; sunucuya istek gitmez, sayfa yeniden çizilmez.
4. **Tek belirteç sistemi.** `tokens.css`'te koyu değerler iki blokta durur
   (cihaz tercihi `:root:not([data-theme="light"])` ve elle seçim
   `:root[data-theme="dark"]`); eşitliklerini `theme-tokens.test.ts` denetler.
   Sayfaya özgü tema kuralı yoktur; `/yonetim`'in kendi koyu ayarları da aynı
   iki seçiciyle korunur (değerleri değişmedi).
5. **Açık tema sıcak kırık beyazdır**, saf beyaz değil: `--paper #FAF8F5`,
   `--surface #F3F0EB`, `--surface-hover #EBE7E0`, `--line #E6E1D9`,
   `--line-strong #86817A`, `--ink-secondary #44423E`, `--ink-muted #67635D`.
   Kart ve kutular `--surface-raised #FFFFFF` ile yükselir (0007: beyaz
   zeminli ürün fotoğrafı kartla bir olur). Kontrast design.md tablosunda;
   hepsi ≥ 4.5:1 (metin) ve ≥ 3:1 (kontrol sınırı). **Koyu tema değerleri
   değişmedi.**
6. Sayfalarda kalan gömülü renkler belirtece taşındı: `--tint-aqua`,
   `--tint-mist`, `--tint-warm` (kullanım kartı zeminleri), `--media-scrim` ve
   `--on-media` (görsel üstü işaret), `--shadow-hero` ve `--shadow-hero-focus`
   (ana sayfa kutusu, link bekleme kartı).

## Gerekçe

Kullanıcılar cihazdan bağımsız tema seçmek istiyor (ör. koyu cihazda ürün
fotoğraflarını açık zeminde görmek). Çerez → SSR deseni 0026'da zaten
denenmiş, titremesiz ve betiksizdir. Tek kaynaklı belirteçler sayesinde
seçim ikinci bir tema sistemi gerektirmez.

## Reddedilen alternatifler

1. **`localStorage` + `<head>`'de satır içi betik.** Reddedildi: CLAUDE.md
   depolamasız çalışmayan akışı yasaklar; betik CSP'yi zorlar ve sunucu
   seçimi bilmez.
2. **Sunucu eylemiyle çerez yazmak (0007'nin eski hali).** Reddedildi:
   Next.js eylemden sonra sayfayı sunucuda yeniden çizer; sohbet ve arama
   sayfalarında gereksiz istek ve durum riski.
3. **Üç konumlu (sistem/açık/koyu) seçici.** Reddedildi (bu aşama için):
   tek dokunuşla geçiş daha sade; çerezi silmek sistem tercihine döndürür.
4. **Açık temayı koyu temanın tersi olarak türetmek.** Reddedildi: hiyerarşi
   ve sıcaklık kaybolur; açık tema ayrı tasarlandı.

## Sonucu

- `theme` zorunlu çerez olarak `/cerez` envanterine eklendi (docs/kvkk.md
  "Zorunlu çerezler" tema tercihini zaten sayıyordu).
- `global-error.tsx` kök layout'u kullanmadığı için yalnızca cihaz
  tercihini izler (nadir hata ekranı).
