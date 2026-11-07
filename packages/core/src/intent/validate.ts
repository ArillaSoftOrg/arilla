/**
 * IntentV2 dogrulayicisi ve kip atamasi (0171 §4.1–4.5).
 *
 * Model ciktisi gecerli JSON olsa bile icerigi yanlis olabilir. Bu modul her
 * degere kaynak (acik / duzeltilmis / cikarim) ve uygulama kipi atar:
 *
 *   H  sert filtre      — yalnizca acik VE katalogda dogrulanabilir kolon:
 *                         butce (kurus), lexicon markasi, urun turu -> kategori yolu
 *   R  siralama ipucu   — uyumluluk, oznitelikler, rol, duzeltilmis marka, tur metni
 *   D  yalnizca gosterim — cikarim, kullanim amaci, fiyat tercihi
 *   X  atilir           — sema/taksonomi disi, kanitla celisen, gizlilige takilan
 *
 * Kural: baslik tokenina dayanan hicbir kriter H olamaz. H'ye yalnizca
 * yapilandirilmis katalog kolonu karsiligi olan deger girer. Uyumluluk ve
 * olumsuz kriterler sonuc DISLAMAZ (yanlis negatif onlenir).
 *
 * Saf fonksiyon: ag, veritabani, saat yok. Saklanan ham cikti okunurken her
 * seferinde bu fonksiyondan yeniden gecer (eski karar tasinmaz, §6.4).
 */
import { priceAmountsInText } from "../clarification/price-language.ts";
import { CATALOG_PRODUCT_TYPES } from "../clarification/product-types.ts";
import type { LexiconEntry } from "../search/lexicon.ts";
import { foldForMatch } from "../search/text-match.ts";
import { oppositeOf, resolveAttributeValue } from "./antonyms.ts";
import { intentCategoryFor } from "./category-map.ts";
import {
  AMBIGUOUS_FIELDS,
  type AmbiguousField,
  ATTRIBUTE_KEYS,
  ATTRIBUTE_STRENGTHS,
  type AttributeKey,
  type AttributeStrength,
  INTENT_ROLES,
  INTENT_SCHEMA_VERSION,
  type IntentRole,
  MAX_ATTRIBUTES,
  MAX_EXCLUDED_BRANDS,
  MAX_OPTION,
  MAX_QUESTION,
  MAX_TEXT,
} from "./contract.ts";
import { checkCorrection, DEFAULT_CORRECTION_CONFIDENCE_THRESHOLD } from "./corrections.ts";
import {
  type EvidenceMatch,
  type EvidenceSource,
  evidenceTokens,
  locateEvidence,
  numbersSupported,
  rangesOverlap,
  sharesToken,
} from "./evidence.ts";
import type { NormalizedQueryLike } from "./normalized-query-adapter.ts";

export type Mode = "H" | "R" | "D" | "X";

export type CriterionField =
  | "category"
  | "product_type"
  | "role"
  | "compatible_with"
  | "brand"
  | "excluded_brand"
  | "attribute"
  | "budget"
  | "price_preference"
  | "use_case";

export type CriterionReason =
  | "explicit_catalog_column"
  | "explicit_text_only"
  | "title_based_never_hard"
  | "corrected_accepted"
  | "corrected_rejected"
  | "inferred"
  | "derived_opposite"
  | "display_only"
  | "brand_is_compatible_device"
  | "type_not_main_role"
  | "type_head_not_in_evidence"
  /** Tur kategorisi uretimde dogrulanamadi (category-map esigi): yalniz siralama. */
  | "category_not_verified"
  | "downgraded_core_rejected"
  | "unknown_value"
  | "value_conflicts_evidence"
  | "budget_not_in_text"
  | "invalid_value";

export interface Criterion {
  field: CriterionField;
  /** Modelin (ya da turetilmis) degeri; arayuzde gosterilebilir. */
  value: string;
  /** Katalog karsiligi: lexicon `normalized`, kategori yolu, kapali oznitelik id. */
  canonical: string | null;
  key?: AttributeKey;
  strength?: AttributeStrength | "derived_preferred";
  source: EvidenceSource | "derived";
  mode: Mode;
  reason: CriterionReason;
}

