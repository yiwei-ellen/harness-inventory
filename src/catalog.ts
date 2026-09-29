import * as path from "path";
import { Component, DataKind, PublisherCheck } from "./types";
import { readJsonFile } from "./util";

// ---------------------------------------------------------------------------
// Catalog format
//
// Two kinds of match block are supported, and an entry may carry either or
// both:
//
//   match  (v1)  Every non-null field must match (AND). Used by the original
//                community entries; semantics unchanged.
//   detect (v2)  Lists of exact identifiers; ANY listed identifier matching is
//                a match (OR). Each list is scoped to the install method it
//                makes sense for (a cliName only matches a CLI found on PATH,
//                an npm package name only matches an npm component, ...), so
//                an exact identifier can't sweep in unrelated software.
//
// Neither kind ever guesses: no fuzzy names, no substring matching on names.
// ---------------------------------------------------------------------------

interface CatalogMatch {
  bundleId: string | null;
  pathContains: string | null;
  nameExact: string | null;
}

export interface CatalogDetect {
  bundleIds?: string[];
  // Exact .app display/bundle name (e.g. "Claude"). Weaker than a bundle ID:
  // anyone can name an app "Claude". The signing team check exists for this.
  appNames?: string[];
  // Executable names looked up on PATH and well-known bin dirs.
  cliNames?: string[];
  // Exact npm package names. A trailing "*" makes it a prefix match
  // ("@modelcontextprotocol/server-*").
  npmPackages?: string[];
  // Homebrew formula names or cask tokens (as they appear in `brew info`).
  brewNames?: string[];
  pipPackages?: string[];
  // Native messaging host names ("com.anthropic.claude_browser_extension").
  nativeHostNames?: string[];
  // Chromium extension IDs.
  extensionIds?: string[];
  // Reverse-DNS prefixes for launch agents/daemons and login items, matched
  // against the item's label at a dot boundary ("com.anthropic." matches
  // "com.anthropic.claudefordesktop.ShipIt", never "com.anthropicx.y").
  labelPrefixes?: string[];
}

interface CatalogIdentity {
  displayName: string;
  publisher?: string;
  homepage?: string;
}

export interface CatalogDataPath {
  path: string; // "~/..." or absolute
  kind: DataKind;
  note?: string;
}

export interface CatalogEntry {
  id?: string;
  kind?: string;
  match?: CatalogMatch;
  detect?: CatalogDetect;
  identity: CatalogIdentity;
  declaredCapabilities?: string[];
  signing?: {
    // Apple Developer team identifiers this agent is known to ship under.
    teamIds?: string[];
    // Where the team ID was observed (codesign Authority line, vendor docs).
    evidence?: string;
  };
  // Where this agent keeps transcripts, instructions, logins, models...
  dataPaths?: CatalogDataPath[];
}

interface CatalogFile {
  entries: CatalogEntry[];
}

export function defaultCatalogPath(): string {
  // Shipped alongside the compiled code: dist/ -> ../catalog/known-agents.json.
  return path.join(__dirname, "..", "catalog", "known-agents.json");
}

export function loadCatalog(catalogPath: string): CatalogEntry[] {
  const data = readJsonFile<CatalogFile>(catalogPath);
  if (!data || !Array.isArray(data.entries)) return [];
  return data.entries.filter(
    (e) => e && typeof e === "object" && e.identity && e.identity.displayName
  );
}

