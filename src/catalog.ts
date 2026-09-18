import * as path from "path";
import { Component } from "./types";
import { readJsonFile } from "./util";

interface CatalogMatch {
  bundleId: string | null;
  pathContains: string | null;
  nameExact: string | null;
}

interface CatalogIdentity {
  displayName: string;
  publisher?: string;
  homepage?: string;
}

interface CatalogEntry {
  match: CatalogMatch;
  identity: CatalogIdentity;
  declaredCapabilities?: string[];
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
  return data.entries;
}

// Stage 4: catalog lookup. Runs ONLY for Components that structured parsing
// could not identify (no bundleId, no publisher, no declaredCapabilities, and
// identified === false). Applies the first exact match; never guesses.
export function applyCatalog(
  components: Component[],
  entries: CatalogEntry[]
): void {
  for (const comp of components) {
    if (!isUnlabeled(comp)) continue;
    const entry = firstMatch(comp, entries);
    if (!entry) continue; // no match -> stays unidentified

    comp.name = entry.identity.displayName || comp.name;
    if (entry.identity.publisher) comp.publisher = entry.identity.publisher;
    if (entry.declaredCapabilities && entry.declaredCapabilities.length > 0) {
      comp.declaredCapabilities = entry.declaredCapabilities;
    }
    comp.sourceRefs = [...comp.sourceRefs, `catalog:${entry.identity.displayName}`];
    comp.identified = true;
  }
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
    if (matches(c, e.match)) return e;
  }
  return undefined;
}

// Every non-null field in the match block must match. An all-null match block
// matches nothing (guarded), so a lazy entry can't sweep in everything.
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
