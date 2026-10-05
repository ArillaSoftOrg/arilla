/**
 * Saklanan model yorumunun onbellek kimligi (docs/decisions/0059, migration
 * 0044): (normalize sorgu, sozlesme ozeti, model surumu). Toplu yazici ve
 * `/ara` okuma yolu AYNI fonksiyonu kullanir; iki tarafta ayri hesap, hic
 * eslesmeyen bir onbellek demek olurdu.
 *
 * Bu modul saglayici istemcisini yuklemez: model kimligi `llm/model.ts`
 * sabitinden gelir. Ag, anahtar ya da ortam degiskeni yok.
 */
import { createHash } from "node:crypto";
import {
  buildInterpreterJsonSchema,
  describeTaxonomy,
  INTERPRETER_INSTRUCTIONS,
} from "../clarification/interpreter.ts";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import type { ClarificationRegistry } from "../clarification/types.ts";
import { GEMINI_MODEL } from "../llm/model.ts";

/** Ayni kayit nesnesi icin bir kez hesaplanir (istek yolunda tekrar SHA-256 yok). */
const hashCache = new WeakMap<ClarificationRegistry, string>();

/**
 * Modele giden sozlesmenin ozeti: taksonomi (kimlik + etiket), JSON semasi ve
 * talimatlar. Biri degisince ayni sorgu yeniden yorumlanabilir.
 */
export function interpreterContractHash(
  registry: ClarificationRegistry = DEFAULT_CLARIFICATION_REGISTRY,
): string {
  const cached = hashCache.get(registry);
  if (cached !== undefined) return cached;
  const contract = JSON.stringify({
    instructions: INTERPRETER_INSTRUCTIONS,
    taxonomy: describeTaxonomy(registry),
    schema: buildInterpreterJsonSchema(registry),
  });
  const hash = createHash("sha256").update(contract, "utf8").digest("hex");
  hashCache.set(registry, hash);
  return hash;
}

export interface InterpretationIdentity {
  taxonomyHash: string;
  modelVersion: string;
}

/** Bugunku kod surumunun kimligi; eski ozet ya da eski model satiri eslesmez. */
export function currentInterpretationIdentity(
  registry: ClarificationRegistry = DEFAULT_CLARIFICATION_REGISTRY,
): InterpretationIdentity {
  return { taxonomyHash: interpreterContractHash(registry), modelVersion: GEMINI_MODEL };
}
