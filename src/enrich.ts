import * as path from "path";
import { Component } from "./types";
import { readPlist, fileFirstSeen, pathExists } from "./util";

// Enrichment runs only on components that survive the agent-scope filter, so the
// expensive per-component work (Info.plist parsing via `plutil`, program-path
// resolution) is paid for a handful of agents instead of every app on disk.
export function enrichComponent(c: Component): void {
  if (c.installMethod === "app_bundle") enrichAppBundle(c);
  else if (c.installMethod === "launch_item") enrichLaunchItem(c);
}

interface InfoPlist {
  CFBundleIdentifier?: string;
  CFBundleName?: string;
  CFBundleDisplayName?: string;
  CFBundleExecutable?: string;
  CFBundleShortVersionString?: string;
  CFBundleVersion?: string;
}

function enrichAppBundle(c: Component): void {
  const infoPath = path.join(c.path, "Contents", "Info.plist");
  const info = readPlist<InfoPlist>(infoPath);
  if (!info) return;
  c.bundleId = info.CFBundleIdentifier || c.bundleId;
  c.version =
    info.CFBundleShortVersionString || info.CFBundleVersion || c.version;
  c.name = info.CFBundleDisplayName || info.CFBundleName || c.name;
  if (info.CFBundleExecutable) c.binaryName = info.CFBundleExecutable;
}

interface LaunchPlist {
  Label?: string;
  Program?: string;
  ProgramArguments?: string[];
}

function enrichLaunchItem(c: Component): void {
  // The plist path is preserved in the first source ref.
  const ref = (c.sourceRefs[0] || "").replace(/^launch_item:/, "");
  const plistPath = ref || c.path;
  const plist = readPlist<LaunchPlist>(plistPath);
  if (!plist) return;

  const program =
    plist.Program ||
    (Array.isArray(plist.ProgramArguments) && plist.ProgramArguments.length > 0
      ? plist.ProgramArguments[0]
      : undefined);
  if (plist.Label) c.name = plist.Label;
  if (program && path.isAbsolute(program)) {
    // Resolve to the target binary so signing runs against real code, and
    // refresh firstSeen from the binary when available.
    c.path = program;
    c.binaryName = path.basename(program);
    if (pathExists(program)) c.firstSeen = fileFirstSeen(program) || c.firstSeen;
  }
}
