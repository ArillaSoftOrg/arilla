/**
 * Dogrulanmis adaylari urun gruplarina birlestirir (docs/decisions/0102):
 * yanlis eslesmeleri eler, tam eslesme ile benzer alternatifi ayirir, ayni
 * urunun farkli saticilardaki tekliflerini tek grupta toplar, yinelenenleri
 * ve katalogda zaten bulunan teklifleri atar. Saf ve deterministik.
 */
import { WEB_SEARCH_MAX_OFFERS_PER_GROUP, WEB_SEARCH_POOL_GROUPS } from "./config.ts";
import type { WebCandidate } from "./parse.ts";
import { asciiFold, CAPACITY_RE, extractFeatures } from "./query.ts";
import type { WebMatchKind, WebOffer, WebProductGroup, WebSearchFeatures } from "./types.ts";

const STOPWORDS = new Set([
  "ve",
  "ile",
  "icin",
  "adet",
  "fiyati",
  "fiyatlari",
  "online",
  "satis",
  "yorumlari",
  "ozellikleri",
  "kargo",
  "bedava",
  "urun",
  "orijinal",
  "yeni",
  "the",
  "and",
  "for",
]);

/** Karsilastirma icin anlamli kelimeler (ASCII katlanmis, 2+ harf). */
export function significantTokens(text: string): string[] {
  return asciiFold(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function overlapsAny(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.includes(x));
}

/** Iki kume de doluysa ve hic ortak yoksa farkli varyant. */
function disjoint(a: readonly string[], b: readonly string[]): boolean {
  return a.length > 0 && b.length > 0 && !overlapsAny(a, b);
}

function compact(text: string): string {
  return asciiFold(text).replace(/[^a-z0-9]/g, "");
}

export interface Classification {
  kind: WebMatchKind;
  /** Gruplama icin varyant imzasi. */
  features: WebSearchFeatures;
}

/**
 * Adayin aranan urunle iliskisi. `null` = yanlis eslesme, ele.
 *
 * - Marka ya da model kodu CELISIYORSA yalnizca model "benzer" demisse ve
 *   yine de ortak bir kelime varsa benzer alternatif sayilir; "ayni" diyorsa
 *   tutarsiz beyandir, elenir.
 * - Renk/beden/kapasite celisiyorsa ayni model farkli secenektir: benzer.
 * - "Ayni" beyani, aranan model kodlarinin hepsi (yoksa anlamli kelimelerin
 *   cogu) baslikta gecmiyorsa benzere indirilir.
 */
export function classifyCandidate(
  candidate: Pick<WebCandidate, "title" | "brand" | "declaredKind">,
  query: string,
  wanted: WebSearchFeatures,
): Classification | null {
  const candidateFeatures = extractFeatures(candidate.title, candidate.brand);
  const titleCompact = compact(`${candidate.brand ?? ""} ${candidate.title}`);

  const brandConflict =
    wanted.brand !== null &&
    candidateFeatures.brand !== null &&
    !compact(candidateFeatures.brand).includes(compact(wanted.brand)) &&
    !compact(wanted.brand).includes(compact(candidateFeatures.brand));
  const wantedBrandMissing =
    wanted.brand !== null &&
    candidateFeatures.brand === null &&
    !titleCompact.includes(compact(wanted.brand));

  const codesMissing = wanted.modelCodes.filter((code) => !titleCompact.includes(code));
  // Aranan model kodlarinin HICBIRI yoksa ve aday baska bir model kodu tasiyorsa farkli model.
  const modelConflict =
    wanted.modelCodes.length > 0 &&
    codesMissing.length === wanted.modelCodes.length &&
    candidateFeatures.modelCodes.length > 0;

  const queryTokens = significantTokens(query).filter((t) => t.length >= 3);
  const titleTokens = new Set(significantTokens(`${candidate.brand ?? ""} ${candidate.title}`));
  const matched = queryTokens.filter((t) => titleTokens.has(t)).length;
  const coverage = queryTokens.length === 0 ? 1 : matched / queryTokens.length;

  const variantConflict =
    disjoint(wanted.capacities, candidateFeatures.capacities) ||
    disjoint(wanted.colors, candidateFeatures.colors) ||
    disjoint(wanted.sizes, candidateFeatures.sizes);

  const features: WebSearchFeatures = {
    brand: candidateFeatures.brand ?? wanted.brand,
    modelCodes: candidateFeatures.modelCodes,
    colors: candidateFeatures.colors,
    capacities: candidateFeatures.capacities,
    sizes: candidateFeatures.sizes,
  };

  if (brandConflict || modelConflict) {
    if (candidate.declaredKind === "exact") return null;
    return matched > 0 ? { kind: "similar", features } : null;
  }
  if (variantConflict) return matched > 0 ? { kind: "similar", features } : null;
  if (candidate.declaredKind === "similar")
    return matched > 0 ? { kind: "similar", features } : null;

  // Model "ayni" diyor: kanit ara.
  const exactEvidence =
    wanted.modelCodes.length > 0
      ? codesMissing.length === 0 && !wantedBrandMissing
      : coverage >= 0.6 && !wantedBrandMissing;
  return { kind: exactEvidence ? "exact" : "similar", features };
}

interface Draft {
  kind: WebMatchKind;
  title: string;
  brand: string | null;
  tokens: Set<string>;
  features: WebSearchFeatures;
  offers: WebOffer[];
}

function sellerName(host: string): string {
  return host;
}

function offerOf(candidate: WebCandidate): WebOffer {
  return {
    id: candidate.url.key,
    seller: sellerName(candidate.url.host),
    host: candidate.url.host,
    url: candidate.url.url,
    title: candidate.title,
    priceKurus: candidate.priceKurus,
    priceStatus: candidate.priceStatus,
    inStock: candidate.inStock,
  };
}

/** Ayni saticida iki teklif varsa dogrulanmis ve dusuk fiyatlisi kalir. */
function betterOffer(a: WebOffer, b: WebOffer): WebOffer {
  if (a.priceKurus !== null && b.priceKurus !== null) return a.priceKurus <= b.priceKurus ? a : b;
  if (a.priceKurus !== null) return a;
  if (b.priceKurus !== null) return b;
  return a;
}

/** Ayni model ailesinde ayri urun yapan siniflama sozcukleri (Pro / Pro Max / Plus ...). */
const TIER_WORDS = new Set([
  "pro",
  "max",
  "plus",
  "ultra",
  "mini",
  "lite",
  "se",
  "fe",
  "air",
  "neo",
  "turbo",
  "edge",
  "prime",
]);

/**
 * Urun kimligi: marka-disi serbest sayilar (nesil: "16", "s24") ve siniflama
 * sozcukleri. Kapasite/RAM sayilari (128 GB) burada sayilmaz, varyant olarak ayri
 * degerlendirilir.
 */
function lineIdentity(text: string): { numbers: Set<string>; tiers: Set<string> } {
  const folded = asciiFold(text).replace(CAPACITY_RE, " ");
  const numbers = new Set<string>();
  const tiers = new Set<string>();
  for (const token of folded.split(/[^a-z0-9]+/)) {
    if (!token) continue;
    if (TIER_WORDS.has(token)) tiers.add(token);
    else if (/^\d{1,3}$/.test(token)) numbers.add(token);
  }
  return { numbers, tiers };
}

/**
 * Iki baslik AYNI model ailesinde mi: "iPhone 16 Pro" ile "iPhone 15 Pro" (nesil) ya da
 * "iPhone 16 Pro" ile "iPhone 16 Pro Max" (siniflama) AYRI urundur; kelime ortusmesi
 * yuksek olsa da eslestirilmez. `wanted` icindeki her sayi `other`de bulunmali,
 * siniflama sozcuk kumeleri esit olmali.
 */
export function sameProductLine(wanted: string, other: string): boolean {
  const a = lineIdentity(wanted);
  const b = lineIdentity(other);
  for (const n of a.numbers) if (!b.numbers.has(n)) return false;
  if (a.tiers.size !== b.tiers.size) return false;
  for (const t of a.tiers) if (!b.tiers.has(t)) return false;
  return true;
}

/**
 * Katalog gorseli icin sıkı varyant: renk, kapasite, beden her biri iki tarafta da bos ya da
 * ortak olmali. Baslikta rengi olmayan ilana belirli bir rengin fotografi verilmez.
 */
export function strictSameVariant(a: WebSearchFeatures, b: WebSearchFeatures): boolean {
  const agree = (x: readonly string[], y: readonly string[]) =>
    (x.length === 0 && y.length === 0) || overlapsAny(x, y);
  return agree(a.colors, b.colors) && agree(a.capacities, b.capacities) && agree(a.sizes, b.sizes);
}

export function sameVariant(a: WebSearchFeatures, b: WebSearchFeatures): boolean {
  return !(
    disjoint(a.capacities, b.capacities) ||
    disjoint(a.colors, b.colors) ||
    disjoint(a.sizes, b.sizes)
  );
}

const GROUP_SIMILARITY = 0.7;

function groupKey(draft: Draft): string {
  const body = [...draft.tokens].sort().slice(0, 8).join("-");
  return `${draft.kind}:${body}`;
}

export interface MergeInput {
  candidates: readonly WebCandidate[];
  query: string;
  features: WebSearchFeatures;
}

export function mergeWebCandidates({ candidates, query, features }: MergeInput): WebProductGroup[] {
  const drafts: Draft[] = [];
  for (const candidate of candidates) {
    const classified = classifyCandidate(candidate, query, features);
    if (classified === null) continue;
    const tokens = new Set(significantTokens(`${candidate.brand ?? ""} ${candidate.title}`));
    const offer = offerOf(candidate);
    const target = drafts.find(
      (d) =>
        d.kind === classified.kind &&
        sameVariant(d.features, classified.features) &&
        sameProductLine(
          `${d.brand ?? ""} ${d.title}`,
          `${candidate.brand ?? ""} ${candidate.title}`,
        ) &&
        sameProductLine(
          `${candidate.brand ?? ""} ${candidate.title}`,
          `${d.brand ?? ""} ${d.title}`,
        ) &&
        jaccard(d.tokens, tokens) >= GROUP_SIMILARITY,
    );
    if (target) {
      const existing = target.offers.findIndex((o) => o.host === offer.host);
      if (existing === -1) target.offers.push(offer);
      else target.offers[existing] = betterOffer(target.offers[existing] as WebOffer, offer);
      continue;
    }
    drafts.push({
      kind: classified.kind,
      title: candidate.title,
      brand: candidate.brand,
      tokens,
      features: classified.features,
      offers: [offer],
    });
  }

  const groups = drafts.map((d): WebProductGroup => {
    const offers = [...d.offers]
      .sort((a, b) => {
        if (a.priceKurus !== null && b.priceKurus !== null) return a.priceKurus - b.priceKurus;
        if (a.priceKurus !== null) return -1;
        if (b.priceKurus !== null) return 1;
        return a.host < b.host ? -1 : 1;
      })
      .slice(0, WEB_SEARCH_MAX_OFFERS_PER_GROUP);
    const prices = offers.map((o) => o.priceKurus).filter((p): p is number => p !== null);
    return {
      key: groupKey(d),
      title: d.title,
      brand: d.brand,
      matchKind: d.kind,
      offers,
      minVerifiedPriceKurus: prices.length > 0 ? Math.min(...prices) : null,
    };
  });
  return sortGroups(groups).slice(0, WEB_SEARCH_POOL_GROUPS);
}

/** Tam eslesme once; dogrulanmis fiyatlilar, sonra teklif sayisi ve dusuk fiyat. */
export function sortGroups(groups: readonly WebProductGroup[]): WebProductGroup[] {
  return [...groups].sort((a, b) => {
    if (a.matchKind !== b.matchKind) return a.matchKind === "exact" ? -1 : 1;
    const aPriced = a.minVerifiedPriceKurus !== null;
    const bPriced = b.minVerifiedPriceKurus !== null;
    if (aPriced !== bPriced) return aPriced ? -1 : 1;
    if (a.offers.length !== b.offers.length) return b.offers.length - a.offers.length;
    if (aPriced && bPriced)
      return (a.minVerifiedPriceKurus as number) - (b.minVerifiedPriceKurus as number);
    return a.key < b.key ? -1 : 1;
  });
}

export interface CatalogSnapshot {
  /** Aktif katalog magazalarinin ana makineleri (`www.` atilmis). */
  hosts: ReadonlySet<string>;
  /** Veritabani sonuclarinin basliklari. */
  titles: readonly string[];
}

const CATALOG_DUPLICATE_SIMILARITY = 0.6;

/**
 * Katalogdaki magazadan gelen ve baslikca zaten katalog sonucuyla ortusen
 * teklifler atilir (ayni urun ayni magaza: yinelenen kayit + affiliate
 * baglantisi kaybi). Baska bir saticidaki ayni urun KALIR: amac daha uygun
 * fiyati gostermek.
 */
export function dropCatalogDuplicates(
  groups: readonly WebProductGroup[],
  catalog: CatalogSnapshot,
): WebProductGroup[] {
  const catalogTokens = catalog.titles.map((t) => new Set(significantTokens(t)));
  const out: WebProductGroup[] = [];
  for (const group of groups) {
    const offers = group.offers.filter((offer) => {
      if (!catalog.hosts.has(offer.host)) return true;
      const tokens = new Set(significantTokens(offer.title));
      return !catalogTokens.some(
        (c, i) =>
          jaccard(c, tokens) >= CATALOG_DUPLICATE_SIMILARITY &&
          sameProductLine(catalog.titles[i] ?? "", offer.title) &&
          sameProductLine(offer.title, catalog.titles[i] ?? ""),
      );
    });
    if (offers.length === 0) continue;
    const prices = offers.map((o) => o.priceKurus).filter((p): p is number => p !== null);
    out.push({
      ...group,
      offers,
      minVerifiedPriceKurus: prices.length > 0 ? Math.min(...prices) : null,
    });
  }
  return sortGroups(out);
}

export interface CatalogImageCandidate {
  title: string;
  imageUrl: string | null;
}

const CATALOG_IMAGE_SIMILARITY = 0.7;

/**
 * Internet urunune, katalogda AYNI urun varsa KATALOGUN gorselini verir (kendi
 * feed'imizden; hakki ve kaynagi dogrulanmis). Kimlik: marka/kelime benzerligi +
 * ayni model ailesi (nesil, Pro/Max/Plus) + siki varyant (renk, kapasite, beden iki
 * tarafta da ayni ya da ikisi de bos). Yanlis urunun ya da yanlis rengin fotografi
 * yaniltir, bu yuzden belirsizse gorsel verilmez. Benzer alternatif de olsa grubun
 * KENDI urunu katalogda varsa gorseli verilir. Internet sayfalarindan gorsel cekilmez.
 */
export function attachCatalogImages(
  groups: readonly WebProductGroup[],
  catalog: readonly CatalogImageCandidate[],
): WebProductGroup[] {
  const candidates = catalog
    .filter((item): item is { title: string; imageUrl: string } => Boolean(item.imageUrl))
    .map((item) => ({
      item,
      tokens: new Set(significantTokens(item.title)),
      features: extractFeatures(item.title),
    }));
  return groups.map((group) => {
    const text = `${group.brand ?? ""} ${group.title}`;
    const tokens = new Set(significantTokens(text));
    const features = extractFeatures(group.title, group.brand);
    let best: { url: string; score: number } | null = null;
    for (const candidate of candidates) {
      const score = jaccard(candidate.tokens, tokens);
      if (score < CATALOG_IMAGE_SIMILARITY || (best !== null && score <= best.score)) continue;
      if (!strictSameVariant(candidate.features, features)) continue;
      if (!sameProductLine(text, candidate.item.title)) continue;
      if (!sameProductLine(candidate.item.title, text)) continue;
      best = { url: candidate.item.imageUrl, score };
    }
    return { ...group, imageUrl: best?.url ?? group.imageUrl ?? null };
  });
}
