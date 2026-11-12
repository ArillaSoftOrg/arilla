export * from "./active-index.ts";
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
  fuseForQuery,
  measureSemanticShadow,
  SEMANTIC_QUERY_OPERATION,
  SHADOW_TOP_N,
  type ShadowDeps,
  type ShadowInput,
  type ShadowMetrics,
  type ShadowOutcome,
  scheduleSemanticShadow,
} from "./shadow.ts";
export {
  type CategorySource,
  type CategoryStat,
  DEFAULT_STRATEGY_CONFIG,
  type IndexDescriptor,
  type IndexKind,
  type IndexScope,
  type IndexState,
  isSafeCategoryLiteral,
  resolveStrategyConfig,
  type StrategyConfig,
  type StrategyDecision,
  type StrategyInput,
  type StrategyKind,
  selectSemanticStrategy,
  type UncategorizedPolicy,
} from "./strategy.ts";
