/**
 * Saklanan model yorumunu OKUR (docs/decisions/0030, 0059, migration 0044).
 * `/ara` istek yolunda kullanilir; burada model cagrisi, ag istegi, anahtar
 * okuma ya da yazma YOKTUR. Bu modul saglayici istemcisini yuklemez.
 *
 * - Anahtar yalnizca kimlik: (normalize sorgu, bugunku sozlesme ozeti,
 *   bugunku model surumu). Kullanici, oturum ya da IP kullanilmaz.
 * - Yalnizca `status = 'accepted'`. `empty`/`invalid` satir yokmus gibidir.
 * - Eski ozete ya da eski modele dusulmez; bulanik esleme yok.
 * - Satir bugunku taksonomiye ve sorgu metnine karsi `validateInterpretation`
 *   ile YENIDEN dogrulanir; tek bir alan bile reddedilirse satir yok sayilir.
 * - Okuma istege bagli zenginlestirmedir: tablo yoksa (0044 uygulanmamis),
 *   sorgu hata verirse ya da satir bozuksa `null` doner ve arama bugunku
 *   deterministik yoldan aynen devam eder. Hata yalnizca sinifi ve SQL
 *   durum koduyla loglanir; sorgu metni loglara girmez.
 */
import { type Database, queryInterpretation } from "@arilla/db";
import { and, eq } from "drizzle-orm";
import {
  type ValidatedInterpretation,
  validateInterpretation,
} from "../clarification/interpreter.ts";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import { createInitialState } from "../clarification/state.ts";
import type { ClarificationRegistry } from "../clarification/types.ts";
import {
  currentInterpretationIdentity,
  type InterpretationIdentity,
} from "./interpretation-identity.ts";
import { normalizeQueryText } from "./normalize.ts";

const QUERY_NORM_MAX = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kurusToTry(value: unknown): number | null | "invalid" {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value % 100 !== 0) {
    return "invalid";
  }
  return value / 100;
}

/**
 * Saklanan (dogrulanmis bicimdeki) yorumu modelin cikti bicimine geri cevirir
 * ki AYNI dogrulayici bugunku taksonomiye ve metne karsi calissin. Bicim
 * bozuksa `null`.
 */
function toModelShape(stored: unknown): Record<string, unknown> | null {
  if (!isRecord(stored)) return null;
  const { domainId, facets, budget, pricePreference } = stored;
  if (domainId !== null && typeof domainId !== "string") return null;
  if (!Array.isArray(facets)) return null;
  const rawFacets: { facet_id: string; option_id: string }[] = [];
  for (const facet of facets) {
    if (
      !isRecord(facet) ||
      typeof facet.facetId !== "string" ||
      typeof facet.optionId !== "string"
    ) {
      return null;
    }
    rawFacets.push({ facet_id: facet.facetId, option_id: facet.optionId });
  }
  let rawBudget: { min_try: number | null; max_try: number | null } | null = null;
  if (budget !== null) {
    if (!isRecord(budget)) return null;
    const min = kurusToTry(budget.minKurus);
    const max = kurusToTry(budget.maxKurus);
    if (min === "invalid" || max === "invalid") return null;
    rawBudget = { min_try: min, max_try: max };
  }
  if (pricePreference !== null && pricePreference !== "lower") return null;
  return {
    domain_id: domainId,
    facets: rawFacets,
    budget: rawBudget,
    price_preference: pricePreference,
  };
}

/**
 * Saf: saklanan satiri bugunku taksonomi ve sorgu metnine karsi dogrular.
 * Bozuk, eksik, kismen reddedilen ya da bos yorum `null`.
 */
export function parseStoredInterpretation(
  stored: unknown,
  queryNorm: string,
  registry: ClarificationRegistry = DEFAULT_CLARIFICATION_REGISTRY,
): ValidatedInterpretation | null {
  const raw = toModelShape(stored);
  if (raw === null) return null;
  const { value, rejected } = validateInterpretation(
    raw,
    { text: queryNorm, state: createInitialState() },
    registry,
  );
  if (rejected.length > 0) return null;
  const empty =
    value.domainId === null &&
    value.facets.length === 0 &&
    value.budget === null &&
    value.pricePreference === null;
  return empty ? null : value;
}

function logLookupFailure(error: unknown): void {
  // Yalnizca sinif ve SQL durum kodu; sorgu metni ve parametreler loglanmaz.
  const code =
    (error as { code?: string; cause?: { code?: string } })?.cause?.code ??
    (error as { code?: string })?.code ??
    "";
  console.warn(
    "[stored-interpretation] lookup failed, using deterministic path",
    error instanceof Error ? error.name : "unknown",
    code,
  );
}

export interface StoredInterpretationOptions {
  registry?: ClarificationRegistry;
  /** Testler icin; varsayilan bugunku kod surumunun kimligi. */
  identity?: InterpretationIdentity;
}

/**
 * Normalize sorgu icin saklanan, KABUL edilmis ve bugun hala gecerli yorumu
 * okur. Asla firlatmaz; bulunamazsa ya da okunamazsa `null`.
 */
export async function readStoredInterpretation(
  db: Database,
  queryNorm: string,
  options: StoredInterpretationOptions = {},
): Promise<ValidatedInterpretation | null> {
  if (
    typeof queryNorm !== "string" ||
    queryNorm.length === 0 ||
    queryNorm.length > QUERY_NORM_MAX ||
    queryNorm !== normalizeQueryText(queryNorm)
  ) {
    return null;
  }
  const registry = options.registry ?? DEFAULT_CLARIFICATION_REGISTRY;
  const identity = options.identity ?? currentInterpretationIdentity(registry);

  let stored: unknown;
  try {
    const rows = await db
      .select({ interpretation: queryInterpretation.interpretation })
      .from(queryInterpretation)
      .where(
        and(
          eq(queryInterpretation.queryNorm, queryNorm),
          eq(queryInterpretation.taxonomyHash, identity.taxonomyHash),
          eq(queryInterpretation.modelVersion, identity.modelVersion),
          eq(queryInterpretation.status, "accepted"),
        ),
      )
      .limit(1);
    if (rows.length === 0) return null;
    stored = rows[0]?.interpretation;
  } catch (error) {
    logLookupFailure(error);
    return null;
  }
  return parseStoredInterpretation(stored, queryNorm, registry);
}
