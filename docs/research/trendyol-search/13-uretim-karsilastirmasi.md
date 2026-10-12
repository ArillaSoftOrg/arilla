# İki sitemap üretiminin kimlik bazlı karşılaştırması (2026-10-12)

## Sonuç (tam, doğrulanmış)

| | Değer |
|---|---|
| Eski üretim | `2026-10-11T16:39:34Z`, 337 dosya, **8.126.053** benzersiz contentId (tam dizin) |
| Yeni üretim | `2026-10-12T08:51:44Z`, 337 dosya, **8.129.695** benzersiz contentId |
| Üretimler arası süre | **16,2 saat** (arada `2026-10-12T00:35:46Z` üretimi var: 7,94 sa + 8,27 sa) |
| Değişmeyen | **8.025.083** |
| Eklenen | **104.612** (eski toplamın %1,287'si) |
| Silinen | **100.970** (%1,243) |
| Toplam değişim (eklenen + silinen) | **205.582 → %2,53** |
| Net değişim | +3.642 |
| İki üretimin birleşimi | 8.230.665 benzersiz contentId |

Karşılaştırma: `scripts/trendyol-sitemap-compare.ts full-index 2026-10-12T08:51:44Z-v2`. En yüksek bellek
kullanımı 156 MB.

**Bütünlük kontrolleri:**
- Yeni üretimdeki 337 dosyanın tamamı `</urlset>` ile kapanıyor.
- Her dosyada `<url>` blok sayısı, kimlik + ret sayısına eşit. Toplam 8.129.695 URL, 8.129.695 kimlik, **0 ret**.
- Dosyalar arası yinelenen kimlik yok (URL sayısı = benzersiz kimlik sayısı).
- Bitişte `lastmod` yeniden kontrol edildi ve değişmemişti.
- Yarım (`.part`) dosya yok.

**Ek bulgu:** Önceki iki gözlemde sitemap'te olmayan iPhone Çöl Titanyum (`857296094`) bu üretimde **var**.
Yani eksiklik kalıcı değil, geçiciydi. Diğer referanslar da yeni üretimde var: 857296083, 813659620, 312097758.

**Yorum:** 16 saatte ürünlerin yaklaşık %1,3'ü sitemap'e girdi, %1,2'si çıktı. Bu, iki ölçüm noktasına
dayanır; **günlük ortalama ya da üretim başına sabit oran değildir**. Ara üretim (00:35) tam
indirilemediği için 8 saatlik aralıkların ayrı ayrı katkısı bilinmiyor.

## Ara üretim (00:35:46Z): tamamlanamadı

1. **İlk deneme (eski betik):** 262/336 dosyada durdu. Claude Code, oturum boştayken sistem belleği kritik
   düştüğü için arka plan işlemini sonlandırdı.
2. **İkinci deneme (yeni betik):** 50/336 dosyada sürüm değişikliğini (08:51:44Z) yakaladı ve **durdu**;
   üretimler birleştirilmedi.

Bu klasörler silinmedi:
- `…/2026-10-12T00-35-46Z/` (262 dosya, eski biçim)
- `…/2026-10-12T00-35-46Z-v2/` (50 dosya)

Yalnızca kısmi süreklilik hesabı için kullanılabilirler (%99,914).

## Bellek sorunu: neden ve çözüm

- **Neden (ölçüm):** 15,7 GB RAM'in yalnızca 0,8–1,4 GB'ı boştu, commit edilmiş bellek ~29 GB'tı. Belleği
  diğer uygulamalar tüketiyordu (Chrome ~2,2 GB, ChatGPT 1,5 GB, Claude oturumları 1,3 GB, VS Code 1,0 GB,
  Notion 0,95 GB, WSL ~2,5 GB özel bellek, başka bir worktree'de `tsc` 623 MB). İndirme süreci ~240 MB'tı;
  bellek baskısının kaynağı değil, Claude Code'un boş oturumdaki koruması onu sonlandırdı. Diğer süreçlere
  dokunulmadı; koruma devre dışı bırakılmadı.
- **Çözüm (kod):**
  - `trendyol-sitemap-snapshot.ts` akışlı: 45 MB XML belleğe tek metin olarak alınmıyor, `</url>` bloklarıyla
    işleniyor, kimlikler doğrudan diske yazılıyor. `--max-old-space-size=128`.
  - Atomik dosya yazımı (`.part` → yeniden adlandırma).
  - `progress.json` kontrol noktası: dosya başına kimlik/URL/ret/bayt/kapanış ve en yüksek RSS. Aynı sürümde
    güvenli devam.
  - Sürüm kontrolü her 25 dosyada ve bitişte.
  - 403/429'da durur. Ağ hatasında 60 sn sonra tek deneme.
  - `trendyol-sitemap-compare.ts`: JS dizisi/Set yerine büyüyen `Uint32Array`, yerinde sıralama ve tekilleştirme.
- **Ölçülen fark:**
  - İndirme RSS: ~240 MB (eski) → **70–86 MB** (yeni).
  - Karşılaştırma: 8,1 milyon + 8,1 milyon kimlik **156 MB** ile işlendi (eski Set yaklaşımı ölçülmedi).
- Çalışma sırasında oturum aktif tutuldu (ilerleme ve bellek 10 dk aralıklarla izlendi). Yeni sürümün indirmesi
  kesintisiz bitti.

## Fiyat doğrulama düzeltmesi (önceki tur)

`price-observation.ts` sonuçları yalnızca `equal`, `differs` ya da `not-comparable`. Aritmetik uyum ve gözlenen
etiketler `verified: false` ipuçlarıdır; matematikten kampanya sonucu çıkarılmaz.
