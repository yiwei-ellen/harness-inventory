import { Component, SourceResult } from "../types";
import { safeExec } from "../util";
import { makeComponent } from "./base";

// User-level pip packages via `pip list --user --format=json`.
//
// Known v1 limitation (not solved here): packages installed inside virtual
// environments are invisible to a user-level pip listing. Enumerating arbitrary
// venvs would require walking the filesystem heuristically, which this tool
// deliberately does not do.
export function collectPip(): SourceResult {
  // Try pip3 first, then pip; either may be absent.
  let res = safeExec("pip3", ["list", "--user", "--format=json"]);
  if (!res.stdout.trim()) {
    res = safeExec("pip", ["list", "--user", "--format=json"]);
  }
  if (!res.stdout.trim()) {
    return { source: "pip", found: false, components: [] };
  }

  let data: any;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return { source: "pip", found: false, components: [] };
  }
  if (!Array.isArray(data)) {
    return { source: "pip", found: true, components: [] };
  }

  const components: Component[] = [];
  for (const pkg of data) {
    const name: string = pkg?.name;
    if (!name) continue;
    components.push(
      makeComponent({
        name,
        installMethod: "pip",
        // pip list does not report install location; leave path as the package
        // name marker. No absolute path means the signing pass is a no-op
        // (unknown), which is correct for a Python distribution.
        path: `pip:${name}`,
        version: pkg?.version,
        publisher: "pip (user)",
        firstSeen: "",
        sourceRefs: [`pip:${name}`],
        identified: true,
      })
    );
  }
  return { source: "pip", found: true, components };
}
