import * as path from "path";
import { Component, SourceResult } from "../types";
import {
  homeDir,
  listDir,
  isDirectory,
  readPlist,
  fileFirstSeen,
} from "../util";
import { makeComponent } from "./base";

// LaunchAgents / LaunchDaemons directories. These hold plists that declare a
// program to run; we transcribe the declared Label and program path.
function launchDirs(): string[] {
  return [
    path.join(homeDir(), "Library/LaunchAgents"),
    "/Library/LaunchAgents",
    "/Library/LaunchDaemons",
  ];
}

interface LaunchPlist {
  Label?: string;
  Program?: string;
  ProgramArguments?: string[];
}

function parsePlistFile(plistPath: string): Component | null {
  const plist = readPlist<LaunchPlist>(plistPath);
  if (!plist) return null;

  // Program path: explicit Program, else first ProgramArguments element.
  const program =
    plist.Program ||
    (Array.isArray(plist.ProgramArguments) && plist.ProgramArguments.length > 0
      ? plist.ProgramArguments[0]
      : undefined);

  const label = plist.Label || path.basename(plistPath).replace(/\.plist$/i, "");
  // path points at the launched program when known (so signing can run), else
  // at the plist itself so provenance is never empty.
  const resolvedPath = program && path.isAbsolute(program) ? program : plistPath;

  return makeComponent({
    name: label,
    installMethod: "launch_item",
    path: resolvedPath,
    firstSeen: fileFirstSeen(plistPath),
    sourceRefs: [`launch_item:${plistPath}`],
    // Launch items carry no inherent identity. Identity must come from a code
    // signing publisher, a resolved app bundle (via dedup), or the catalog.
    identified: false,
  });
}

export function collectLaunchItems(): SourceResult {
  let anyFound = false;
  const components: Component[] = [];
  for (const dir of launchDirs()) {
    if (!isDirectory(dir)) continue;
    anyFound = true;
    for (const entry of listDir(dir)) {
      if (!entry.toLowerCase().endsWith(".plist")) continue;
      const comp = parsePlistFile(path.join(dir, entry));
      if (comp) components.push(comp);
    }
  }
  return { source: "launch_item", found: anyFound, components };
}
