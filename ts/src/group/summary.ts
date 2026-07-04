// Project the full grouping tree down to the module-free category→feature summary
// (category-feature.json). A pure projection — never recomputes counts.
import type { CategoryFeatureSummary, Grouping } from "./types.js";

export function toCategoryFeatureSummary(g: Grouping): CategoryFeatureSummary {
  return {
    categories: g.categories.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      moduleCount: c.moduleCount,
      godNodes: c.godNodes,
      features: c.features.map((f) => ({
        id: f.id,
        label: f.label,
        description: f.description,
        moduleCount: f.modules.length,
        godNodes: f.godNodes,
        flags: [...new Set(f.flags.map((x) => x.kind))],
      })),
    })),
    meta: {
      categoryCount: g.meta.categoryCount,
      featureCount: g.meta.featureCount,
      moduleCount: g.meta.moduleCount,
      llm: g.meta.llm,
      ...(g.meta.model ? { model: g.meta.model } : {}),
    },
  };
}
