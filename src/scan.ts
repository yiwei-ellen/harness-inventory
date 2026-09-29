import { Component, SourceResult } from "./types";
import { collectMcpConfig } from "./sources/mcpConfig";
import { collectAppBundles } from "./sources/appBundles";
import { collectLaunchItems } from "./sources/launchItems";
import { collectLoginItems } from "./sources/loginItems";
import { collectHomebrew } from "./sources/homebrew";
import { collectNpmGlobal } from "./sources/npmGlobal";
import { collectPip } from "./sources/pip";
import { collectCliOnPath } from "./sources/cliOnPath";
import { collectNativeHosts, collectBrowserExtensions } from "./sources/browser";
import {
  collectRunningProcesses,
  isRunning,
  ownPids,
  childrenOf,
} from "./sources/processes";
import { dedupe } from "./dedup";
import { enrichComponent } from "./enrich";
import { linkHostApps, absorbClis, linkBrowserBridges } from "./linking";
import { inspectSigning } from "./signing";
import {
  applyCatalog,
  checkPublishers,
  catalogCliNames,
  loadCatalog,
  isInScope,
  CatalogEntry,
} from "./catalog";
import { readTcc, applyPermissions, permissionsSource } from "./permissions";
import { applyFootprints, findLeftovers, Leftover } from "./footprint";
import * as path from "path";

export interface ScanResult {
  components: Component[];
  sources: SourceResult[];
  catalog: CatalogEntry[];
  // Known agents not installed here whose data is still on disk.
  leftovers: Leftover[];
  // Components found but left out as ordinary software (0 with --all).
  outOfScope: number;
}

export interface ScanOptions {
  // Keep every app and package, not just agent-related ones. Slower: every
  // app bundle then gets its Info.plist read and its signature checked.
  all?: boolean;
}

// Run the full pipeline:
//   sources -> dedup -> fold CLIs into their packages -> agent-scope filter ->
//   enrich survivors (Info.plist, launch targets) -> signing -> catalog (tag
//   agents, label strangers, check publishers) -> link (MCP servers to their
//   clients, browser bridges) -> running state + child processes -> privacy
//   permissions -> data footprints.
//
// The scope filter runs before enrichment and signing on purpose: those spawn
// a subprocess per component, so paying for them only on the handful of
// agents (instead of every app on disk) is what keeps a scan fast.
// Each stage is defensive; no source can halt the scan.
export function runScan(catalogPath: string, opts: ScanOptions = {}): ScanResult {
  const entries = loadCatalog(catalogPath);

  // Stage 1 + 2: enumerate sources and parse. Each collector returns silently
  // on an absent source.
  const sources: SourceResult[] = [
    collectMcpConfig(),
    collectAppBundles(),
    collectLaunchItems(),
    collectLoginItems(),
    collectHomebrew(),
    collectNpmGlobal(),
    collectPip(),
    collectCliOnPath(catalogCliNames(entries)),
    collectNativeHosts(),
    collectBrowserExtensions(),
  ];

  const raw: Component[] = sources.flatMap((s) => s.components);

  // Stage 3: unify + dedup. A CLI that resolves into a package or app the
  // inventory already has is folded into it.
  const deduped = absorbClis(dedupe(raw));

  // Stage 3: agent scope, then enrichment for what survives.
  const components = opts.all ? deduped : scopeToAgents(deduped, entries);
  for (const c of components) enrichComponent(c);

  // Stage 3: signing status for every resolved binary path (not only
  // unidentified ones). A discovered publisher can establish identity.
  for (const c of components) {
    const target = c.executablePath || c.path;
    if (shouldInspectSigning(c, target)) {
      const info = inspectSigning(target);
      c.signingStatus = info.signingStatus;
      if (info.publisher && !c.publisher) c.publisher = info.publisher;
      if (info.teamId) c.teamId = info.teamId;
    }
    // Recompute identity now that signing may have added a publisher.
    c.identified = c.identified || !!c.publisher || !!c.bundleId;
  }

  // Stage 4: catalog. Tags known agents, labels still-unlabeled components,
  // and compares signing teams to the catalog's record.
  applyCatalog(components, entries);
  checkPublishers(components, entries);

  // Links need catalog tags (an MCP server links to its client by catalog id).
  linkHostApps(components);
  linkBrowserBridges(components);

  // Cross-reference running processes to confirm running state, and list what
  // known agents have running underneath them. A process matching no
  // discovered component is never added.
  const running = collectRunningProcesses();
  for (const c of components) {
    if (c.installMethod === "browser_extension") continue;
    const target = c.executablePath || c.path;
    if (isRunning(target, running) || ownPids(c, running).size > 0) {
      c.running = true;
    }
    if (c.running && c.agent) {
      const { children } = childrenOf(c, running);
      if (children.length > 0) c.runningChildren = children;
    }
  }

  // Privacy permissions (only when the TCC databases are readable).
  const tcc = readTcc();
  applyPermissions(components, tcc.grants);
  sources.push(permissionsSource(tcc));

  // What each known agent keeps on disk.
  applyFootprints(components, entries);
  const leftovers = findLeftovers(components, entries);

  return {
    components,
    sources,
    catalog: entries,
    leftovers,
    outOfScope: deduped.length - components.length,
  };
}

// Keep declared MCP servers, catalog CLIs, and catalog matches; then the browser
// bridges whose program lives inside a kept app (or that the catalog knows),
// and the extensions those bridges allow. Everything else is ordinary software.
export function scopeToAgents(components: Component[], entries: CatalogEntry[]): Component[] {
  const kept = new Set<Component>(components.filter((c) => isInScope(c, entries)));

  const keptApps = Array.from(kept).filter((c) => c.installMethod === "app_bundle");
  for (const c of components) {
    if (c.installMethod !== "native_messaging_host" || kept.has(c)) continue;
    if (keptApps.some((a) => c.path.startsWith(a.path + "/"))) kept.add(c);
  }

  const allowed = new Set<string>();
  for (const c of kept) {
    if (c.installMethod !== "native_messaging_host") continue;
    for (const id of c.browser?.extensionIds ?? []) allowed.add(id.toLowerCase());
  }
  for (const c of components) {
    if (c.installMethod !== "browser_extension" || kept.has(c)) continue;
    if ((c.browser?.extensionIds ?? []).some((id) => allowed.has(id.toLowerCase()))) {
      kept.add(c);
    }
  }
  return components.filter((c) => kept.has(c));
}

function shouldInspectSigning(c: Component, target: string): boolean {
  if (!target || !path.isAbsolute(target)) return false;
  // Extension folders and config files are not signable code objects.
  if (c.installMethod === "browser_extension") return false;
  if (target.toLowerCase().endsWith(".json") || target.toLowerCase().endsWith(".toml")) {
    return false;
  }
  return true;
}
