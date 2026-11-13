# 0192 — Editoryal yüzeyler, footer ve vurgu renkleri nötr

Durum: **kabul**. Yalnızca renk belirteçlerinin değeri ve bileşenlerin hangi belirteci kullandığı
değişir; işlevsel kod, metinler ve bileşen yapısı aynı kalır. 0191'in nötr açık temasının
devamıdır. İlgili: 0026, 0084, 0093, 0191.

## Bağlam

0191 ana zeminleri nötr beyaz/griye çekti, ama birkaç renk ailesi eski kaldı:

- Sıcak bej editoryal zemin ve krem kart (`--warm-page`, `--warm-card`), yeşilimsi footer
  (`--footer-canvas`), sıcak kullanım kartı tonu (`--tint-warm`).
- İki footer iki ayrı marka dili konuşuyordu: `SiteFooter` limon kelime işareti, `EditorialFooter`
  (`/hakkinda`, `/blog`, `/ortakliklar`) açık mavi (`--teal-soft`) kelime işareti ve sayfa zemini.
- `/ortakliklar` üç adım bölümü koyu teal (`--feature-*`); rozet, istatistik etiketi ve fayda
  ikonları teal (`--teal-*`).
- Ana sayfa "Arama yolları" kartları aqua/mist tonları (`--tint-aqua`, `--tint-mist`).
- `/sohbet/link` bekleme görselinde dekoratif `--teal-soft` → `--surface` gradyanı (design.md
  "gradyan yok" kuralıyla çelişiyordu).

## Karar

### Belirteç değerleri

| Belirteç | Açık (eski → yeni) | Koyu (eski → yeni) |
| --- | --- | --- |
| `--footer-canvas` | `#EDF0EC` → `#F4F4F4` | `#111513` → `#17191C` |
| `--tint-aqua` | `#DFF7F8` → `#F6F6F6` | `#132C30` → `#1B1E21` |
| `--tint-mist` | `#EEF6FB` → `#F2F2F2` | `#172530` → `#212428` |
| `--tint-warm` | `#F3EEE8` → `#EFEFEF` | `#26221D` → `#262A2F` |
| `--feature-bg` | `#134E66` → `#17191C` | `#0F3A49` → `#1E2125` |
| `--feature-ink-muted` | `#CFE9EF` → `#C9CDD1` | aynı |
| `--feature-accent` | `#2BD3EE` → `#B7F52F` (marka limonu) | aynı |
| `--feature-line` | `#3B7185` → `#3A3F45` | aynı |

`--tint-*` adları kartın ton anahtarıdır (`tone: "aqua" | "mist" | "warm"`); yeniden adlandırma
bileşen verisini de değiştirirdiği için yapılmadı. Üç değer aynı nötr ailenin basamaklarıdır.

### Kaldırılan belirteçler

`--warm-page`, `--warm-card`, `--teal-ink`, `--teal-soft`: depoda (CSS, TSX, satır içi stil,
dinamik sınıf) hiçbir kullanımı kalmadı. Kaldırıldı.

### Bileşenler

- `EditorialFooter`: zemin `--footer-canvas`, üst kenarlık + 88 px limon çizgi, kelime işareti
  `SiteFooter` ile aynı `--footer-wordmark-*` gradyanı, başlık `--ink-secondary`, bağlantı
  `--ink-muted` → hover/etkin sayfa `--ink`. İçerik, bağlantılar ve yerleşim değişmedi.
- `/ortakliklar`: rozet `--surface-raised` + `--line` + `--ink-secondary`; istatistik etiketi
  `--ink-secondary`; fayda ikonu `--brand` dolgu + `--on-brand` işaret; üç adım bölümü
  antrasit + limon.
- `/sohbet/link` bekleme görseli: gradyan yerine düz `--surface`.

### Kontrast (hesaplanmış, açık / koyu)

- Footer: `--ink-muted` 5.46 / 6.69, parıltının en yoğun noktasında 5.20 / 5.01, prelaunch
  5.13 / 6.20; `--line-strong` 3.35 / 4.01.
- `--feature-bg` üzerinde: `--feature-ink` 17.61 / 16.16, `--feature-ink-muted` 11.02 / 10.11,
  limon 13.52 / 12.40.
- Rozet ve istatistik etiketi (`--ink-secondary` / `--surface-raised`) 10.37 / 10.11.
- Fayda ikonu: `--on-brand` / `--brand` 14.91. Limon daire açık zeminde 1.30:1 — dekoratif
  dolgu; bilgiyi ikonun kendisi taşır (karar 0084'ün izin verdiği kullanım).
- `--tint-*` üzerinde `--ink-muted` ≥ 5.22 / 5.48 (kartlarda metin görsel alanında değil).

Değişmeyenler: `--paper`, `--surface*`, `--accent*`, `--brand`, `--save`, `--warning`,
`--alert`, `--scrim`, `--media-scrim`, footer kelime işareti renkleri, işlevsel gradyanlar
(iskelet parıltısı, yüzen arama kutusunun alt solması, maskot zemin gölgesi).

## Reddedilen alternatifler

- İki footer'ı tek bileşende birleştirmek: içerik ve yerleşim farklı (marka bloğu, sosyal
  bağlantılar, açıklama satırları); büyük refactor. Renk dili belirteç düzeyinde ortaklaştırıldı.
- `--teal-*` değerlerini griye çekip adları korumak: ad yanıltıcı olurdu; kullanım yerleri mevcut
  nötr belirteçlere bağlandı, kullanılmayan belirteçler kaldırıldı.
- Üç adım bölümünü `--accent` ile çizmek: koyu temada `--accent` açık renk olduğundan bölüm koyu
  temada parlak bir bloğa dönerdi.
