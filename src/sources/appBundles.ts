import * as path from "path";
import { Component, SourceResult } from "../types";
import {
  homeDir,
  listDir,
  isDirectory,
  pathExists,
  readPlist,
  fileFirstSeen,
} from "../util";
import { makeComponent } from "./base";

// Scan /Applications and ~/Applications for top-level *.app bundles. We do not
// recurse into subfolders in v1 (a reasonable scope choice; nested app bundles
// are uncommon and would slow the scan) — noted here as an assumption.
function appDirs(): string[] {
  return ["/Applications", path.join(homeDir(), "Applications")];
}

interface InfoPlist {
  CFBundleIdentifier?: string;
  CFBundleName?: string;
  CFBundleDisplayName?: string;
  CFBundleShortVersionString?: string;
  CFBundleVersion?: string;
}

function parseBundle(appPath: string): Component | null {
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  const info = readPlist<InfoPlist>(infoPath);
  const base = path.basename(appPath).replace(/\.app$/i, "");

  const name = info?.CFBundleDisplayName || info?.CFBundleName || base;
  const bundleId = info?.CFBundleIdentifier;
  const version =
    info?.CFBundleShortVersionString || info?.CFBundleVersion || undefined;

  return makeComponent({
    name,
    installMethod: "app_bundle",
    path: appPath,
    bundleId,
    version,
    firstSeen: fileFirstSeen(appPath),
    sourceRefs: [`app_bundle:${appPath}`],
    // A bundle identifier from Info.plist is structured identity — no catalog
    // needed. A bundle with no readable identifier stays unidentified until
    // signing (publisher) or the catalog resolves it.
    identified: !!bundleId,
  });
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
      if (!pathExists(appPath)) continue;
      const comp = parseBundle(appPath);
      if (comp) components.push(comp);
    }
  }
  return { source: "app_bundle", found: anyFound, components };
}
