// Public surface for logical grouping (Plan 08, Stages 1–4).
export { buildGrouping } from "./grouping.js";
export { labelGrouping, createLabeler, getLLMConfig } from "./llm.js";
export type { Labeler, LabelerOptions, LabelEvent, LabelerEventMap } from "./llm.js";
export { toCategoryFeatureSummary } from "./summary.js";
export { detectCommunities } from "./community.js";
export { partitionByFolders } from "./folders.js";
export type {
  Grouping, Category, Feature, ModuleRef, GroupFlag, GroupingOptions,
  CategoryFeatureSummary, CategorySummary, FeatureSummary,
} from "./types.js";
