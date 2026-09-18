import { Component, SourceResult } from "./types";
import { collectMcpConfig } from "./sources/mcpConfig";
import { collectAppBundles } from "./sources/appBundles";
import { collectLaunchItems } from "./sources/launchItems";
import { collectLoginItems } from "./sources/loginItems";
import { collectHomebrew } from "./sources/homebrew";
import { collectNpmGlobal } from "./sources/npmGlobal";
import { collectPip } from "./sources/pip";
import {
  collectRunningProcesses,
  isRunning,
} from "./sources/processes";
import { dedupe } from "./dedup";
import { linkHostApps } from "./linking";
import { inspectSigning } from "./signing";
import { applyCatalog, loadCatalog } from "./catalog";
import * as path from "path";

export interface ScanResult {
  components: Component[];
  sources: SourceResult[];
}

// Run the full pipeline: sources -> dedup -> link -> signing -> running
// cross-reference -> catalog. Each stage is defensive; no source can halt the
// scan.
export function runScan(catalogPath: string): ScanResult {
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
  ];

  const raw: Component[] = sources.flatMap((s) => s.components);

  // Stage 3: unify + dedup, then resolve host-app links.
  const components = dedupe(raw);
  linkHostApps(components);

  // Stage 3: signing status for every resolved binary path (not only
  // unidentified ones). A discovered publisher can establish identity.
  for (const c of components) {
    if (c.path && path.isAbsolute(c.path)) {
      const info = inspectSigning(c.path);
      c.signingStatus = info.signingStatus;
      if (info.publisher && !c.publisher) c.publisher = info.publisher;
    }
    // Recompute identity now that signing may have added a publisher.
    c.identified = c.identified || !!c.publisher || !!c.bundleId;
  }

  // Cross-reference running processes to confirm running state only. A process
  // matching no discovered component is never added.
  const running = collectRunningProcesses();
  for (const c of components) {
    if (isRunning(c.path, running)) c.running = true;
  }

  // Stage 4: catalog lookup for still-unlabeled components only.
  const entries = loadCatalog(catalogPath);
  applyCatalog(components, entries);

  return { components, sources };
}
