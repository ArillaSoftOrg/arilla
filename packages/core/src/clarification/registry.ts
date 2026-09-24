/**
 * Kural sozlugunun kendi dogrulamasi. Test'te ve (entegrasyonda) uygulama
 * acilisinda calisir: aranamayan bir secenek, katalogda olmayan bir kategori
 * ya da arayuz kuralini bozan bir etiket burada yakalanir.
 */
import { BUDGET_FACET_ID, type ClarificationRegistry } from "./types.ts";

/** CLAUDE.md "Dil ve içerik" + docs/glossary.md: arayuzde gecmeyen ifadeler. */
const FORBIDDEN_UI_WORDS = ["satın al", "dupe", "ucuz"];

const ID_RE = /^[a-z0-9_]+$/;

export interface RegistryIssue {
  path: string;
  message: string;
}

function checkLabel(label: string, path: string, issues: RegistryIssue[]): void {
  const lower = label.toLocaleLowerCase("tr-TR");
  for (const word of FORBIDDEN_UI_WORDS) {
    if (lower.includes(word)) issues.push({ path, message: `yasakli ifade: "${word}"` });
  }
  // "TL" para birimi kisaltmasidir, buyuk harf kuralinin konusu degil.
  const letters = label.replace(/\bTL\b/g, "").replace(/[^\p{L}]/gu, "");
  if (letters.length > 1 && letters === letters.toLocaleUpperCase("tr-TR")) {
    issues.push({ path, message: "ALL CAPS etiket" });
  }
}

export function validateRegistry(
  registry: ClarificationRegistry,
  knownCategoryPaths?: ReadonlySet<string>,
): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const domainIds = new Set<string>();

  for (const domain of registry.domains) {
    const dp = `domains.${domain.id}`;
    if (!ID_RE.test(domain.id)) issues.push({ path: dp, message: "gecersiz kimlik" });
    if (domainIds.has(domain.id)) issues.push({ path: dp, message: "tekrarlanan domain" });
    domainIds.add(domain.id);
    if (domain.triggers.length === 0) issues.push({ path: dp, message: "tetikleyici yok" });
    if (domain.categoryPath && knownCategoryPaths && !knownCategoryPaths.has(domain.categoryPath)) {
      issues.push({ path: dp, message: `bilinmeyen kategori: ${domain.categoryPath}` });
    }

    const facetIds = new Set<string>();
    for (const facet of domain.facets) {
      const fp = `${dp}.facets.${facet.id}`;
      if (!ID_RE.test(facet.id) || facet.id === BUDGET_FACET_ID) {
        issues.push({ path: fp, message: "gecersiz ya da ayrilmis kimlik" });
      }
      if (facetIds.has(facet.id)) issues.push({ path: fp, message: "tekrarlanan faset" });
      facetIds.add(facet.id);
      checkLabel(facet.question, `${fp}.question`, issues);
      checkLabel(facet.skipLabel, `${fp}.skipLabel`, issues);
      if (facet.options.length < 2) issues.push({ path: fp, message: "en az iki secenek gerekir" });

      const optionIds = new Set<string>();
      for (const option of facet.options) {
        const op = `${fp}.options.${option.id}`;
        if (!ID_RE.test(option.id) || option.id === "skip") {
          issues.push({ path: op, message: "gecersiz ya da ayrilmis kimlik" });
        }
        if (optionIds.has(option.id)) issues.push({ path: op, message: "tekrarlanan secenek" });
        optionIds.add(option.id);
        checkLabel(option.label, `${op}.label`, issues);

        const contribution = option.contribution;
        const searchable =
          (contribution?.terms?.length ?? 0) > 0 || contribution?.categoryPath !== undefined;
        // Filtre fasetinin her secenegi aranabilir olmak zorunda: aksi halde
        // kullanici bir sey secer ama arama degismez.
        if (facet.role === "filter" && !searchable) {
          issues.push({ path: op, message: "filtre seceneginin arama katkisi yok" });
        }
        if (
          contribution?.categoryPath &&
          knownCategoryPaths &&
          !knownCategoryPaths.has(contribution.categoryPath)
        ) {
          issues.push({ path: op, message: `bilinmeyen kategori: ${contribution.categoryPath}` });
        }
        for (const [impliedFacet, impliedOption] of Object.entries(option.implies ?? {})) {
          const target = domain.facets.find((f) => f.id === impliedFacet);
          if (!target?.options.some((o) => o.id === impliedOption)) {
            issues.push({
              path: op,
              message: `ima edilen deger tanimsiz: ${impliedFacet}.${impliedOption}`,
            });
          }
        }
      }

      if (facet.appliesWhen) {
        const gate = domain.facets.find((f) => f.id === facet.appliesWhen?.facetId);
        if (!gate) issues.push({ path: fp, message: "appliesWhen tanimsiz fasete bakiyor" });
      }
    }

    for (const entry of domain.questionOrder) {
      const known =
        entry.facetId === BUDGET_FACET_ID
          ? (domain.budgetBands?.length ?? 0) > 0
          : facetIds.has(entry.facetId);
      if (!known) {
        issues.push({ path: `${dp}.questionOrder`, message: `tanimsiz soru: ${entry.facetId}` });
      }
    }
    for (const band of domain.budgetBands ?? []) {
      checkLabel(band.label, `${dp}.budgetBands.${band.id}`, issues);
      if (!ID_RE.test(band.id))
        issues.push({ path: `${dp}.budgetBands`, message: "gecersiz kimlik" });
    }
    if (domain.budgetQuestion) checkLabel(domain.budgetQuestion, `${dp}.budgetQuestion`, issues);
    if (domain.maxQuestions < 1) issues.push({ path: dp, message: "maxQuestions en az 1" });
  }
  return issues;
}
