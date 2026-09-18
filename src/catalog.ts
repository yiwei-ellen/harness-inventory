import * as path from "path";
import { Component } from "./types";
import { readJsonFile } from "./util";

// One allowlist entry: a known agent and the exact identifiers that match it.
export interface AgentEntry {
  displayName: string;
  publisher?: string;
  names: string[]; // exact name matches (a/an .app/.exe suffix is ignored)
  binaries: string[]; // exact executable basename matches
  bundleIds: string[]; // exact bundle id matches
  tokens: string[]; // specific substrings matched against path / launch-item label
  declaredCapabilities?: string[];
}

export interface Catalog {
  agents: AgentEntry[];
}

export function defaultCatalogPath(): string {
  // Shipped alongside the compiled code: dist/ -> ../catalog/known-agents.json.
  return path.join(__dirname, "..", "catalog", "known-agents.json");
}

export function loadCatalog(catalogPath: string): Catalog {
  const data = readJsonFile<{ agents?: AgentEntry[] }>(catalogPath);
  const agents = Array.isArray(data?.agents) ? data!.agents! : [];
  // Normalize the match fields once so matching is plain set/substring lookups.
  for (const a of agents) {
    a.names = (a.names || []).map(normalize);
    a.binaries = (a.binaries || []).map(normalize);
    a.bundleIds = (a.bundleIds || []).map((s) => s.toLowerCase());
    a.tokens = (a.tokens || []).map((s) => s.toLowerCase());
  }
  return { agents };
}

// Lowercase and drop a trailing .app/.exe so "Claude.app" and "claude.exe" both
// compare as "claude".
function normalize(s: string): string {
  return (s || "").trim().toLowerCase().replace(/\.(app|exe)$/i, "");
}

function basename(p: string): string {
  if (!p) return "";
  return normalize(path.basename(p));
}

// Exact allowlist match: return the first agent entry a component matches, or
// undefined. All tests are equality / set-membership / exact substring — never
// fuzzy scoring.
export function matchAgent(c: Component, catalog: Catalog): AgentEntry | undefined {
  const name = normalize(c.name);
  const bundle = (c.bundleId || "").toLowerCase();
  // For an MCP server, `path` is the host's config file (e.g. ~/.cursor/mcp.json)
  // and the source ref names it too — matching tokens against those would
  // misattribute every server to its host app. So an MCP server is matched only
  // by its own name and launch command; path/label token matching is skipped.
  const isMcp = c.installMethod === "mcp_config";
  const base = normalize(c.binaryName || (isMcp ? "" : basename(c.path)));
  const pathLc = isMcp ? "" : (c.path || "").toLowerCase();
  // Launch/login items carry their reverse-DNS label as the name and often in
  // the source ref; check both against tokens.
  const label = isMcp ? "" : `${name} ${(c.sourceRefs || []).join(" ")}`.toLowerCase();

  for (const a of catalog.agents) {
    if (name && a.names.includes(name)) return a;
    if (base && (a.binaries.includes(base) || a.names.includes(base))) return a;
    if (bundle && a.bundleIds.includes(bundle)) return a;
    for (const t of a.tokens) {
      if (t && (pathLc.includes(t) || label.includes(t))) return a;
    }
  }
  return undefined;
}

// A component belongs in the report if it is a declared MCP server (in scope by
// definition) or it matches the agent allowlist.
export function isInScope(c: Component, catalog: Catalog): boolean {
  return c.installMethod === "mcp_config" || !!matchAgent(c, catalog);
}

// Apply a catalog entry's identity to a matched component: set the canonical
// display name, publisher, and declared capabilities, and mark it identified.
export function applyAgentIdentity(c: Component, entry: AgentEntry): void {
  c.name = entry.displayName || c.name;
  // The catalog's publisher is the authoritative product vendor; it takes
  // precedence over an install-channel string like "npm (global)".
  if (entry.publisher) c.publisher = entry.publisher;
  if (entry.declaredCapabilities && entry.declaredCapabilities.length > 0) {
    c.declaredCapabilities = entry.declaredCapabilities;
  }
  c.sourceRefs = [...c.sourceRefs, `catalog:${entry.displayName}`];
  c.identified = true;
}
