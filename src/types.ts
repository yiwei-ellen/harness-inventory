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
  | "launch_item"
  // A catalog-listed agent CLI found on PATH (or a well-known bin dir) that no
  // package manager accounts for, e.g. a native installer's ~/.local/bin/claude.
  | "cli_on_path"
  // A browser native-messaging host manifest: the bridge a browser extension
  // uses to talk to a program on this Mac.
  | "native_messaging_host"
  // A Chromium-family browser extension, read from the profile's manifest.
  | "browser_extension";

// Four-value signing enum. `unknown` means "not determinable / not applicable"
// (e.g. a plain script that is not a signable code object), which is distinct
// from `unsigned` (a signable code object that is not signed).
export type SigningStatus =
  | "signed_notarized"
  | "signed_unnotarized"
  | "unsigned"
  | "unknown";

// Does the signing team on disk match the team the catalog records for this
// agent? Plain fact, no score.
//   matches_catalog      signed by a team the catalog lists for this agent
//   differs_from_catalog signed, but by a team the catalog does NOT list
//   no_catalog_record    signed, but the catalog has no team on file yet
//   not_applicable       nothing to compare (not a catalog agent, or no
//                        team identifier on disk: unsigned, script, package dir)
export type PublisherCheck =
  | "matches_catalog"
  | "differs_from_catalog"
  | "no_catalog_record"
  | "not_applicable";

// Catalog classification: which known agent this component is.
export interface AgentInfo {
  catalogId: string;
  kind: string; // e.g. "cli", "desktop-app", "ide", "mcp-server"
  displayName: string;
}

// Declared details of an MCP server, transcribed from the client's config.
// Deliberately lossy: env VALUES, full URLs (which can carry tokens in the
// query string) and full args are never recorded.
export interface McpServerDetails {
  transport: "stdio" | "http" | "unknown";
  // Command as declared: a bare name ("npx") or a generalized absolute path.
  command?: string;
  // The package/image a launcher command runs (npx/bunx/uvx/pipx/docker).
  launches?: string;
  // Host (and port) of a remote server URL. Never the path or query.
  urlHost?: string;
  // Names of env vars the config passes to the server. Names only.
  envKeys?: string[];
  // Tools the server declares (Claude Desktop extension manifests list them).
  tools?: string[];
  // false when the config marks the server disabled.
  enabled?: boolean;
  // "user" for machine-wide config, or "project ~/code/x" for per-project
  // entries kept in a machine-wide file (e.g. ~/.claude.json).
  scope?: string;
  // Catalog id of the client that configured this server, used for linking.
  clientId?: string;
}

// Browser-side details for native messaging hosts and extensions.
export interface BrowserDetails {
  browsers: string[];
  // Native host: extension IDs the manifest allows to connect.
  // Extension: its own ID.
  extensionIds?: string[];
  // Extension: declared permissions + host permissions (names only).
  permissions?: string[];
}

export type DataKind =
  | "transcripts"
  | "instructions"
  | "history"
  | "credentials"
  | "models"
  | "config"
  | "logs"
  | "data";

// Something an agent leaves on disk. Size and location only; contents are
// never read.
export interface DataFootprint {
  path: string; // generalized (~)
  kind: DataKind;
  bytes: number;
  files: number;
  // true when the walk hit its file-count cap, so bytes/files are lower bounds.
  truncated: boolean;
  lastModified: string; // ISO, "" if unknown
}

// A process running underneath a running agent.
export interface ChildProcess {
  pid: number;
  // Executable basename plus its first positional argument, e.g. "git push".
  label: string;
}

// macOS privacy permissions a terminal/IDE holds, which CLI agents launched
// from inside it inherit.
export interface InheritedPermission {
  from: string; // display name of the terminal/IDE
  permissions: string[];
}

export interface Component {
  name: string;
  installMethod: InstallMethod;
  path: string;
  // Platform this record was collected on. Always "macos" in this v1 collector;
  // present so the schema tolerates other platforms without changes.
  platform: string;
  bundleId?: string;
  publisher?: string;
  version?: string;
  signingStatus: SigningStatus;
  // Apple Developer team identifier from the code signature, when present.
  teamId?: string;
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

  // --- Added in catalog v2 -------------------------------------------------
  // The binary actually executed, when it differs from `path` (e.g. a brew
  // formula whose path is its opt dir). Used for signing and running checks.
  executablePath?: string;
  // Set when the catalog recognizes this component as a known agent.
  agent?: AgentInfo;
  publisherCheck?: PublisherCheck;
  mcp?: McpServerDetails;
  browser?: BrowserDetails;
  // Human-readable macOS privacy permissions granted to this component.
  permissions?: string[];
  // CLI agents: permissions they inherit when launched from a terminal/IDE.
  inheritedPermissions?: InheritedPermission[];
  // What this agent keeps on disk (catalog-listed locations that exist).
  footprint?: DataFootprint[];
  // Processes currently running underneath this component.
  runningChildren?: ChildProcess[];
}

// Result of enumerating one source: the records it produced plus whether the
// source was actually present on this machine (drives the end-of-scan summary).
export interface SourceResult {
  source: string;
  found: boolean;
  components: Component[];
  // Optional one-line note for the end-of-scan summary (e.g. why a source
  // could not be read).
  note?: string;
}
