import * as path from "path";
import { Component, SourceResult } from "../types";
import { safeExec, pathExists, fileFirstSeen } from "../util";
import { makeComponent } from "./base";

// Homebrew inventory.
//
// The build spec named `brew list --formula --json=v2` / `brew list --cask
// --json=v2`, but current Homebrew does not accept `--json` on `brew list`.
// `brew info --json=v2 --installed` returns the same installed set (formulae and
// casks) in one structured call, so we use that and transcribe its fields.
// (Ambiguity resolved per the spec's guidance; noted here.)

function brewPrefix(): string | null {
  const res = safeExec("brew", ["--prefix"]);
  return res.ok ? res.stdout.trim() : null;
}

interface BrewInfoV2 {
  formulae?: any[];
  casks?: any[];
}

export function collectHomebrew(): SourceResult {
  const res = safeExec("brew", ["info", "--json=v2", "--installed"]);
  if (!res.ok || !res.stdout.trim()) {
    return { source: "brew", found: false, components: [] };
  }

  let data: BrewInfoV2;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return { source: "brew", found: false, components: [] };
  }

  const prefix = brewPrefix() || "/opt/homebrew";
  const components: Component[] = [];

  for (const f of data.formulae ?? []) {
    const name: string = f.full_name || f.name;
    if (!name) continue;
    const version: string | undefined =
      f?.installed?.[0]?.version || f?.versions?.stable || undefined;
    // Canonical install location for a formula's current version.
    const optPath = path.join(prefix, "opt", f.name || name);
    const linkPath = pathExists(optPath) ? optPath : optPath; // opt link is canonical even if bin varies
    components.push(
      makeComponent({
        name,
        installMethod: "brew",
        path: linkPath,
        version,
        // The tap is the publishing source; recording it both documents
        // provenance and marks the component as identified via structured
        // parsing (no catalog needed).
        publisher: f.tap ? `homebrew tap ${f.tap}` : "homebrew",
        firstSeen: pathExists(optPath) ? fileFirstSeen(optPath) : "",
        sourceRefs: [`brew:formula:${name}`],
        identified: true,
      })
    );
  }

  for (const c of data.casks ?? []) {
    const token: string = c.token || c.full_token;
    if (!token) continue;
    const name: string =
      (Array.isArray(c.name) ? c.name[0] : c.name) || token;
    const version: string | undefined = c.installed || c.version || undefined;
    components.push(
      makeComponent({
        name,
        installMethod: "brew",
        path: path.join(prefix, "Caskroom", token),
        version,
        publisher: c.tap ? `homebrew tap ${c.tap}` : "homebrew (cask)",
        bundleId: undefined,
        firstSeen: fileFirstSeen(path.join(prefix, "Caskroom", token)),
        sourceRefs: [`brew:cask:${token}`],
        identified: true,
      })
    );
  }

  return { source: "brew", found: true, components };
}
