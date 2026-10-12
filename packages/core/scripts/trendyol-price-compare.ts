/**
 * Fiyat hipotezi raporu (05 protokolu T2/T3). Ag istegi ATMAZ.
 *
 *   node --experimental-transform-types --no-warnings scripts/trendyol-price-compare.ts [gozlem.json ...] [--skew-min 5]
 *
 * Girdi: `PriceObservation[]` JSON dosyalari (ornegin yetkili satici API'sinden ve ayni anda
 * gercek tarayicidan kaydedilmis gozlemler). Referans set (gercek tarayici gozlemleri) her zaman eklenir.
 * Cikti: her hipotez icin cift sayisi, esit/indirim/kampanya/aciklanamayan/karsilastirilamaz dagilimi.
 * Anahtar, sir veya ham API yaniti girdi dosyasina KONMAMALIDIR (yalnizca gozlem alanlari).
 */

import { readFile } from "node:fs/promises";

import {
  evaluateHypotheses,
  type PriceObservation,
} from "../src/trendyol-landing/price-observation.ts";
import { REFERENCE_OBSERVATIONS } from "../src/trendyol-landing/reference-observations.ts";

const args = process.argv.slice(2);
const skewIdx = args.indexOf("--skew-min");
const skewMin = skewIdx >= 0 ? Number(args[skewIdx + 1]) : 5;
const files = args.filter((a, i) => !a.startsWith("--") && (skewIdx < 0 || i !== skewIdx + 1));

const observations: PriceObservation[] = [...REFERENCE_OBSERVATIONS];
for (const f of files) {
  observations.push(...(JSON.parse(await readFile(f, "utf8")) as PriceObservation[]));
}

process.stdout.write(
  `gozlem: ${observations.length} (referans ${REFERENCE_OBSERVATIONS.length}), pencere ${skewMin} dk\n`,
);
for (const r of evaluateHypotheses(observations, undefined, { maxSkewMs: skewMin * 60_000 })) {
  const rate =
    r.equalRate == null
      ? "DOGRULANMADI (karsilastirilabilir cift yok)"
      : `esitlik %${(100 * r.equalRate).toFixed(0)}`;
  process.stdout.write(
    `${r.hypothesis.id} ${r.hypothesis.description}\n  cift ${r.pairs.length} | ${JSON.stringify(r.counts)} | ${rate}\n`,
  );
  for (const p of r.pairs.filter((x) => x.verdict.status !== "equal").slice(0, 5)) {
    process.stdout.write(
      `    ${p.left.contentId} ${p.left.kind}=${p.left.priceKurus} vs ${p.right.kind}=${p.right.priceKurus} -> ${JSON.stringify(p.verdict)}\n`,
    );
  }
}
