// Project the full grouping tree down to the module-free category→feature summary
// (category-feature.json). Plan 12: mirrors the two-tier business/common shape. Pure projection.
import type { CategoryFeatureSummary, CategorySummary, Category, Grouping } from "./types.js";

function projectCategories(categories: Category[]): CategorySummary[] {
  return categories.map((c) => ({
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
      ...(f.tier ? { tier: f.tier } : {}),
      ...(f.uses ? { uses: f.uses } : {}),
      ...(f.usedBy ? { usedBy: f.usedBy } : {}),
      ...(f.dataModels ? { dataModels: f.dataModels } : {}),
      ...(f.ops ? { ops: f.ops.map((o) => o.label) } : {}),
    })),
  }));
}

export function toCategoryFeatureSummary(g: Grouping): CategoryFeatureSummary {
  return {
    business: { categories: projectCategories(g.business.categories) },
    common: { categories: projectCategories(g.common.categories) },
    meta: {
      schemaVersion: g.meta.schemaVersion,
      categoryCount: g.meta.categoryCount,
      featureCount: g.meta.featureCount,
      businessFeatureCount: g.meta.businessFeatureCount ?? 0,
      commonFeatureCount: g.meta.commonFeatureCount ?? 0,
      moduleCount: g.meta.moduleCount,
      llm: g.meta.llm,
      ...(g.meta.model ? { model: g.meta.model } : {}),
      ...(g.meta.domain ? { domain: g.meta.domain } : {}),
      ...(g.meta.ubiquitous ? { ubiquitous: g.meta.ubiquitous } : {}),
    },
  };
}
