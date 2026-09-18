// Core data model. Deliberately platform-agnostic: a `platform` field is
// carried on every record, and macOS-specific concepts (bundle IDs, codesign)
// are named generically (`bundleId`, `signingStatus`) so the same schema can
// hold Windows or Linux records later without renaming fields.

export type InstallMethod =
  | "mcp_config"
  | "app_bundle"
  | "brew"
  | "npm"
  | "pip"
  | "launch_item";

// Four-value signing enum. `unknown` means "not determinable / not applicable"
// (e.g. a plain script that is not a signable code object), which is distinct
// from `unsigned` (a signable code object that is not signed).
export type SigningStatus =
  | "signed_notarized"
  | "signed_unnotarized"
  | "unsigned"
  | "unknown";

export interface Component {
  name: string;
  installMethod: InstallMethod;
  path: string;
  // Basename of the resolved executable/command (e.g. "Claude", "ollama",
  // "npx"). Distinct from `path`, which for an app bundle is the .app directory.
  // Shown as its own column so the actual binary behind a component is visible.
  binaryName?: string;
  // Platform this record was collected on. Always "macos" in this v1 collector;
  // present so the schema tolerates other platforms without changes.
  platform: string;
  bundleId?: string;
  publisher?: string;
  version?: string;
  signingStatus: SigningStatus;
  declaredCapabilities?: string[];
  // ISO timestamp derived from the source file's ctime (best-effort).
  firstSeen: string;
  // Provenance: every source that contributed to this record. Never discarded
  // on dedup merges.
  sourceRefs: string[];
  // true once a bundleId, publisher, or catalog match establishes identity,
  // or the record came from a registry that authoritatively names it
  // (brew/npm/pip) or from an MCP client config that declared it by name.
  identified: boolean;
  // Cross-referenced from the running-process list. Optional; absent means
  // "not observed running", not "not running".
  running?: boolean;
  // mcp_config records only: the client app that configured this server, as a
  // raw "name (path)" string until Stage 3 resolves it to a host identifier.
  hostApp?: string;
  // Resolved links populated in Stage 3 (e.g. a host app's list of the MCP
  // server identifiers it configures).
  relatedComponents?: string[];
}

// Result of enumerating one source: the records it produced plus whether the
// source was actually present on this machine (drives the end-of-scan summary).
export interface SourceResult {
  source: string;
  found: boolean;
  components: Component[];
}
