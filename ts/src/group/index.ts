// Public surface for logical grouping (Plan 08, Stages 1–4).
export { buildGrouping } from "./grouping.js";
export { labelGrouping, createLabeler, getLLMConfig, llmConfigStatus } from "./llm.js";
export type { Labeler, LabelerOptions, LabelEvent, LabelerEventMap } from "./llm.js";
export { toCategoryFeatureSummary } from "./summary.js";
export { detectCommunities } from "./community.js";
export { partitionByFolders } from "./folders.js";
export { detectFeatures } from "./vocabulary.js";
export { annotateGodReferences } from "./tiers.js";
export { analyzeOperations } from "./operations.js";
export { buildFeatureCallGraphs } from "./callgraphview.js";
export type { FeatureCallGraph, OperationGraph, CodeNode, CallGraphIndex, CallGraphViewOptions } from "./callgraphview.js";
export { summarizeFeatureGraphs, heuristicNodeLabel } from "./nodesummary.js";
export type { NodeSummaryOptions, NodeSummaryStats, SummarizerEvents, FeatureDoneEvent } from "./nodesummary.js";
export type { VocabFeature, VocabResult, FeatureConfig } from "./vocabulary.js";
export { isTestPath } from "./tests.js";
export type {
  Grouping, Category, Feature, ModuleRef, GroupFlag, GroupingOptions,
  CategoryFeatureSummary, CategorySummary, FeatureSummary,
} from "./types.js";
