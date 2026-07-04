// ─── Top-level export ────────────────────────────────────────────────────────

export interface RootAnalysisExport {
  /** Feature categories. Defaults to [] — synthesized from swimlane groups when absent. */
  categories: Category[];
  canvases: Canvas[];
  workspace?: Workspace;
  exportMetadata?: ExportMetadata;
  jobStatus?: JobStatus;
}

// ─── Workspace metadata (optional for code generation) ───────────────────────

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  workspaceType?: string;
  status?: string;
  progress?: string;
  score?: number;
  featureCount?: number;
  timelineMinutes?: number;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastAccessed?: string;
  /**
   * Markdown body of `tech-stack.md` to include in the artifact ZIP. When
   * present (and `tech_stack` is not set on the request body), this overrides
   * the bundled `tech-stack.default.md`. See plan 26 phase 1.5.
   */
  techStack?: string;
}

// ─── Categories & features ────────────────────────────────────────────────────

export interface Category {
  category_id: string;
  category_name: string;
  features: CategoryFeature[];
  workspace_id?: string;
  category_description?: string;
  category_type?: string;
  category_score?: number;
  created_at?: string;
  updated_at?: string;
}

export interface CategoryFeature {
  feature_id: string;
  feature_name: string;
  category_id?: string;
  feature_description?: string;
  feature_score?: number;
  created_at?: string;
  updated_at?: string;
}

// ─── Visual workflow canvases ─────────────────────────────────────────────────

export interface Canvas {
  feature?: CanvasFeature;
  /** Accepts both "swimlaneGroups" (Studio camelCase) and "swimlane_groups" (legacy). */
  swimlaneGroups?: SwimlaneGroup[];
  swimlane_groups?: SwimlaneGroup[];
  swimlanes?: Swimlane[];
  nodes?: Node[];
  edges?: Edge[];
}

export interface CanvasFeature {
  id: string;
  name: string;
  workspace_id?: string;
  category_id?: string;
  description?: string;
  feature_score?: number;
  created_at?: string;
  updated_at?: string;
}

/** Returns swimlane groups regardless of which key is present in the canvas. */
export function getSwimlaneGroups(canvas: Canvas): SwimlaneGroup[] {
  return canvas.swimlaneGroups ?? canvas.swimlane_groups ?? [];
}

// ─── Swimlane group ───────────────────────────────────────────────────────────

export interface SwimlaneGroup {
  id: string;
  label: string;
  color?: string;
  orderIndex?: number;
  isCollapsed?: boolean;
  apiId?: string;
  swimlanes?: Swimlane[];
}

// ─── Swimlane ─────────────────────────────────────────────────────────────────

/** Studio format nests display fields inside `data` (camelCase). */
export interface SwimlaneData {
  label?: string;
  swimlaneGroupId?: string;
  rowType?: string;
  orderIndex?: number;
  color?: string;
  isCollapsed?: boolean;
  width?: number;
  height?: number;
}

export interface Swimlane {
  /** Always top-level. */
  id: string;
  /** Flat format (legacy): label at top level. */
  label?: string;
  swimlaneGroupId?: string;
  rowType?: string;
  /** Studio format: display fields nested here. */
  data?: SwimlaneData;
  position?: Position;
  width?: number;
  height?: number;
  orderIndex?: number;
}

/** Returns label from flat field (legacy) or nested data (Studio). */
export function getSwimlanLabel(swimlane: Swimlane): string {
  return swimlane.label ?? swimlane.data?.label ?? '';
}

// ─── Node ─────────────────────────────────────────────────────────────────────

/** Studio format nests title/description/swimlaneId inside `data` (camelCase). */
export interface NodeData {
  title?: string;
  description?: string;
  swimlaneId?: string;
  status?: string;
  color?: string;
  /** Marks decorative SVG nodes that should be skipped during traversal. */
  isSVGContainer?: boolean;
  /**
   * Raw SVG markup for this node's icon/illustration (Studio format).
   * When present, extracted to assets/<nodeId>.svg in the ZIP.
   */
  svgContent?: string;
}

export interface Node {
  /** Always top-level. */
  id: string;
  /** Flat format (legacy): swimlane_id, title, description at top level. */
  swimlane_id?: string;
  title?: string;
  description?: string;
  /** Studio format: all display fields nested here. */
  data?: NodeData;
  /** Used to detect svgContainer / svgChild nodes. */
  type?: string;
  status?: string;
  color?: string;
  position?: Position;
  codeData?: CodeData;
  /**
   * Raw SVG markup at top level (legacy flat format).
   * Mirrors NodeData.svgContent for non-Studio payloads.
   */
  svgContent?: string;
  /**
   * Studio canvas export format: SVG container nodes carry the full markup here.
   * `svg_data.svg_markup` is preferred over `svgContent` / `data.svgContent` when present.
   */
  svg_data?: {
    svg_markup?: string;
    svg_element_type?: string;
  };
}

/** Returns swimlane ID from flat field (legacy) or nested data.swimlaneId (Studio). */
export function getNodeSwimlaneId(node: Node): string {
  return node.swimlane_id ?? node.data?.swimlaneId ?? '';
}

/** Returns title from flat field (legacy) or nested data.title (Studio). */
export function getNodeTitle(node: Node): string {
  return node.title ?? node.data?.title ?? '';
}

/** Returns description from flat field (legacy) or nested data.description (Studio). */
export function getNodeDescription(node: Node): string | undefined {
  return node.description ?? node.data?.description;
}

/**
 * True for nodes that carry no flow logic and should be skipped during code traversal.
 * Covers both the SVG container node and its individual child shape nodes.
 */
export function isSvgContainer(node: Node): boolean {
  return (
    node.type === 'svgContainer' ||
    node.type === 'svgChild' ||
    (node.data?.isSVGContainer ?? false)
  );
}

/**
 * Returns raw SVG markup for a node, checking all known storage locations in priority order:
 *   1. svg_data.svg_markup  (Studio canvas export format)
 *   2. svgContent           (flat legacy field)
 *   3. data.svgContent      (Studio nested field)
 * Returns undefined when absent or only whitespace.
 */
export function getNodeSvgContent(node: Node): string | undefined {
  const raw = node.svg_data?.svg_markup ?? node.svgContent ?? node.data?.svgContent;
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

// ─── Supporting types ─────────────────────────────────────────────────────────

export interface CodeData {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  functionName?: string;
}

export interface Edge {
  id: string;
  targetNodeId?: string;
  targetHandle?: string;
  style?: string;
  label?: string;
}

export interface Position {
  x: number;
  y: number;
}

// ─── Metadata & status (optional for code generation) ────────────────────────

export interface ExportMetadata {
  exportedAt?: string;
  exporterVersion?: string;
  source?: string;
}

export interface JobStatus {
  jobId?: string;
  status?: string;
}
