# Kararlar (ADR) — numaralandırma

**Kural:** `docs/decisions` altında bir numara yalnızca **bir** karar için kullanılır.
`pnpm check:adr` (`scripts/check-adr-numbers.mjs`) bunu **tek bir ağaçta** denetler.
Birleşmemiş dallar arasındaki çakışmayı denetlemez; yeni numara almadan önce
bütün dallara bakılır (aşağıdaki komut).

**Migration numaralarıyla karıştırılmaz.** `packages/db/migrations/NNNN_*.sql`
(defter kimliği = dosya adı) ayrı bir numara uzayıdır; bir migration yorumu karar
numarasına atıf yapabilir, eşleşmek zorunda değildir. Uygulanmış migration dosyalarına
(0049, 0051 ...) karar numarası değişikliği için DOKUNULMAZ; ADR dosyası "eski numara"
notunu taşır.

## Tahsis (2026-10-07, tüm yerel/uzak dallar taranarak)

| No | Karar | Durum / yer |
| --- | --- | --- |
| 0060–0063 | hesap sayfası, SSS, R2 medya, Shopify aktivasyonu | `main` |
| 0064 | Shopify kanonik alan adı | `feature/shopify-canonical-domains` (birleşmedi) |
| 0065 | erken erişim sayacı | `main` |
| 0066 | yapay zekasız arama fallback | `main` |
| 0067 | okunabilir davet kodu ve son bakılanlar | `feature/account-recents-referral` (push'lu, birleşmedi) |
| **0068** | chunk'lı, checkpoint'li toplama | Shopify dalı — dalda **hâlâ 0065**; yeniden numaralanacak |
| **0069** | toplu eşleştirme (resolve) | Shopify dalı — dalda **hâlâ 0066**; yeniden numaralanacak |
| 0070 | deterministik fiyat ifadeleri | bu dal |
| 0071 | (öneri) blog yazı sayfaları | `main` çalışma kopyasında izlenmeyen `0064-blog-yazi-sayfalari.md` Shopify 0064 ile çakışır; commit edilmeden önce yeniden numaralanmalı |

**Durum notu:** 0068/0069, Shopify dalındaki iki ADR için **ayrılmıştır** (0067 başka bir dalda
alındığı için 0067 olamaz). Bu dosya yazılırken (Shopify ucu `6d11822`) Shopify dalında yeniden
numaralama `origin`'de ve yerel dalda HENÜZ görünmüyordu: ADR'ler hâlâ 0064/0065/0066. Dal sahibi
farklı numara seçtiyse bu tablo ve 0070 yeniden doğrulanmalıdır.

Boş numara bulmak için (birleştirmeden önce çalıştırılır):

```
for r in $(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes); do
  git ls-tree --name-only $r docs/decisions/ | sed "s#docs/decisions/##;s#-.*##"; done | sort -u | tail
```

## Çakışma: `main` ↔ Shopify dalı (0065, 0066)

`main`'de `0065-erken-erisim-sayaci` ve `0066-yapay-zekasiz-arama-fallback` var; Shopify
dalında `0065-chunkli-checkpointli-toplama` ve `0066-toplu-eslestirme`. Birleştirmeden
ÖNCE Shopify tarafı yeniden numaralanır (`main` tarafı yayında ve kodda atıflı):

1. `git mv docs/decisions/0065-chunkli-checkpointli-toplama.md docs/decisions/0068-chunkli-checkpointli-toplama.md`
   ve `0066-toplu-eslestirme.md` → `0069-toplu-eslestirme.md`.
2. Dalın `main`'e göre değiştirdiği dosyalarda (`git diff --name-only origin/main...HEAD`),
   **`packages/db/migrations/` hariç**, `\b0065\b` → `0068` ve `\b0066\b` → `0069`
   (kendi taraflarına ait atıflar; 21 dosya, 38 atıf). Aynı dönüşümü birleştirilmiş ağaçta
   yapmak `main`'in kendi 0065/0066 atıflarını da bozar; yalnızca dal ağacında yapılır.
3. `packages/db/migrations/0051_*.sql` ve `0049_*.sql` (uygulanmış) ile `renamed.json`'a
   DOKUNULMAZ; içlerindeki "0065" anıları ADR'nin eski numarasıdır. ADR dosyasının başına
   "Eski numara: 0065" notu eklenir.
4. `pnpm check:adr` → benzersiz.

**Kuru çalışma (kanıt):** Shopify ucu `2403ab4` üzerinde, o gün planlanan numaralarla
(0067/0068; mekanizma aynı) atılabilir bir ağaçta dönüşüm uygulandı, `origin/main`
birleştirildi: tek çatışma `migrations/README.md` tablo satırları (docs; numaralamayla
ilgisiz); ADR numaraları benzersiz; kalan `0065`/`0066` atıfları yalnızca `main`'e ait
(erken erişim, fallback); `check:adr` başarılı. Dönüşüm yapılmazsa `check:adr` birleşik
ağaçta 0065 ve 0066 için başarısız olur.
