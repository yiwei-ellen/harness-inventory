import * as path from "path";
import { Component } from "./types";

// Dedup priority: bundleId -> resolved absolute path -> (name + installMethod).
// Merging preserves provenance (union of sourceRefs) and never drops identity.
export function dedupe(components: Component[]): Component[] {
  const byKey = new Map<string, Component>();

  for (const comp of components) {
    const key = dedupKey(comp);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...comp });
    } else {
      byKey.set(key, merge(existing, comp));
    }
  }

  return Array.from(byKey.values());
}

function dedupKey(c: Component): string {
  if (c.bundleId) return `bundle:${c.bundleId.toLowerCase()}`;
  // mcp_config servers share their config file's path, so keying on path would
  // wrongly merge sibling servers. Key on the server name scoped to its config
  // (first sourceRef references the config file), keeping siblings distinct
  // while still merging a re-read of the same server.
  if (c.installMethod === "mcp_config") {
    const scope = c.sourceRefs[0] || c.hostApp || c.path;
    return `mcp:${c.name.toLowerCase()}::${scope}`;
  }
  if (c.path && path.isAbsolute(c.path)) return `path:${c.path}`;
  return `nm:${c.name.toLowerCase()}::${c.installMethod}`;
}

// Merge two records that dedup to the same key. Field-by-field: keep the first
// defined/non-empty value, prefer identity-bearing data, and union the
// multi-valued fields (sourceRefs, relatedComponents, declaredCapabilities).
function merge(a: Component, b: Component): Component {
  const primary = scoreIdentity(a) >= scoreIdentity(b) ? a : b;
  const secondary = primary === a ? b : a;

  return {
    ...primary,
    bundleId: primary.bundleId ?? secondary.bundleId,
    publisher: primary.publisher ?? secondary.publisher,
    version: primary.version ?? secondary.version,
    hostApp: primary.hostApp ?? secondary.hostApp,
    signingStatus:
      primary.signingStatus !== "unknown"
        ? primary.signingStatus
        : secondary.signingStatus,
    declaredCapabilities: unionArr(
      primary.declaredCapabilities,
      secondary.declaredCapabilities
    ),
    firstSeen: earliest(primary.firstSeen, secondary.firstSeen),
    sourceRefs: uniq([...(a.sourceRefs || []), ...(b.sourceRefs || [])]),
    relatedComponents: unionArr(
      primary.relatedComponents,
      secondary.relatedComponents
    ),
    running: primary.running || secondary.running,
    identified: primary.identified || secondary.identified,
    teamId: primary.teamId ?? secondary.teamId,
    binaryName: primary.binaryName ?? secondary.binaryName,
    executablePath: primary.executablePath ?? secondary.executablePath,
    mcp: primary.mcp ?? secondary.mcp,
    browser: mergeBrowser(primary.browser, secondary.browser),
  };
}

function mergeBrowser(
  a: Component["browser"],
  b: Component["browser"]
): Component["browser"] {
  if (!a) return b;
  if (!b) return a;
  return {
    browsers: uniq([...a.browsers, ...b.browsers]),
    extensionIds: unionArr(a.extensionIds, b.extensionIds),
    permissions: unionArr(a.permissions, b.permissions),
  };
}

// Prefer records that carry more identity when choosing the primary.
function scoreIdentity(c: Component): number {
  let s = 0;
  if (c.bundleId) s += 4;
  if (c.publisher) s += 2;
  if (c.identified) s += 1;
  return s;
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

function unionArr(
  a?: string[],
  b?: string[]
): string[] | undefined {
  if (!a && !b) return undefined;
  return uniq([...(a || []), ...(b || [])]);
}

function earliest(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
