import * as path from "path";
import { Component, SourceResult } from "./types";
import { collectMcpConfig } from "./sources/mcpConfig";
import { collectAppBundles } from "./sources/appBundles";
import { collectLaunchItems } from "./sources/launchItems";
import { collectLoginItems } from "./sources/loginItems";
import { collectHomebrew } from "./sources/homebrew";
import { collectNpmGlobal } from "./sources/npmGlobal";
import { collectPip } from "./sources/pip";
import { collectRunningProcesses, isRunning } from "./sources/processes";
import { dedupe } from "./dedup";
import { linkHostApps } from "./linking";
import { inspectSigning } from "./signing";
import { enrichComponent } from "./enrich";
import { Catalog, loadCatalog, isInScope, matchAgent, applyAgentIdentity } from "./catalog";

export interface ScanResult {
  components: Component[];
  sources: SourceResult[];
}

// Full pipeline. The ordering matters for both correctness and speed: cheap
// enumeration and the agent-scope filter come first, so the expensive per-
// component work (Info.plist parsing, codesign/spctl) runs only on the handful
// of components that are actually agents or declared MCP servers.
export function runScan(catalogPath: string): ScanResult {
  const catalog: Catalog = loadCatalog(catalogPath);

  // Stage 1 + 2: enumerate sources and parse (each returns silently if absent).
  const sources: SourceResult[] = [
    collectMcpConfig(),
    collectAppBundles(),
    collectLaunchItems(),
    collectLoginItems(),
    collectHomebrew(),
    collectNpmGlobal(),
    collectPip(),
  ];

  const raw: Component[] = sources.flatMap((s) => s.components);

  // Stage 3a: unify + dedup across sources.
  const deduped = dedupe(raw);

  // Stage 3b: scope filter — keep only declared MCP servers and allowlist
  // matches. Everything else is ordinary software and is dropped here, before
  // any expensive work.
  const components = deduped.filter((c) => isInScope(c, catalog));

  // Stage 3c: enrich survivors (Info.plist, launch-target resolution), then link
  // MCP servers to their host apps.
  for (const c of components) enrichComponent(c);
  linkHostApps(components);

  // Stage 3d: identity + signing for survivors only.
  for (const c of components) {
    const entry = matchAgent(c, catalog);
    if (entry) applyAgentIdentity(c, entry);

    if (c.path && path.isAbsolute(c.path)) {
      const info = inspectSigning(c.path);
      c.signingStatus = info.signingStatus;
      if (info.publisher && !c.publisher) c.publisher = info.publisher;
    }
    // A declared MCP server with no catalog match stays in scope but
    // unidentified (eligible for shadow reporting); everything else here matched
    // the allowlist and is identified.
    c.identified = c.identified || !!entry;
  }

  // Cross-reference running processes to confirm running state only.
  const running = collectRunningProcesses();
  for (const c of components) {
    if (isRunning(c.path, running)) c.running = true;
  }

  return { components, sources };
}
