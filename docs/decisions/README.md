# Kararlar (ADR) — numaralandırma

**Kural:** `docs/decisions` altında bir numara yalnızca **bir** karar için kullanılır.
`pnpm check:adr` (`scripts/check-adr-numbers.mjs`) bunu denetler.

**Migration numaralarıyla karıştırılmaz.** `packages/db/migrations/NNNN_*.sql`
(defter kimliği = dosya adı) ayrı bir numara uzayıdır; bir migration yorumu karar
numarasına atıf yapabilir, eşleşmek zorunda değildir. Uygulanmış migration dosyalarına
(0049, 0051 ...) karar numarası değişikliği için DOKUNULMAZ; ADR dosyası "eski numara"
notunu taşır.

## Tahsis (2026-10-07)

| No | Karar | Durum / yer |
| --- | --- | --- |
| 0060–0063 | hesap sayfası, SSS, R2 medya, Shopify aktivasyonu | `main` |
| 0064 | Shopify kanonik alan adı | `feature/shopify-canonical-domains` (birleşmedi) |
| 0065 | erken erişim sayacı | `main` |
| 0066 | yapay zekasız arama fallback | `main` |
| **0067** | chunk'lı, checkpoint'li toplama | Shopify dalı — **şu an 0065**; yeniden numaralanacak (aşağıda) |
| **0068** | toplu eşleştirme (resolve) | Shopify dalı — **şu an 0066**; yeniden numaralanacak |
| 0069 | deterministik fiyat ifadeleri | bu dal |
| 0070 | (öneri) blog yazı sayfaları | `main` çalışma kopyasında izlenmeyen `0064-blog-yazi-sayfalari.md` Shopify 0064 ile çakışır; commit edilmeden önce 0070 yapılmalı |

## Çakışma: `main` ↔ Shopify dalı (0065, 0066)

`main`'de `0065-erken-erisim-sayaci` ve `0066-yapay-zekasiz-arama-fallback` var; Shopify
dalında `0065-chunkli-checkpointli-toplama` ve `0066-toplu-eslestirme`. Birleştirmeden
ÖNCE Shopify tarafı yeniden numaralanır (`main` tarafı yayında ve kodda atıflı):

1. `git mv docs/decisions/0065-chunkli-checkpointli-toplama.md docs/decisions/0067-chunkli-checkpointli-toplama.md`
   ve `0066-toplu-eslestirme.md` → `0068-toplu-eslestirme.md`.
2. Dalın `main`'e göre değiştirdiği dosyalarda (`git diff --name-only origin/main...HEAD`),
   **`packages/db/migrations/` hariç**, `\b0065\b` → `0067` ve `\b0066\b` → `0068`
   (kendi taraflarına ait atıflar; 21 dosya, 38 atıf). Aynı dönüşümü birleştirilmiş ağaçta
   yapmak `main`'in kendi 0065/0066 atıflarını da bozar; yalnızca dal ağacında yapılır.
3. `packages/db/migrations/0051_*.sql` ve `0049_*.sql` (uygulanmış) ile `renamed.json`'a
   DOKUNULMAZ; içlerindeki "0065" anıları ADR'nin eski numarasıdır. ADR dosyasının başına
   "Eski numara: 0065" notu eklenir.
4. `pnpm check:adr` → benzersiz.

**Kuru çalışma (kanıt):** Shopify dalının ucu (`2403ab4`) atılabilir bir ağaçta bu dönüşümle
yeniden numaralandı, `origin/main` bu ağaca birleştirildi: tek çatışma `migrations/README.md`
tablo satırları (docs; numaralamayla ilgisiz); ADR numaraları benzersiz (0064–0068);
`0065`/`0066` kalan atıflar yalnızca `main`'e ait (erken erişim, fallback); `check:adr`
başarılı. Dönüşüm yapılmazsa `check:adr` 0065 ve 0066 için başarısız olur.