// Stable id for an entry. v1 entries may lack one; derive it from the name.
export function entryId(e: CatalogEntry): string {
  if (e.id) return e.id;
  return e.identity.displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Every CLI name the catalog knows, for the PATH source.
export function catalogCliNames(entries: CatalogEntry[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    for (const n of e.detect?.cliNames ?? []) {
      // A CLI name is looked up as a file name: refuse anything path-like.
      if (n && !n.includes("/") && !n.includes("\\")) out.add(n);
    }
  }
  return Array.from(out);
}

export function entriesById(entries: CatalogEntry[]): Map<string, CatalogEntry> {
  const m = new Map<string, CatalogEntry>();
  for (const e of entries) {
    const id = entryId(e);
    if (!m.has(id)) m.set(id, e);
  }
  return m;
}

// Stage 4: catalog lookup.
//
// Every component is checked against the catalog; the first matching entry
// tags it as a known agent (`agent`). Only components that structured parsing
// could NOT identify (no bundleId, no publisher, no declaredCapabilities, and
// identified === false) are renamed/labeled from the catalog — an identified
// component keeps the name its own metadata gave it. One exception: a CLI
// found on PATH is named after its binary ("claude"), so it always takes the
// catalog's display name ("Claude Code"). No match means nothing changes.
export function applyCatalog(
  components: Component[],
  entries: CatalogEntry[]
): void {
  for (const comp of components) {
    const entry = firstMatch(comp, entries);
    if (!entry) continue; // no match -> stays as it was

    comp.agent = {
      catalogId: entryId(entry),
      kind: entry.kind || "agent",
      displayName: entry.identity.displayName,
    };

    const relabel = isUnlabeled(comp) || comp.installMethod === "cli_on_path";
    if (!relabel) {
      if (
        (!comp.declaredCapabilities || comp.declaredCapabilities.length === 0) &&
        entry.declaredCapabilities &&
        entry.declaredCapabilities.length > 0
      ) {
        comp.declaredCapabilities = entry.declaredCapabilities;
      }
      continue;
    }

    comp.name = entry.identity.displayName || comp.name;
    if (entry.identity.publisher && !comp.publisher) {
      comp.publisher = entry.identity.publisher;
    }
    if (entry.declaredCapabilities && entry.declaredCapabilities.length > 0) {
      comp.declaredCapabilities = entry.declaredCapabilities;
    }
    comp.sourceRefs = [...comp.sourceRefs, `catalog:${entry.identity.displayName}`];
    comp.identified = true;
  }
}

// Agent scope. A component belongs in the default report when it is a
// declared MCP server, a catalog-listed CLI found on PATH, or matches a catalog
// entry. Runs BEFORE enrichment, so it only relies on what cheap collection
// provides (names, paths, package names, labels); bundle IDs are checked again
// after Info.plist is read.
export function isInScope(c: Component, entries: CatalogEntry[]): boolean {
  if (c.installMethod === "mcp_config" || c.installMethod === "cli_on_path") return true;
  return !!firstMatch(c, entries);
}

// Compare each catalog agent's on-disk signing team to the catalog's record.
export function checkPublishers(
  components: Component[],
  entries: CatalogEntry[]
): void {
  const byId = entriesById(entries);
  for (const c of components) {
    if (!c.agent) continue;
    const entry = byId.get(c.agent.catalogId);
    c.publisherCheck = publisherCheckFor(c.teamId, entry?.signing?.teamIds ?? []);
  }
}

export function publisherCheckFor(
  teamId: string | undefined,
  catalogTeams: string[]
): PublisherCheck {
  if (!teamId) return "not_applicable";
  if (catalogTeams.length === 0) return "no_catalog_record";
  const t = teamId.toUpperCase();
  return catalogTeams.some((x) => x.toUpperCase() === t)
    ? "matches_catalog"
    : "differs_from_catalog";
}

// For `catalog suggest`: catalog agents signed on this Mac whose team the
// catalog doesn't record yet (or records differently). Output is a starting
// point for a catalog PR, reviewed by a human — never applied automatically.
export interface TeamSuggestion {
  catalogId: string;
  displayName: string;
  observedTeamId: string;
  observedPublisher: string;
  catalogTeamIds: string[];
  status: PublisherCheck;
}

export function suggestTeamIds(
  components: Component[],
  entries: CatalogEntry[]
): TeamSuggestion[] {
  const byId = entriesById(entries);
  const out: TeamSuggestion[] = [];
  const seen = new Set<string>();
  for (const c of components) {
    if (!c.agent || !c.teamId) continue;
    if (c.publisherCheck === "matches_catalog") continue;
    const key = `${c.agent.catalogId}:${c.teamId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = byId.get(c.agent.catalogId);
    out.push({
      catalogId: c.agent.catalogId,
      displayName: c.agent.displayName,
      observedTeamId: c.teamId,
      observedPublisher: c.publisher || "",
      catalogTeamIds: entry?.signing?.teamIds ?? [],
      status: c.publisherCheck || "not_applicable",
    });
  }
  return out;
}

function isUnlabeled(c: Component): boolean {
  return (
    !c.identified &&
    !c.bundleId &&
    !c.publisher &&
    (!c.declaredCapabilities || c.declaredCapabilities.length === 0)
  );
}

function firstMatch(
  c: Component,
  entries: CatalogEntry[]
): CatalogEntry | undefined {
  for (const e of entries) {
    if (e.detect && detectMatches(c, e.detect)) return e;
    if (e.match && matches(c, e.match)) return e;
  }
  return undefined;
}

// v1: every non-null field in the match block must match. An all-null match
// block matches nothing (guarded), so a lazy entry can't sweep in everything.
function matches(c: Component, m: CatalogMatch): boolean {
  const tests: boolean[] = [];
  if (m.bundleId != null) {
    tests.push((c.bundleId || "").toLowerCase() === m.bundleId.toLowerCase());
  }
  if (m.pathContains != null) {
    tests.push((c.path || "").toLowerCase().includes(m.pathContains.toLowerCase()));
  }
  if (m.nameExact != null) {
    tests.push((c.name || "").toLowerCase() === m.nameExact.toLowerCase());
  }
  if (tests.length === 0) return false; // no criteria -> never matches
  return tests.every(Boolean);
}

const lc = (s: string | undefined) => (s || "").toLowerCase();

// Python package names compare case-insensitively with - _ . equivalent.
const pyNorm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, "-");

// v2: any listed identifier matching (scoped to its install method) matches.
export function detectMatches(c: Component, d: CatalogDetect): boolean {
  if (d.bundleIds && c.bundleId) {
    if (d.bundleIds.some((b) => lc(b) === lc(c.bundleId))) return true;
  }

  if (d.appNames && c.installMethod === "app_bundle") {
    const base = path.basename(c.path || "").replace(/\.app$/i, "");
    if (d.appNames.some((n) => lc(n) === lc(c.name) || lc(n) === lc(base))) {
      return true;
    }
  }

  if (d.cliNames) {
    const cliRefs = c.sourceRefs
      .filter((r) => r.startsWith("cli:"))
      .map((r) => lc(r.slice(4)));
    if (c.installMethod === "cli_on_path") cliRefs.push(lc(c.name));
    if (d.cliNames.some((n) => cliRefs.includes(lc(n)))) return true;
  }

  if (d.npmPackages && c.installMethod === "npm") {
    const name = lc(c.name);
    for (const p of d.npmPackages) {
      if (p.endsWith("*")) {
        const prefix = lc(p.slice(0, -1));
        if (prefix && name.startsWith(prefix)) return true;
      } else if (lc(p) === name) {
        return true;
      }
    }
  }

  if (d.brewNames) {
    const brewRefs = c.sourceRefs
      .filter((r) => r.startsWith("brew:formula:") || r.startsWith("brew:cask:"))
      .map((r) => lc(r.replace(/^brew:(formula|cask):/, "")));
    for (const b of d.brewNames) {
      const want = lc(b);
      // A formula may be recorded with its tap ("sst/tap/opencode"); compare
      // both the full name and the short name.
      if (brewRefs.some((r) => r === want || r.split("/").pop() === want)) {
        return true;
      }
    }
  }

  if (d.pipPackages && c.installMethod === "pip") {
    if (d.pipPackages.some((p) => pyNorm(p) === pyNorm(c.name))) return true;
  }

  if (d.nativeHostNames && c.installMethod === "native_messaging_host") {
    if (d.nativeHostNames.some((n) => lc(n) === lc(c.name))) return true;
  }

  if (d.extensionIds && c.installMethod === "browser_extension") {
    const ids = (c.browser?.extensionIds ?? []).map(lc);
    if (d.extensionIds.some((x) => ids.includes(lc(x)))) return true;
  }

  if (d.labelPrefixes && c.installMethod === "launch_item") {
    const label = lc(c.name);
    for (const raw of d.labelPrefixes) {
      const p = lc(raw);
      if (!p) continue;
      const prefix = p.endsWith(".") ? p : p + ".";
      if (label === p.replace(/\.$/, "") || label.startsWith(prefix)) return true;
    }
  }

  return false;
}
