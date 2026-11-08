export * from "./config.ts";
export {
  type FusedEntry,
  type FusionItem,
  type FusionOptions,
  fuseResults,
  gateSemantic,
  type SemanticItem,
} from "./fusion.ts";
export {
  createJinaQueryEmbedder,
  type JinaQueryEmbedderOptions,
  type QueryEmbedder,
  type QueryEmbedResult,
  type QueryEmbedUsage,
} from "./query-embedder.ts";
export {
  findSemanticCandidates,
  type SemanticCandidate,
  type SemanticCandidateRequest,
  similaritiesFor,
  vectorLiteral,
} from "./semantic-candidates.ts";
export {
  compareTopN,
  measureSemanticShadow,
  SEMANTIC_QUERY_OPERATION,
  SHADOW_TOP_N,
  type ShadowDeps,
  type ShadowInput,
  type ShadowMetrics,
  type ShadowOutcome,
  scheduleSemanticShadow,
} from "./shadow.ts";