export interface ValidatedIntentV2 {
  criteria: Criterion[];
  role: IntentRole | null;
  /** Yalnizca H kipindeki butce; kurus cinsinden. */
  budget: { minKurus: number | null; maxKurus: number | null } | null;
  ambiguous: AmbiguousField[];
  clarification: { question: string; options: string[]; blocking: boolean } | null;
  /** product_type ya da role reddedildiyse tum H/R kriterleri D'ye indi. */
  downgraded: boolean;
  /** Dogrulama sonucundan turetilir; modelin beyani degildir. */
  confidence: "high" | "medium" | "low";
  rejectedCount: number;
}

export interface ValidateContext {
  query: NormalizedQueryLike;
  lexicon: readonly LexiconEntry[];
  correctionThreshold?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : null;
}

const URL_LIKE = /https?:|www\.|\.com\b|@/iu;

function evidenceOf(entry: Record<string, unknown>): string | null {
  return typeof entry.evidence === "string" ? entry.evidence : null;
}

function brandCanonical(text: string, lexicon: readonly LexiconEntry[]): string | null {
  const target = foldForMatch(text).trim();
  const hit = lexicon.find(
    (entry) =>
      entry.kind === "brand" &&
      (foldForMatch(entry.surface) === target || foldForMatch(entry.normalized) === target),
  );
  return hit ? hit.normalized : null;
}

/** Duzeltme kaynakli degerin R'ye girip giremeyecegi (§6.3). */
function correctedMode(match: EvidenceMatch, ctx: ValidateContext): Mode {
  const threshold = ctx.correctionThreshold ?? DEFAULT_CORRECTION_CONFIDENCE_THRESHOLD;
  const ok = match.corrections.every(
    (correction) => checkCorrection(correction, ctx.query, ctx.lexicon, threshold) === null,
  );
  return ok ? "R" : "D";
}

