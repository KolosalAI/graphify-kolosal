// Public surface for logical grouping (Plan 08, Stages 1–4).
export { buildGrouping } from "./grouping.js";
export { labelGrouping, createLabeler, getLLMConfig, llmConfigStatus } from "./llm.js";
export type { Labeler, LabelerOptions, LabelEvent, LabelerEventMap } from "./llm.js";
export { toCategoryFeatureSummary } from "./summary.js";
export { detectCommunities } from "./community.js";
export { partitionByFolders } from "./folders.js";
export { detectFeatures } from "./vocabulary.js";
export type { VocabFeature, VocabResult, FeatureConfig } from "./vocabulary.js";
export { isTestPath } from "./tests.js";
export type {
  Grouping, Category, Feature, ModuleRef, GroupFlag, GroupingOptions,
  CategoryFeatureSummary, CategorySummary, FeatureSummary,
} from "./types.js";
