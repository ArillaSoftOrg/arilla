# 0191 — Açık tema: nötr beyaz zemin ve nötr gri palet

Durum: **kabul**. Yalnızca açık tema renk değerleri değişir; koyu tema, belirteç adları ve
bileşenler aynı kalır. Karar 0092'nin sıcak açık paletinin yerini alır (0092'nin elle tema seçimi
kısmı geçerlidir). İlgili: 0025, 0026, 0092.

## Bağlam

- Açık tema sıcak kırık beyaz zemin (`--paper #FAF8F5`) ve kahveye çalan griler kullanıyordu;
  ana metin (`--ink #16181D`) ise mavimsi siyahtı. Koyu tema tamamen soğuk nötrdü. Kullanıcı
  temayı değiştirince iki farklı marka görüyordu.
- `design.md` "Kaçınılanlar" listesinde krem zemin yer aldığı hâlde zemin krem tonundaydı.

## Karar

- `--paper #FCFCFC`, `--ink #0D0D0D`. `--accent` ve `--on-brand` `--ink`'in değerini izler
  (karar 0025); `--accent-hover #2B2B2B`.
- Ara tonlar nötr griye çekilir: `--surface #F4F4F4`, `--surface-hover #EBEBEB`,
  `--line #E5E5E5`, `--line-strong #858585`, `--ink-secondary #404040`, `--ink-muted #636363`.
- `--surface-raised` saf beyaz kalır; kartlar zeminden kenarlık ve gölgeyle ayrılır.
- E-posta açık paleti (`packages/core/src/email/theme.ts`) aynı değerleri alır.
- Kapsam dışı: editoryal (`--warm-*`, `--feature-*`, `--teal-*`), `--tint-*`, footer belirteçleri.

Kontrast (WCAG 2.2 AA, hesaplanmış): metin rollerinde en düşük `--ink-muted` / `--surface-hover`
5.04:1; `--line-strong` en düşük 3.10:1 (`--surface-hover`); `--ink` ≥ 16.3:1; `--save`,
`--warning`, `--alert` yeni zeminlerde ≥ 5.13:1. `--ink-muted` `--tint-*`, footer ve editoryal
zeminlerde eski değerden biraz daha yüksek (≥ 5.04:1).

## Reddedilen alternatif

- Yalnızca `--paper` ve `--ink`'i değiştirip sıcak ara tonları bırakmak: beyaz zeminde sıcak
  yüzeyler krem leke gibi görünür, iki temanın karakter farkı sürer.