export function validateIntentV2(raw: unknown, ctx: ValidateContext): ValidatedIntentV2 {
  const criteria: Criterion[] = [];
  let rejectedCount = 0;
  const reject = (field: CriterionField, value: string, reason: CriterionReason, extra = {}) => {
    rejectedCount += 1;
    criteria.push({
      field,
      value,
      canonical: null,
      source: "inferred",
      mode: "X",
      reason,
      ...extra,
    });
  };

  const empty: ValidatedIntentV2 = {
    criteria,
    role: null,
    budget: null,
    ambiguous: [],
    clarification: null,
    downgraded: false,
    confidence: "low",
    rejectedCount: 1,
  };
  if (!isRecord(raw) || raw.schema_version !== INTENT_SCHEMA_VERSION) return empty;

  const query = ctx.query;
  let coreRejected = false;

  // --- rol ---------------------------------------------------------------
  let role: IntentRole | null = null;
  if (raw.role !== null && raw.role !== undefined) {
    if (typeof raw.role === "string" && (INTENT_ROLES as readonly string[]).includes(raw.role)) {
      role = raw.role as IntentRole;
    } else {
      reject("role", String(raw.role), "invalid_value");
      coreRejected = true;
    }
  }

  // --- uyumlu cihaz (marka kontrolunden once: marka cakismasi icin) -------
  let compatibleRange: readonly [number, number] | null = null;
  let compatibleText: string | null = null;
  if (isRecord(raw.compatible_with)) {
    const text = str(raw.compatible_with.text);
    const evidence = evidenceOf(raw.compatible_with);
    if (text === null) {
      reject("compatible_with", String(raw.compatible_with.text), "invalid_value");
    } else if (
      !numbersSupported(text, evidence) ||
      (evidence !== null && !sharesToken(text, evidence))
    ) {
      reject("compatible_with", text, "value_conflicts_evidence");
    } else {
      const match = locateEvidence(evidence, query);
      compatibleRange = match.tokenRange;
      compatibleText = text;
      const mode: Mode =
        match.source === "explicit"
          ? "R"
          : match.source === "corrected"
            ? correctedMode(match, ctx)
            : "D";
      criteria.push({
        field: "compatible_with",
        value: text,
        canonical: null,
        source: match.source,
        mode,
        reason:
          match.source === "explicit"
            ? "title_based_never_hard"
            : match.source === "corrected"
              ? mode === "R"
                ? "corrected_accepted"
                : "corrected_rejected"
              : "inferred",
      });
    }
  }

  // --- urun turu ------------------------------------------------------------
  let productTypeAccepted = false;
  if (isRecord(raw.product_type)) {
    const text = str(raw.product_type.text);
    const evidence = evidenceOf(raw.product_type);
    const typeId = raw.product_type.type_id;
    if (text === null) {
      reject("product_type", String(raw.product_type.text), "invalid_value");
      coreRejected = true;
    } else if (
      evidence !== null &&
      !sharesToken(text, evidence) &&
      !numbersSupported(text, evidence)
    ) {
      reject("product_type", text, "value_conflicts_evidence");
      coreRejected = true;
    } else {
      const match = locateEvidence(evidence, query);
      productTypeAccepted = true;
      criteria.push({
        field: "product_type",
        value: text,
        canonical: null,
        source: match.source,
        mode:
          match.source === "explicit"
            ? "R"
            : match.source === "corrected"
              ? correctedMode(match, ctx)
              : "D",
        reason:
          match.source === "explicit"
            ? "explicit_text_only"
            : match.source === "corrected"
              ? "corrected_accepted"
              : "inferred",
      });

      // Kategori yolu (H): katalogda var olan tur, ACIK kanit, ana urun,
      // turun bas ismi kanitta geciyor VE yol uretimde dogrulanmis
      // (`category-map.ts`). Dogrulanmamis yol yalnizca siralama ipucudur.
      // Aksesuar/parcada tur kategorisi aranan urunun kategorisi olmayabilir.
      if (typeId !== null && typeId !== undefined) {
        const type = CATALOG_PRODUCT_TYPES.find((entry) => entry.id === typeId);
        const mapped = type ? intentCategoryFor(type.id) : null;
        if (!type || !mapped) {
          reject("category", String(typeId), "unknown_value");
        } else if (role !== null && role !== "main") {
          criteria.push({
            field: "category",
            value: type.label,
            canonical: mapped.hintPath,
            source: match.source,
            mode: "D",
            reason: "type_not_main_role",
          });
        } else if (match.source !== "explicit") {
          criteria.push({
            field: "category",
            value: type.label,
            canonical: mapped.hintPath,
            source: match.source,
            mode: "D",
            reason: match.source === "corrected" ? "corrected_rejected" : "inferred",
          });
        } else {
          const evTokens = evidenceTokens(evidence ?? "");
          const headInEvidence = type.head.some((head) => {
            const headTokens = evidenceTokens(head);
            return headTokens.every((h) => evTokens.some((t) => t.startsWith(h)));
          });
          const hard = headInEvidence && mapped.hard;
          criteria.push({
            field: "category",
            value: type.label,
            canonical: hard ? mapped.hardPath : mapped.hintPath,
            source: "explicit",
            mode: !headInEvidence ? "D" : hard ? "H" : "R",
            reason: !headInEvidence
              ? "type_head_not_in_evidence"
              : hard
                ? "explicit_catalog_column"
                : "category_not_verified",
          });
        }
      }
    }
  }

  // --- marka ---------------------------------------------------------------
  if (isRecord(raw.brand)) {
    const text = str(raw.brand.text);
    const evidence = evidenceOf(raw.brand);
    if (text === null) {
      reject("brand", String(raw.brand.text), "invalid_value");
    } else {
      const match = locateEvidence(evidence, query);
      const canonical = brandCanonical(text, ctx.lexicon);
      const evidenceAgrees =
        evidence === null ||
        brandCanonical(evidence, ctx.lexicon) === canonical ||
        sharesToken(text, evidence);
      if (!evidenceAgrees || !numbersSupported(text, evidence)) {
        reject("brand", text, "value_conflicts_evidence");
      } else if (
        rangesOverlap(match.tokenRange, compatibleRange) ||
        (compatibleText !== null &&
          match.source !== "explicit" &&
          sharesToken(text, compatibleText))
      ) {
        // "Samsung telefonuma sarj aleti": Samsung uyumlu cihazin markasi; aranan
        // urunun markasi degil. Filtre olursa yalnizca Samsung marka sarj aletleri kalir.
        criteria.push({
          field: "brand",
          value: text,
          canonical,
          source: match.source,
          mode: "D",
          reason: "brand_is_compatible_device",
        });
      } else if (match.source === "explicit") {
        criteria.push({
          field: "brand",
          value: text,
          canonical,
          source: "explicit",
          mode: canonical !== null ? "H" : "R",
          reason: canonical !== null ? "explicit_catalog_column" : "explicit_text_only",
        });
      } else if (match.source === "corrected") {
        const mode = canonical !== null ? correctedMode(match, ctx) : "D";
        criteria.push({
          field: "brand",
          value: text,
          canonical,
          source: "corrected",
          mode,
          reason: mode === "R" ? "corrected_accepted" : "corrected_rejected",
        });
      } else {
        criteria.push({
          field: "brand",
          value: text,
          canonical,
          source: "inferred",
          mode: "D",
          reason: "inferred",
        });
      }
    }
  }

  // --- istenmeyen markalar ---------------------------------------------------
  // Marka yapilandirilmis katalog kolonudur: acik + lexicon -> H (brand_exclude).
  // Lexicon'da yoksa yalnizca baslikta gecen urunu alta iter (R), dislamaz.
  const rawExcluded = Array.isArray(raw.excluded_brands)
    ? raw.excluded_brands.slice(0, MAX_EXCLUDED_BRANDS)
    : [];
  for (const entry of rawExcluded) {
    const text = isRecord(entry) ? str(entry.text) : null;
    if (!isRecord(entry) || text === null) {
      reject("excluded_brand", "?", "invalid_value");
      continue;
    }
    const evidence = evidenceOf(entry);
    if (evidence !== null && !sharesToken(text, evidence)) {
      reject("excluded_brand", text, "value_conflicts_evidence");
      continue;
    }
    const match = locateEvidence(evidence, query);
    const canonical = brandCanonical(text, ctx.lexicon);
    let mode: Mode;
    let reason: CriterionReason;
    if (match.source === "explicit") {
      mode = canonical !== null ? "H" : "R";
      reason = canonical !== null ? "explicit_catalog_column" : "explicit_text_only";
    } else if (match.source === "corrected") {
      mode = canonical !== null ? correctedMode(match, ctx) : "D";
      reason = mode === "R" ? "corrected_accepted" : "corrected_rejected";
    } else {
      mode = "D";
      reason = "inferred";
    }
    criteria.push({
      field: "excluded_brand",
      value: text,
      canonical,
      source: match.source,
      mode,
      reason,
    });
  }

  // --- oznitelikler ----------------------------------------------------------
  const rawAttributes = Array.isArray(raw.attributes)
    ? raw.attributes.slice(0, MAX_ATTRIBUTES)
    : [];
  for (const entry of rawAttributes) {
    if (!isRecord(entry)) {
      reject("attribute", "?", "invalid_value");
      continue;
    }
    const key = entry.key;
    const value = str(entry.value);
    const strength = entry.strength;
    const evidence = evidenceOf(entry);
    if (
      typeof key !== "string" ||
      !(ATTRIBUTE_KEYS as readonly string[]).includes(key) ||
      value === null ||
      typeof strength !== "string" ||
      !(ATTRIBUTE_STRENGTHS as readonly string[]).includes(strength)
    ) {
      reject("attribute", String(entry.value), "unknown_value");
      continue;
    }
    if (!numbersSupported(value, evidence)) {
      reject("attribute", value, "value_conflicts_evidence", { key: key as AttributeKey });
      continue;
    }
    const match = locateEvidence(evidence, query);
    const def = resolveAttributeValue(key, value);
    let mode: Mode;
    let reason: CriterionReason;
    if (match.source === "explicit") {
      // Oznitelik yapilandirilmis katalog kolonunda dogrulanamaz: yalnizca baslik.
      mode = "R";
      reason = "title_based_never_hard";
    } else if (match.source === "corrected") {
      mode = correctedMode(match, ctx);
      reason = mode === "R" ? "corrected_accepted" : "corrected_rejected";
    } else {
      mode = "D";
      reason = "inferred";
    }
    criteria.push({
      field: "attribute",
      key: key as AttributeKey,
      value,
      canonical: def?.id ?? null,
      strength: strength as AttributeStrength,
      source: match.source,
      mode,
      reason,
    });
    // "Kablosuz olmayan" -> karsiti "kablolu" yalnizca R tercih; tablodan.
    if (strength === "excluded" && match.source === "explicit" && def !== null) {
      const opposite = oppositeOf(def);
      if (opposite !== null) {
        criteria.push({
          field: "attribute",
          key: opposite.key,
          value: opposite.label,
          canonical: opposite.id,
          strength: "derived_preferred",
          source: "derived",
          mode: "R",
          reason: "derived_opposite",
        });
      }
    }
  }

  // --- butce (H) -------------------------------------------------------------
  let budget: ValidatedIntentV2["budget"] = null;
  if (isRecord(raw.budget)) {
    const allowed = priceAmountsInText(query.raw);
    const read = (field: "min_try" | "max_try"): number | null | "bad" => {
      const amount = (raw.budget as Record<string, unknown>)[field];
      if (amount === null || amount === undefined) return null;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) return "bad";
      return allowed.has(amount) ? amount : "bad";
    };
    const min = read("min_try");
    const max = read("max_try");
    if (min === "bad" || max === "bad" || (min !== null && max !== null && min > max)) {
      reject("budget", JSON.stringify(raw.budget), "budget_not_in_text");
    } else if (min !== null || max !== null) {
      budget = {
        minKurus: min === null ? null : min * 100,
        maxKurus: max === null ? null : max * 100,
      };
      criteria.push({
        field: "budget",
        value: `${min ?? ""}-${max ?? ""}`,
        canonical: null,
        source: "explicit",
        mode: "H",
        reason: "explicit_catalog_column",
      });
    }
  }

  if (raw.price_preference === "lower") {
    criteria.push({
      field: "price_preference",
      value: "lower",
      canonical: null,
      source: "inferred",
      mode: "D",
      reason: "display_only",
    });
  } else if (raw.price_preference !== null && raw.price_preference !== undefined) {
    reject("price_preference", String(raw.price_preference), "invalid_value");
  }

  if (isRecord(raw.use_case)) {
    const text = str(raw.use_case.text);
    if (text !== null) {
      const match = locateEvidence(evidenceOf(raw.use_case), query);
      criteria.push({
        field: "use_case",
        value: text,
        canonical: null,
        source: match.source,
        mode: "D",
        reason: "display_only",
      });
    }
  }

  // --- rol kriteri (R; tur kabul edildiyse) -----------------------------------
  if (role !== null) {
    criteria.push({
      field: "role",
      value: role,
      canonical: role,
      source: "inferred",
      mode: productTypeAccepted ? "R" : "D",
      reason: productTypeAccepted ? "title_based_never_hard" : "display_only",
    });
  }

  // --- cekirdek reddedildiyse hepsi D ---------------------------------------
  if (coreRejected) {
    for (const criterion of criteria) {
      if (criterion.mode === "H" || criterion.mode === "R") {
        criterion.mode = "D";
        criterion.reason = "downgraded_core_rejected";
      }
    }
    budget = null;
  }

  const ambiguous = (Array.isArray(raw.ambiguous_fields) ? raw.ambiguous_fields : []).filter(
    (field): field is AmbiguousField =>
      typeof field === "string" && (AMBIGUOUS_FIELDS as readonly string[]).includes(field),
  );

  let clarification: ValidatedIntentV2["clarification"] = null;
  if (isRecord(raw.clarification)) {
    const question = str(raw.clarification.question, MAX_QUESTION);
    const options = Array.isArray(raw.clarification.options)
      ? raw.clarification.options.map((option) => str(option, MAX_OPTION))
      : [];
    const valid =
      question !== null &&
      !URL_LIKE.test(question) &&
      options.length >= 2 &&
      options.length <= 4 &&
      options.every((option) => option !== null && !URL_LIKE.test(option));
    if (valid) {
      // Yalnizca tur anlasilamadiysa engelleyici; diger durumlarda arama yapilir.
      clarification = { question, options: options as string[], blocking: !productTypeAccepted };
    } else {
      rejectedCount += 1;
    }
  }

  const hasExplicitCore = criteria.some(
    (c) => c.field === "product_type" && c.source === "explicit" && c.mode !== "X",
  );
  const confidence: ValidatedIntentV2["confidence"] =
    coreRejected || rejectedCount >= 2
      ? "low"
      : rejectedCount === 0 && hasExplicitCore
        ? "high"
        : "medium";

  return {
    criteria,
    role: coreRejected ? null : role,
    budget,
    ambiguous,
    clarification,
    downgraded: coreRejected,
    confidence,
    rejectedCount,
  };
}

/** Yalnizca belirli kipteki kriterler. */
export function criteriaIn(intent: ValidatedIntentV2, mode: Mode): Criterion[] {
  return intent.criteria.filter((criterion) => criterion.mode === mode);
}
