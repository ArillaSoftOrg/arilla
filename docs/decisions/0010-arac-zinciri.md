# 0010 — Biome, ham TypeScript paketler, `@arilla/*` ad alanı

**Tarih:** 2026-09 · **Durum:** kabul edildi

## Karar

Monorepo iskeleti (A1) üç araç zinciri kararıyla kuruldu:

1. **Lint ve format: Biome.** Tek araç, tek yapılandırma dosyası (`biome.json`).
2. **`packages/*` ham TypeScript dışa aktarır.** Derleme adımı yoktur; her
   paketin `build` betiği `tsc -p tsconfig.json` ile yalnızca tip kontrolü
   yapar (`noEmit`). `apps/web` bu paketleri `transpilePackages` ile derler.
3. **Paket ad alanı `@arilla/*`.** `@arilla/db`, `@arilla/core`, `@arilla/ui`,
   `@arilla/web`.

## Gerekçe

**Biome:** ESLint + Prettier kurulumu altı-sekiz devDependency, iki ayrı
yapılandırma ve flat config geçiş yükü getiriyor. Biome ikisini tek araçta
topluyor. Bedeli `eslint-config-next`in Next'e özgü kurallarının kaybı; bu
kuralların yakaladığı hataların çoğunu `next build` sırasındaki TypeScript
kontrolü zaten yakalıyor.

**Ham TypeScript paketler:** `dist/` üretmek her pakete bir derleme adımı, bir
`outDir` ve bir izleme kipi ekler. Ham kaynak dışa aktarıldığında `pnpm build`
paketler için sadece tip kontrolü, `apps/web` için tek bir `next build`
oluyor. Bedeli: Next bundler'ı olmayan bir istemci (`apps/mcp`, ileride
`apps/api`) kendi derleme kurulumunu getirmek zorunda. O gün geldiğinde `tsx`
veya o uygulamanın kendi bundler'ı yeterli.

**`@arilla/*`:** `infra/docker-compose.yml` zaten `arilla` proje adını ve
`arilla-*` konteyner adlarını kullanıyor. Alan adı değişebilir ama şirket adı
(bkz. `0008`) sabit.

## Reddedilen alternatifler

- **ESLint + Prettier:** yaygın standart, ama bağımlılık ve yapılandırma yükü
  bu depo büyüklüğünde karşılığını vermiyor.
- **`tsc` ile `dist/` üreten paketler:** daha taşınabilir, ama bugün tek
  istemci `apps/web` ve o Next bundler'ını zaten çalıştırıyor.
- **Turborepo:** `pnpm -r build` bağımlılık sırasına göre zaten topolojik
  çalışıyor. Dört paketlik bir depoda önbellek katmanı erken.

## Sonucu

- Kök betikler: `pnpm build`, `pnpm dev`, `pnpm typecheck`, `pnpm lint`,
  `pnpm format`.
- `services/ingest` workspace üyesi değildir (Python). Kendi `pyproject.toml`
  dosyası ve ruff yapılandırması vardır.
- Bu karar `apps/mcp` eklenirken yeniden değerlendirilir: o uygulama ham TS
  paketleri sorunsuz tüketemiyorsa `dist/` üretimine geçilir.
