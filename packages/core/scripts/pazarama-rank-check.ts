/**
 * Cevrimdisi SEO sayfasi secimi kontrolu: gercek dizin + canli turda (2026-10-12) gorulen
 * baslik/kategori kaniti. Ag istegi ATMAZ.
 *   node --experimental-transform-types --no-warnings scripts/pazarama-rank-check.ts <dizin.txt>
 */

import { readFileSync } from "node:fs";
import {
  buildEvidence,
  loadSeoIndex,
  prepareSeoIndex,
  rankSeoPages,
} from "../src/pazarama-discovery/seo-index.ts";

const t0prep = performance.now();
const paths = prepareSeoIndex(loadSeoIndex(readFileSync(process.argv[2] ?? "", "utf8")));
console.log(`prepare: ${Math.round(performance.now() - t0prep)} ms, ${paths.size} entries`);

const cases: { q: string; titles: string[]; cats: string[] }[] = [
  {
    q: "iPhone 16 Pro 128 GB",
    titles: [
      "Apple iPhone 16 Pro 128GB Çöl Titanyum",
      "Apple iPhone 16 Pro 128GB Natürel Titanyum",
      "Apple iPhone 16 Pro 128GB Siyah",
    ],
    cats: ["Telefon"],
  },
  {
    q: "Adidas Samba",
    titles: [
      "adidas Samba OG FA24 Kadın Spor Ayakkabı",
      "adidas Samba OG Unisex Siyah Spor Ayakkabı",
      "Adidas Samba Og W Kadın Günlük Ayakkabı IH9052 Siyah",
      "ADİDAS SAMBA XLG BLACK WHİTE GUM",
    ],
    cats: ["Spor Ayakkabı", "Sneaker", "Giyim / Ayakkabı"],
  },
  {
    q: "Nike Air Force 1",
    titles: [
      "Nike Aır Force 1'07 Unisex Snaker Ayakkabı",
      "NIKE WMNS AIR FORCE 1 SHADOW KADIN SPOR AYAKKABI",
      "Nike Air Force 1 ’07 Lx Erkek Spor Ayakkabı",
    ],
    cats: ["Spor Ayakkabı", "Sneaker", "Giyim / Ayakkabı"],
  },
  {
    q: "Sony WH-1000XM5",
    titles: [
      "Sony WH-1000XM5 Tamamen Kablosuz Gürültü Engelleme Özellikli Kulaklık-Gümüş",
      "Sony WH-1000XM5 Kulak Üstü Bluetooth Kulaklık Siyah",
      "Sony WH-1000XM5 Bluetooth Kulaklık",
    ],
    cats: ["Telefon"],
  },
  {
    q: "Siyah kadın elbise",
    titles: [
      "Fabrika Gömlek Yaka Düz Siyah Kadın Elbise DIVINE Kloş",
      "Avver Kadın Siyah Astarlı Kruvaze Şifon Elbise",
      "Kadın Siyah Mini Askılı Straplez Elbise",
    ],
    cats: ["Elbise, Tunik, Abiye", "Elbise", "Giyim / Ayakkabı"],
  },
  {
    q: "PlayStation 5",
    titles: [
      "Sony Playstation 5 Slim Digital 825 GB Oyun Konsolu",
      "Sony Playstation 5 Slim Cd'li 1 TB Oyun Konsolu",
      "Sony PlayStation 5 Fat Kasa CD'li Sürüm Tek Kol Oyun Konsolu",
    ],
    cats: ["Oyun Konsolları", "PlayStation 5", "Oyun & Oyun Konsolları"],
  },
  {
    q: "Dyson V15",
    titles: [
      "Dyson V15 Detect™ Absolute Kablosuz Süpürge",
      "Dyson V15 Detect™ Absolute Kablosuz Süpürge EOL",
    ],
    cats: ["Ev Elektroniği"],
  },
  {
    q: "Lego Technic",
    titles: [
      "LEGO ® Technic Güçlü Makineler 42233 - 7 Yaş ve Üzeri Çocuklar için",
      "LEGO 42231 Technic Fast and Furious Dodge Charger R/T Araba",
      "LEGO Technic 30710 Skid-Steer Loader",
    ],
    cats: ["Lego & Yapı Oyuncakları", "Oyuncak"],
  },
];

for (const c of cases) {
  const t0 = performance.now();
  const ranked = rankSeoPages(c.q, paths, buildEvidence(c.q, c.titles, c.cats));
  console.log(
    `${c.q} -> ${ranked.map((r) => `${r.path} (${r.score})`).join(" | ") || "-"} [${Math.round(performance.now() - t0)} ms]`,
  );
}
