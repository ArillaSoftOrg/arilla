/**
 * Pazarama SEO sayfa dizini: `sitemaps/marka-ve-kategoriler` (~435 bin) ve
 * `sitemaps/kategori-ve-filtreler` (~400 bin) adreslerinden yalnizca YOL saklanir
 * (urun verisi degil). robots.txt bu yollari yasaklamaz; `?sayfa=` acikca izinlidir.
 * Sorgu -> marka+kategori sayfasi eslemesi burada yapilir; urunler sorgu aninda okunur.
 */

import { tokenize } from "../live-search-browser/match.ts";

/** Sitemap XML'inden `<loc>` yollari (alan adi atilmis). */
export function sitemapPaths(xml: string, origin: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const loc = (m[1] ?? "").replace(/&amp;/g, "&");
    if (loc.startsWith(origin)) out.push(loc.slice(origin.length));
  }
  return out;
}

/** Dizine giren sitemap aileleri (`scripts/pazarama-seo-index.ts` ile yeniden uretilir). */
export const SEO_FAMILIES = [
  "kategoriler",
  "marka-ve-kategoriler",
  "kategori-ve-filtreler",
] as const;

/** Dizin dosyasi: satir basina bir yol; `#` ile baslayan satirlar ust bilgi. */
export function loadSeoIndex(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.startsWith("/"));
}

const CONDITION_SLUGS = new Set(["yenilenmis", "teshir", "ikinci", "outlet"]);
const CHILD_WORDS = new Set(["cocuk", "bebek", "kiz", "genc"]);
/** Bas ismin turunu degistiren niteleyiciler (yalnizca canlida goruleni; genisletilebilir). */
const TYPE_MODIFIERS = new Set(["takim"]);
/** Aksesuar/yedek parca kategori sozcukleri: sorgu istemedikce bu sayfalar aday degil. */
const ACCESSORY_SLUG_STEMS = [
  "aksesuar",
  "yedek",
  "parca",
  "kilif",
  "koruyucu",
  "tutucu",
  "sarj",
  "kablo",
  "kayis",
  "ped",
  "filtre",
  "batarya",
  "aparat",
  "canta",
];

export interface SeoCandidate {
  path: string;
  score: number;
}

/**
 * Kategori kaniti: ayni aramanin CANLI sonuclarindan (model cagrisi yok, CLAUDE.md kural 1):
 *  - sorgu sozcukleri (en yuksek agirlik),
 *  - HB/CS'de kati eslesen urun basliklari,
 *  - CicekSepeti `categoryTree` adlari (derin kategori: "Spor Ayakkabi", "Kulaklik").
 * `brands`: eslesen basliklarin ilk sozcukleri ("Apple iPhone 16 Pro" -> apple).
 */
export interface CategoryEvidence {
  weights: Map<string, number>;
  /** Eslesen basliklarin ilk sozcukleri, siklik sirasinda. */
  brands: string[];
  dominantBrand: string | null;
  titleCount: number;
}

/**
 * `facetNames`: magazanin UST duzey kategori faseti (HB: "Telefon", "Spor / Outdoor").
 * Yalnizca derin kategori kaniti (CS) yoksa ve dusuk agirlikla kullanilir: canlida
 * "Adidas Samba" icin "Spor / Outdoor" faseti "outdoor-ayakkabi" sayfasini sectirmisti;
 * iPhone'da ise CS eslesmesi olmadigindan "Telefon" tek kategori kanitiydi.
 */
