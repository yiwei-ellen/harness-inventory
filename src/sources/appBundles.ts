import * as path from "path";
import { Component, SourceResult } from "../types";
import { homeDir, listDir, isDirectory, fileFirstSeen } from "../util";
import { makeComponent } from "./base";

// Scan /Applications and ~/Applications for top-level *.app bundles. We do not
// recurse into subfolders in v1 (nested app bundles are uncommon and would slow
// the scan) — noted as an assumption.
//
// This collector is deliberately cheap: it records only the bundle's folder name
// and path. Reading Info.plist (a `plutil` subprocess) and running the signing
// tools is deferred to the enrichment stage, which runs only on the few bundles
// that survive the agent-scope filter — so a machine with dozens of apps does
// not pay a per-app subprocess cost.
function appDirs(): string[] {
  return ["/Applications", path.join(homeDir(), "Applications")];
}

export function collectAppBundles(): SourceResult {
  let anyFound = false;
  const components: Component[] = [];
  for (const dir of appDirs()) {
    if (!isDirectory(dir)) continue;
    anyFound = true;
    for (const entry of listDir(dir)) {
      if (!entry.toLowerCase().endsWith(".app")) continue;
      const appPath = path.join(dir, entry);
      components.push(
        makeComponent({
          name: entry.replace(/\.app$/i, ""),
          installMethod: "app_bundle",
          path: appPath,
          firstSeen: fileFirstSeen(appPath),
          sourceRefs: [`app_bundle:${appPath}`],
          identified: false,
        })
      );
    }
  }
  return { source: "app_bundle", found: anyFound, components };
}
