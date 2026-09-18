import { Component, SourceResult } from "../types";
import { safeExec, fileFirstSeen, pathExists } from "../util";
import { makeComponent } from "./base";

// Login items are enumerated via System Events (AppleScript). Each login item
// references an app/executable path. We classify them under the "launch_item"
// install method: like LaunchAgents, a login item is a mechanism that causes
// software to run at login — folding both into one method keeps the enum small,
// and dedup merges a login item into its app_bundle when the path matches.
// (Assumption noted inline per the spec's ambiguity guidance.)
export function collectLoginItems(): SourceResult {
  // Ask for name + path of every login item, one record per line as "name\tpath".
  const script =
    'set out to ""\n' +
    'tell application "System Events"\n' +
    "  repeat with li in login items\n" +
    '    set out to out & (name of li) & "\\t" & (path of li) & "\\n"\n' +
    "  end repeat\n" +
    "end tell\n" +
    "return out";

  const res = safeExec("osascript", ["-e", script]);
  if (!res.ok) {
    // System Events unavailable, permission denied, or off-macOS: report the
    // source as not found rather than throwing.
    return { source: "login_item", found: false, components: [] };
  }

  const components: Component[] = [];
  for (const line of res.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, itemPath] = trimmed.split("\t");
    if (!name) continue;
    const p = (itemPath || "").trim();
    components.push(
      makeComponent({
        name: name.trim(),
        installMethod: "launch_item",
        path: p,
        firstSeen: p && pathExists(p) ? fileFirstSeen(p) : "",
        sourceRefs: [`login_item:${name.trim()}`],
        identified: false,
      })
    );
  }
  return { source: "login_item", found: true, components };
}
