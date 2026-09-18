import * as path from "path";
import { Component, SourceResult } from "../types";
import { safeExec, fileFirstSeen, pathExists } from "../util";
import { makeComponent } from "./base";

// Globally installed npm packages via `npm ls -g --json --depth=0`.
export function collectNpmGlobal(): SourceResult {
  const res = safeExec("npm", ["ls", "-g", "--json", "--depth=0"]);
  // npm exits non-zero when there are peer-dep problems but still prints valid
  // JSON, so parse stdout regardless of exit code.
  if (!res.stdout.trim()) {
    return { source: "npm", found: false, components: [] };
  }

  let data: any;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return { source: "npm", found: false, components: [] };
  }

  const deps = data?.dependencies;
  if (!deps || typeof deps !== "object") {
    return { source: "npm", found: true, components: [] };
  }

  // Resolve the global prefix so we can record a real path per package.
  const prefixRes = safeExec("npm", ["prefix", "-g"]);
  const globalRoot = prefixRes.ok
    ? path.join(prefixRes.stdout.trim(), "lib", "node_modules")
    : "";

  const components: Component[] = [];
  for (const [name, info] of Object.entries<any>(deps)) {
    const version: string | undefined = info?.version;
    const pkgPath =
      info?.path || (globalRoot ? path.join(globalRoot, name) : name);
    components.push(
      makeComponent({
        name,
        installMethod: "npm",
        path: pkgPath,
        binaryName: name,
        version,
        // Named authoritatively by the npm global registry -> identified via
        // structured parsing; catalog lookup is skipped.
        publisher: "npm (global)",
        firstSeen: pathExists(pkgPath) ? fileFirstSeen(pkgPath) : "",
        sourceRefs: [`npm:${name}`],
        identified: true,
      })
    );
  }
  return { source: "npm", found: true, components };
}
