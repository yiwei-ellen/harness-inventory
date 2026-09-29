import * as path from "path";
import { Component, SourceResult } from "../types";
import { homeDir, listDir, isDirectory, fileFirstSeen } from "../util";
import { makeComponent } from "./base";

// LaunchAgents / LaunchDaemons directories. These hold plists that declare a
// program to run at load/login.
function launchDirs(): string[] {
  return [
    path.join(homeDir(), "Library/LaunchAgents"),
    "/Library/LaunchAgents",
    "/Library/LaunchDaemons",
  ];
}

// Cheap collection: the plist filename (minus .plist) is the item's label — and
// for launchd items the label almost always equals the reverse-DNS name inside
// the plist, so it is enough to decide agent scope. Parsing the plist to find
// the target program (a `plutil` subprocess) is deferred to enrichment, which
// runs only on items that survive the scope filter. This avoids a subprocess per
// launch item on machines that have many.
export function collectLaunchItems(): SourceResult {
  let anyFound = false;
  const components: Component[] = [];
  for (const dir of launchDirs()) {
    if (!isDirectory(dir)) continue;
    anyFound = true;
    for (const entry of listDir(dir)) {
      if (!entry.toLowerCase().endsWith(".plist")) continue;
      const plistPath = path.join(dir, entry);
      const label = entry.replace(/\.plist$/i, "");
      components.push(
        makeComponent({
          name: label,
          installMethod: "launch_item",
          // Points at the plist until enrichment resolves the target program.
          path: plistPath,
          firstSeen: fileFirstSeen(plistPath),
          sourceRefs: [`launch_item:${plistPath}`],
          identified: false,
        })
      );
    }
  }
  return { source: "launch_item", found: anyFound, components };
}