export function buildEvidence(
  query: string,
  matchedTitles: readonly string[],
  categoryNames: readonly string[],
  facetNames: readonly string[] = [],
): CategoryEvidence {
  const weights = new Map<string, number>();
  const add = (tok: string, w: number) => {
    if (tok.length < 3 || /^\d+$/.test(tok)) return;
    weights.set(tok, (weights.get(tok) ?? 0) + w);
  };
  if (categoryNames.length === 0 && matchedTitles.length > 0 && facetNames.length > 0) {
    const fw = 2 / facetNames.length;
    for (const name of facetNames) for (const t of new Set(tokenize(name))) add(t, fw);
  }
  for (const t of tokenize(query)) add(t, 5);
  const titleW = matchedTitles.length > 0 ? 3 / matchedTitles.length : 0;
  for (const title of matchedTitles) for (const t of new Set(tokenize(title))) add(t, titleW);
  // Eslesen baslik yoksa CS kategori adlari ESLESMEYEN urunlerden gelir (canli: iPhone sorgusunda
  // "Akilli Saat" sayfayi secti) -> kanit sayilmaz; zayif kanitla tahmin yerine SEO yolu bos kalir.
  const catW = categoryNames.length > 0 && matchedTitles.length > 0 ? 4 / categoryNames.length : 0;
  // "Elbise, Tunik, Abiye" bir SECENEK listesidir: her secenek agirligi paylasir
  // (canli: "abiye" tam agirlik alip "Siyah kadin elbise"yi abiye sayfasina gotururdu).
  for (const name of categoryNames) {
    const parts = name.split(/[,/&]| ve /).filter((p) => p.trim());
    for (const part of parts) for (const t of new Set(tokenize(part))) add(t, catW / parts.length);
  }
  const brandCount = new Map<string, number>();
  for (const title of matchedTitles) {
    const first = tokenize(title)[0];
    if (first) brandCount.set(first, (brandCount.get(first) ?? 0) + 1);
  }
  const sorted = [...brandCount.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  // Baskin marka: eslesen basliklarin en az %60'i ayni sozcukle basliyor (en az 2 baslik).
  const dominantBrand = top && top[1] >= 2 && top[1] / matchedTitles.length >= 0.6 ? top[0] : null;
  return {
    weights,
    brands: sorted.map(([b]) => b),
    dominantBrand,
    titleCount: matchedTitles.length,
  };
}

/** Turkce ek toleransi: 5+ harfli sozcukte ilk 5 harf ("kulaklik"/"kulakligi", "elbise"/"elbisesi"). */
function stemKey(w: string): string {
  return w.length >= 5 ? w.slice(0, 5) : w;
}

function weightOf(word: string, ev: CategoryEvidence): number {
  let best = 0;
  for (const [tok, w] of ev.weights) {
    if (tok === word || (word.length >= 5 && tok.length >= 5 && stemKey(tok) === stemKey(word))) {
      best = Math.max(best, w);
    }
  }
  return best;
}

const SEO_PATH =
  /^\/(?:([a-z0-9-]+)\/)?([a-z0-9-]+)-k-[A-Za-z0-9]+(?:\?([a-z0-9-]+)=([a-z0-9-]+)&ft)?$/;

interface SeoEntry {
  path: string;
  brand: string | null;
  cat: string[];
  filterKey: string | null;
  filterVal: string[] | null;
}

/**
 * Dizin BIR KEZ ayristirilir ve markaya gore gruplanir (Faz 3: her sorguda 792 bin yolu
 * yeniden regex'le taramak ~400 ms suruyordu). Markasiz giris anahtari `""`.
 */
export interface PreparedSeoIndex {
  byBrand: Map<string, SeoEntry[]>;
  /** Kategori adlarinda gecen tum sozcukler (sorgunun bas isminin kategori olup olmadigi). */
  catWords: Set<string>;
  size: number;
}

export function prepareSeoIndex(paths: readonly string[]): PreparedSeoIndex {
  const byBrand = new Map<string, SeoEntry[]>();
  const catWords = new Set<string>();
  let size = 0;
  for (const path of paths) {
    const m = SEO_PATH.exec(path);
    if (!m) continue;
    const entry: SeoEntry = {
      path,
      brand: m[1] ?? null,
      cat: (m[2] as string).split("-"),
      filterKey: m[3] ?? null,
      // "siyah-siyah" gibi tekrarlar tek sayilir (canli: fazladan filtre puani aliyordu).
      filterVal: m[4] ? [...new Set(m[4].split("-"))] : null,
    };
    for (const w of entry.cat) catWords.add(w);
    const key = entry.brand ?? "";
    const list = byBrand.get(key);
    if (list) list.push(entry);
    else byBrand.set(key, [entry]);
    size += 1;
  }
  return { byBrand, catWords, size };
}

/** Sorguda yoksa notr: ne puan ne ceza ("Adidas Samba" icin kadin VE erkek sneaker esit). */
const GENDER_WORDS = new Set(["kadin", "erkek", "unisex"]);
/** Aksesuar kokuyle baslayan urun nitelikleri ("sarjli-dikey-supurge" bir urun kategorisidir). */
const PRODUCT_ATTRIBUTE_SLUGS = new Set(["sarjli", "sarjsiz"]);

/**
 * Sorgu + canli kanit -> en iyi SEO sayfalari (en cok `limit`, farkli temel kategoriler).
 * Marka varsa marka+kategori sayfalari; ayrica sorgu/kanitla eslesen FILTRE sayfalari
 * ("?model=v15-detect", "?tema=technic", "?renk=siyah") ayni listede yarisir.
 * Aksesuar/yedek parca, durum ve tur degistiren kategoriler sorguda istenmedikce elenir.
 */
export function rankSeoPages(
  query: string,
  index: readonly string[] | PreparedSeoIndex,
  ev: CategoryEvidence,
  opts: { limit?: number } = {},
): SeoCandidate[] {
  const prepared = Array.isArray(index)
    ? prepareSeoIndex(index as readonly string[])
    : (index as PreparedSeoIndex);
  const limit = opts.limit ?? 3;
  const q = tokenize(query);
  const qset = new Set(q);
  // Marka adaylari (canli testte "pro", "siyah", "air" Pazarama'da AYRI markalardir):
  // sorgudaki marka sozcugu ancak eslesen basliklarla tutarliysa (ya da baslik yoksa) aday;
  // ayrica basliklarda baskin marka ("Apple iPhone ...").
  const queryBrandWords = new Set<string>();
  for (const t of q) {
    if (prepared.byBrand.has(t) && (ev.titleCount === 0 || ev.brands.includes(t))) {
      queryBrandWords.add(t);
    }
  }
  if (ev.dominantBrand && prepared.byBrand.has(ev.dominantBrand)) {
    queryBrandWords.add(ev.dominantBrand);
  }
  const wantsAccessory = q.some((w) => ACCESSORY_SLUG_STEMS.some((s) => w.startsWith(s)));
  // Bas isim: sorgunun son harfli sozcugu dizinde bir KATEGORI sozcuguyse ("elbise"), aday
  // kategori onu icermeli (canli: "Siyah kadin elbise" -> "kadin-gomlek?renk=siyah" secilmisti).
  const last = [...q].reverse().find((w) => /^[a-z]{4,}$/.test(w));
  const headNoun = last && !queryBrandWords.has(last) && prepared.catWords.has(last) ? last : null;

  let bestBrand: SeoCandidate[] = [];
  for (const brand of queryBrandWords) {
    const ranked = scoreFor(prepared.byBrand.get(brand) ?? [], brand);
    const top = Math.max(0, ...ranked.map((r) => r.score));
    if (top > Math.max(0, ...bestBrand.map((r) => r.score))) bestBrand = ranked;
  }
  const noBrand = scoreFor(prepared.byBrand.get("") ?? [], null);
  // Marka acikca soyleniyorsa marka sayfalari tercih edilir (canli: "Dyson V15" markasiz kipte
  // "elektronova"ya gidiyordu); markasiz kipten yalnizca FILTRE sayfalari ayni listeye girer
  // (model/tema/renk filtresi ozgul kanittir: "?model=v15-detect").
  const pool =
    bestBrand.length === 0
      ? noBrand
      : [...bestBrand, ...noBrand.filter((c) => c.path.includes("?"))];
  const seen = new Set<string>();
  return pool
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .filter((c) => {
      // Ayni temel kategori + ayni tur (filtreli/filtresiz) tek sayfa: filtre varyantlari
      // ayni urunleri tekrar getirir.
      const base = c.path.split("?")[0] ?? "";
      if (seen.has(base)) return false;
      seen.add(base);
      return true;
    })
    .slice(0, limit);

  function scoreFor(entries: readonly SeoEntry[], brand: string | null): SeoCandidate[] {
    const out: SeoCandidate[] = [];
    for (const e of entries) {
      if (brand && e.filterKey) continue;
      // Marka sozcukleri kategori puanina katilmaz: "/sony/sony-k-..." ve markasiz kipte
      // "/sony-k-K09195" (canli: Sony WH-1000XM5 bu sayfaya gitmisti) yalnizca markadir.
      const cat = e.cat.filter((w) => w !== brand && !queryBrandWords.has(w));
      if (cat.length === 0) continue;
      if (cat.some((w) => CONDITION_SLUGS.has(w) && !qset.has(w))) continue;
      if (headNoun && !cat.some((w) => w === headNoun || stemKey(w) === stemKey(headNoun)))
        continue;
      if (
        !wantsAccessory &&
        cat.some(
          (w) =>
            !PRODUCT_ATTRIBUTE_SLUGS.has(w) && ACCESSORY_SLUG_STEMS.some((s) => w.startsWith(s)),
        )
      ) {
        continue;
      }
      const fVal = e.filterVal;
      if (fVal) {
        // Filtre degeri sorgudan en az bir sozcuk icermeli; kalan sozcukler sorguda ya da
        // eslesen basliklarda guclu kanitla gecmeli ("v15-detect": "detect" basliklarda var).
        // Yalnizca sayidan olusan eslesme sayilmaz ("Air Force 1" -> "?bedenyas=1").
        if (!fVal.some((w) => qset.has(w) && !/^\d+$/.test(w))) continue;
        if (!fVal.every((w) => qset.has(w) || weightOf(w, ev) >= 1)) continue;
        // Kategori adini tekrarlayan filtre bilgi tasimaz ("abiye-elbise?mevsim=elbise").
        if (fVal.every((w) => cat.includes(w))) continue;
      }
      // Kategori adindaki sayi sorguda olmali ("playstation-4-konsol" "PlayStation 5" degil).
      const digits = cat.filter((w) => /^\d+$/.test(w));
      if (digits.some((d) => !qset.has(d))) continue;
      // Urun turunu degistiren niteleyici sorguda yoksa kategori aday degil ("kadin-takim-elbise").
      if (cat.some((w) => TYPE_MODIFIERS.has(w) && !qset.has(w))) continue;
      const words = cat.filter((w) => !/^\d+$/.test(w) && (qset.has(w) || !GENDER_WORDS.has(w)));
      const matched = words.reduce((s, w) => s + weightOf(w, ev), 0) + 2 * digits.length;
      if (matched <= 0) continue;
      const unmatched = words.filter((w) => weightOf(w, ev) === 0).length;
      const filterBonus = fVal ? fVal.reduce((s, w) => s + (qset.has(w) ? 2 : 1), 0) : 0;
      // Cocuk/bebek kategorileri sorguda istenmedikce yetiskinin onune gecmez
      // (canli: "Adidas Samba" -> "kiz-cocuk-spor-ayakkabi-sneaker" secilmisti).
      const childPenalty = cat.some((w) => CHILD_WORDS.has(w) && !qset.has(w)) ? 0.5 : 1;
      // Kanitta karsiligi olmayan kategori sozcugu urun turunu degistirebilir (ceza).
      const score = (matched / (1 + 0.8 * unmatched) + filterBonus) * childPenalty;
      out.push({ path: e.path, score: Math.round(score * 100) / 100 });
    }
    return out;
  }
}
