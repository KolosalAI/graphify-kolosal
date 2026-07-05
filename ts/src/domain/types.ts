// Base domain dictionaries (Plan 11, Pillar C). Language-agnostic canonical vocabulary
// per business domain, used AFTER the Pillar A + Pillar B fuse to enforce/canonicalize
// feature names and category grouping. A dictionary augments discovered features — it
// never invents code that isn't there.

export interface DomainFeature {
  /** human-facing canonical label, e.g. "Cart" */
  canonical: string;
  /** normalized synonyms/keywords (lowercased, alnum) that map to this feature */
  keywords: string[];
  /** canonical category (bounded context) this feature belongs to */
  category: string;
}

export interface DomainDictionary {
  /** domain id, e.g. "ecommerce" */
  domain: string;
  /** display name, e.g. "E-commerce" */
  label: string;
  features: DomainFeature[];
}
