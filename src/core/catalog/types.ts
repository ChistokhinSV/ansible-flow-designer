// The module catalog as the probe writes it (probe/afd_probe/catalog.py, format 1) and what search
// returns (M5, ADR-0011). Pure types, shared by host, webview and tests.

export type PluginType = 'module' | 'filter' | 'test' | 'lookup' | 'keyword';

export interface CatalogOption {
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
  choices?: unknown[];
  elements?: string;
  aliases?: string[];
  no_log?: boolean;
  suboptions?: Record<string, CatalogOption>;
}

export interface CatalogReturn {
  type: string;
  description: string;
  returned?: string;
  contains?: Record<string, CatalogReturn>;
}

export interface CatalogPlugin {
  type: PluginType;
  fqcn: string;
  collection: string;
  name: string;
  short_description: string;
  description: string;
  options?: Record<string, CatalogOption>;
  returns?: Record<string, CatalogReturn>;
  examples?: string;
  attributes?: Record<string, { support?: string; description?: string }>;
  notes?: string;
  requirements?: string;
  deprecated?: { removed_in: string; why: string; alternative: string } | null;
  version_added?: string;
  applies_to?: string[];
}

export interface RoutingEntry {
  redirect?: string;
  deprecation?: { removal_version: string; warning_text: string };
  tombstone?: { removal_version: string; warning_text: string };
}

export interface CollectionFile {
  format: number;
  collection: string;
  version: string;
  core: string;
  plugins: CatalogPlugin[];
  /** plugin type → short or full name → routing (from runtime.yml). */
  routing: Record<string, Record<string, RoutingEntry>>;
  errors: string[];
}

export interface Manifest {
  core: string;
  collections: { name: string; version: string; file: string; dumped?: boolean; error?: string }[];
  dumped?: number;
  seconds?: number;
}

export type Badge =
  | 'check-mode'
  | 'check-mode-partial'
  | 'no-check-mode'
  | 'diff'
  | 'read-only'
  | 'other-platform'
  | 'deprecated';

export interface SearchContext {
  /** Collections the repository uses (requirements, bindings, FQCNs in playbooks). */
  collections?: string[];
  /** Platform collections from the inventory's ansible_network_os (e.g. cisco.ios). */
  platforms?: string[];
  types?: PluginType[];
}

export interface SearchHit {
  fqcn: string;
  type: PluginType;
  collection: string;
  short_description: string;
  score: number;
  /** Why it matched: the words found, and where. */
  match: string;
  badges: Badge[];
  /** Out of context (another platform): shown dimmed (D-24). */
  dimmed: boolean;
}

export interface Resolution {
  /** What Ansible runs for this name, when it exists in the environment. */
  fqcn?: string;
  /** Names followed through redirects, the asked name first. */
  hops: string[];
  deprecated?: string;
  /** Tombstoned (removed) on the way. */
  removed?: string;
  found: boolean;
}
